// Package storage declares the object-storage port every S3-compatible
// backend (MinIO in compose; S3/R2/Ceph in production) implements. This file
// holds ONLY the interface and its supporting type — the real implementation
// (Task 6) lives alongside it once it lands. Declaring the port now lets
// api.Deps reference storage.Storage without waiting on that task.
//
// See docs/superpowers/plans/2026-08-31-go-migration-reference.md §A6.
package storage

import (
	"context"
	"io"
	"time"
)

// StoredObject describes one object returned by List.
type StoredObject struct {
	Key        string
	UploadedAt time.Time
}

// Storage is the object-storage port. Every method takes a context and never
// exposes a bucket URL or credential to a caller — files are always streamed
// back through an authed route (CLAUDE.md: never a public bucket).
type Storage interface {
	Put(ctx context.Context, key string, body io.Reader, size int64, contentType string) error
	// GetStream reports (rc, found, err): found is false with a nil error
	// when the key simply does not exist, so callers can return a 404
	// without treating a miss as a failure.
	GetStream(ctx context.Context, key string) (rc io.ReadCloser, found bool, err error)
	Delete(ctx context.Context, keys ...string) error
	List(ctx context.Context, prefix string) ([]StoredObject, error)
}
