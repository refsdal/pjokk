// In-memory Storage for tests, mirroring apps/api/test/memory-storage.ts:
// implementing the four-method port honestly is cheaper than either
// standing up a real S3-compatible service in the test suite or hand-waving
// a fake, and the real driver's behaviour is exercised separately (fs's
// conformance run in this package, s3 by the compose smoke test).
package storage

import (
	"bytes"
	"context"
	"io"
	"sort"
	"strings"
	"sync"
	"time"
)

type memoryObject struct {
	body       []byte
	uploadedAt time.Time
}

// Memory is a map-backed Storage. The zero value is not usable; construct
// with NewMemory.
type Memory struct {
	mu      sync.Mutex
	objects map[string]memoryObject
}

var _ Storage = (*Memory)(nil)

// NewMemory builds an empty in-memory Storage.
func NewMemory() *Memory {
	return &Memory{objects: make(map[string]memoryObject)}
}

func (m *Memory) Put(ctx context.Context, key string, body io.Reader, size int64, contentType string) error {
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.objects[key] = memoryObject{body: data, uploadedAt: time.Now()}
	return nil
}

func (m *Memory) GetStream(ctx context.Context, key string) (io.ReadCloser, bool, error) {
	m.mu.Lock()
	obj, ok := m.objects[key]
	m.mu.Unlock()
	if !ok {
		return nil, false, nil
	}
	return io.NopCloser(bytes.NewReader(obj.body)), true, nil
}

func (m *Memory) Delete(ctx context.Context, keys ...string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, key := range keys {
		delete(m.objects, key)
	}
	return nil
}

func (m *Memory) List(ctx context.Context, prefix string) ([]StoredObject, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []StoredObject
	for key, obj := range m.objects {
		if strings.HasPrefix(key, prefix) {
			out = append(out, StoredObject{Key: key, UploadedAt: obj.uploadedAt})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

// Read is test-only: the raw bytes behind a key, or (nil, false) if absent.
// Mirrors memory-storage.ts's read().
func (m *Memory) Read(key string) ([]byte, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	obj, ok := m.objects[key]
	if !ok {
		return nil, false
	}
	out := make([]byte, len(obj.body))
	copy(out, obj.body)
	return out, true
}

// Clear is test-only: forget everything. Mirrors memory-storage.ts's
// clear(), called between test files there; Go tests instead get a fresh
// Memory per test via NewMemory, but Clear stays available for a test that
// wants to reuse one instance across subtests.
func (m *Memory) Clear() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.objects = make(map[string]memoryObject)
}
