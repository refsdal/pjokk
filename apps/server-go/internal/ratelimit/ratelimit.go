// Package ratelimit declares the counter-store port backing Pjokk's
// Postgres-based rate limiting (the `rate_limit` table, CLAUDE.md). This file
// holds ONLY the interface — the real implementation (Task 6/7) lives
// alongside it once it lands. Declaring the port now lets api.Deps reference
// ratelimit.Store without waiting on that task.
//
// See docs/superpowers/plans/2026-08-31-go-migration-reference.md §A6, where
// this is named RateLimitStore; the package name here already carries
// "ratelimit", so the exported type is just Store.
package ratelimit

import (
	"context"
	"time"
)

// Store is the rate-limit counter port.
type Store interface {
	// Hit increments the counter for key within a sliding window of
	// windowSeconds and returns the count after incrementing.
	Hit(ctx context.Context, key string, windowSeconds int) (int, error)
	// Sweep deletes expired counters as of now, returning how many were
	// removed.
	Sweep(ctx context.Context, now time.Time) (int, error)
}
