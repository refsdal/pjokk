package storage_test

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/storage"
)

// TestConformance runs the SAME behavioural suite against every in-process
// Storage implementation (fs, memory). s3 is covered by a compose smoke test
// instead of here — it needs a real S3-compatible service, which this suite
// deliberately does not require.
func TestConformance(t *testing.T) {
	t.Run("memory", func(t *testing.T) {
		runConformance(t, func(t *testing.T) storage.Storage {
			return storage.NewMemory()
		})
	})
	t.Run("fs", func(t *testing.T) {
		runConformance(t, func(t *testing.T) storage.Storage {
			s, err := storage.NewFS(t.TempDir())
			if err != nil {
				t.Fatalf("NewFS: %v", err)
			}
			return s
		})
	})
}

func runConformance(t *testing.T, newStorage func(t *testing.T) storage.Storage) {
	t.Helper()
	ctx := context.Background()

	t.Run("Put then GetStream returns the body and reports found", func(t *testing.T) {
		s := newStorage(t)
		body := []byte("hello world")
		if err := s.Put(ctx, "docs/hello.txt", bytes.NewReader(body), int64(len(body)), "text/plain"); err != nil {
			t.Fatalf("Put: %v", err)
		}

		rc, found, err := s.GetStream(ctx, "docs/hello.txt")
		if err != nil {
			t.Fatalf("GetStream: %v", err)
		}
		if !found {
			t.Fatalf("found = false, want true")
		}
		defer rc.Close()

		got, err := io.ReadAll(rc)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		if !bytes.Equal(got, body) {
			t.Errorf("body = %q, want %q", got, body)
		}
	})

	t.Run("GetStream on a missing key reports not-found without an error", func(t *testing.T) {
		s := newStorage(t)
		rc, found, err := s.GetStream(ctx, "does/not/exist.txt")
		if err != nil {
			t.Fatalf("GetStream: %v, want a nil error for a plain miss", err)
		}
		if found {
			t.Errorf("found = true, want false")
		}
		if rc != nil {
			t.Errorf("rc = %v, want nil", rc)
			rc.Close()
		}
	})

	t.Run("Delete removes multiple keys and is a no-op for ones that never existed", func(t *testing.T) {
		s := newStorage(t)
		for _, key := range []string{"a.txt", "b.txt"} {
			if err := s.Put(ctx, key, bytes.NewReader([]byte("x")), 1, ""); err != nil {
				t.Fatalf("Put %q: %v", key, err)
			}
		}

		if err := s.Delete(ctx, "a.txt", "b.txt", "never-existed.txt"); err != nil {
			t.Fatalf("Delete: %v", err)
		}

		for _, key := range []string{"a.txt", "b.txt"} {
			_, found, err := s.GetStream(ctx, key)
			if err != nil {
				t.Fatalf("GetStream(%q) after delete: %v", key, err)
			}
			if found {
				t.Errorf("%q still found after Delete", key)
			}
		}
	})

	t.Run("List returns only keys under the prefix with a recent UploadedAt", func(t *testing.T) {
		s := newStorage(t)
		before := time.Now().Add(-2 * time.Second)

		for _, key := range []string{
			"backups/2026-08-01.json",
			"backups/2026-08-02.json",
			"other/file.json",
		} {
			if err := s.Put(ctx, key, bytes.NewReader([]byte("{}")), 2, "application/json"); err != nil {
				t.Fatalf("Put %q: %v", key, err)
			}
		}

		objs, err := s.List(ctx, "backups/")
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		if len(objs) != 2 {
			t.Fatalf("List returned %d objects, want 2: %+v", len(objs), objs)
		}

		gotKeys := map[string]bool{}
		for _, o := range objs {
			gotKeys[o.Key] = true
			if o.UploadedAt.Before(before) {
				t.Errorf("UploadedAt %v predates the Put, want it recent", o.UploadedAt)
			}
		}
		if !gotKeys["backups/2026-08-01.json"] || !gotKeys["backups/2026-08-02.json"] {
			t.Errorf("List keys = %v, want both backups/ files and nothing else", objs)
		}
	})

	t.Run("List with an empty prefix returns every object", func(t *testing.T) {
		s := newStorage(t)
		for _, key := range []string{"one.txt", "dir/two.txt"} {
			if err := s.Put(ctx, key, bytes.NewReader([]byte("x")), 1, ""); err != nil {
				t.Fatalf("Put %q: %v", key, err)
			}
		}
		objs, err := s.List(ctx, "")
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		if len(objs) != 2 {
			t.Fatalf("List(\"\") returned %d objects, want 2: %+v", len(objs), objs)
		}
	})
}

// --- fs-specific behaviour: crash-safety, nested keys, construction
// failures, and key sanitisation don't apply to the in-memory driver, so
// they live outside the shared conformance suite. ---

func TestFSNestedKeysCreateSubdirectories(t *testing.T) {
	root := t.TempDir()
	s, err := storage.NewFS(root)
	if err != nil {
		t.Fatalf("NewFS: %v", err)
	}
	ctx := context.Background()

	body := []byte("nested")
	if err := s.Put(ctx, "a/b/c/file.txt", bytes.NewReader(body), int64(len(body)), ""); err != nil {
		t.Fatalf("Put: %v", err)
	}

	rc, found, err := s.GetStream(ctx, "a/b/c/file.txt")
	if err != nil {
		t.Fatalf("GetStream: %v", err)
	}
	if !found {
		t.Fatalf("found = false, want true")
	}
	defer rc.Close()
	got, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Errorf("body = %q, want %q", got, body)
	}

	if _, err := os.Stat(filepath.Join(root, "a", "b", "c", "file.txt")); err != nil {
		t.Errorf("expected the nested file on disk: %v", err)
	}
}

// TestFSPutLeavesNoPartialFileVisible is the crash-safety test: a large
// write's temp file must never be left behind once Put returns, and the
// final file must be complete — not truncated — which is what the
// temp-file-then-os.Rename pattern guarantees (a reader either sees the old
// content or the whole new content, never a partial write).
func TestFSPutLeavesNoPartialFileVisible(t *testing.T) {
	root := t.TempDir()
	s, err := storage.NewFS(root)
	if err != nil {
		t.Fatalf("NewFS: %v", err)
	}
	ctx := context.Background()

	body := bytes.Repeat([]byte("pjokk"), 1024*1024) // 5 MiB
	if err := s.Put(ctx, "big.bin", bytes.NewReader(body), int64(len(body)), ""); err != nil {
		t.Fatalf("Put: %v", err)
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".pjokk-tmp-") {
			t.Errorf("temp file %q left behind after Put returned", e.Name())
		}
	}

	got, err := os.ReadFile(filepath.Join(root, "big.bin"))
	if err != nil {
		t.Fatalf("read final file: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Errorf("final file is %d bytes, want %d — a partial write is visible", len(got), len(body))
	}
}

func TestFSUnwritableRootErrorsAtConstruction(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: permission bits don't block writes")
	}
	root := t.TempDir()
	if err := os.Chmod(root, 0o500); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	defer os.Chmod(root, 0o700)

	if _, err := storage.NewFS(root); err == nil {
		t.Error("NewFS on an unwritable root: got nil error, want one")
	}
}

func TestFSMissingRootErrorsAtConstruction(t *testing.T) {
	root := filepath.Join(t.TempDir(), "does-not-exist")
	if _, err := storage.NewFS(root); err == nil {
		t.Error("NewFS on a missing root: got nil error, want one")
	}
}

func TestFSRejectsTraversalKeys(t *testing.T) {
	root := t.TempDir()
	s, err := storage.NewFS(root)
	if err != nil {
		t.Fatalf("NewFS: %v", err)
	}
	ctx := context.Background()

	for _, key := range []string{
		"..",
		"../escape.txt",
		"a/../../escape.txt",
		"/etc/passwd",
	} {
		if err := s.Put(ctx, key, bytes.NewReader([]byte("x")), 1, ""); err == nil {
			t.Errorf("Put(%q): got nil error, want a traversal rejection", key)
		}
	}
}

func TestMemoryReadAndClear(t *testing.T) {
	m := storage.NewMemory()
	ctx := context.Background()

	if err := m.Put(ctx, "k", bytes.NewReader([]byte("v")), 1, ""); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, ok := m.Read("k")
	if !ok || string(got) != "v" {
		t.Errorf("Read(%q) = (%q, %v), want (\"v\", true)", "k", got, ok)
	}

	m.Clear()
	if _, ok := m.Read("k"); ok {
		t.Error("Read after Clear still found the key")
	}
}
