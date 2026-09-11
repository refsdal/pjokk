// Package storage declares the object-storage port every S3-compatible
// backend (MinIO in compose; S3/R2/Ceph in production) implements. This file
// holds the interface and its supporting type; the two drivers (S3 and a
// mounted volume) live alongside it.
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
	// Size in bytes — the console's backup list shows it (spec
	// 2026-09-11-admin-ops §3). Every driver already has it to hand.
	Size int64
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
