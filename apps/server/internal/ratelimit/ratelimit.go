// Package ratelimit holds Pjokk's rate-limit counter store (the `rate_limit`
// table, CLAUDE.md) and the client-address resolution the buckets are keyed
// on.
//
// See docs/superpowers/plans/2026-08-31-go-migration-reference.md §A5 items
// 7-8 and §A6, where the port is named RateLimitStore; the package name here
// already carries "ratelimit", so the exported type is just Store.
//
// The counters used to live in Cloudflare KV, which was eventually consistent:
// the old limiter read a value, compared it and wrote it back, a race its own
// comment accepted as "a brake, not an invariant". Postgres removes the
// compromise — one statement increments and returns the new value atomically,
// so the limit holds even when several replicas serve the same caller at once.
package ratelimit

import (
	"context"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/db/gen"
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

// Postgres is the shipped Store: one row per (limiter, bucket, window) in the
// `rate_limit` table.
type Postgres struct {
	q *gen.Queries
}

var _ Store = (*Postgres)(nil)

// NewPostgres builds the store over an existing querier, so it shares the one
// pool the composition root opened.
func NewPostgres(q *gen.Queries) *Postgres { return &Postgres{q: q} }

// Hit increments the counter for key and returns the new count.
//
// The row's expiry is kept generous — at least a minute, otherwise twice the
// window — so a clock skew between replicas cannot resurrect a bucket that
// should already have expired. Nothing reads expires_at to decide whether a
// bucket counts: the window number is part of the key, and the expiry exists
// only so Sweep has something to prune by.
func (p *Postgres) Hit(ctx context.Context, key string, windowSeconds int) (int, error) {
	ttl := windowSeconds * 2
	if ttl < 60 {
		ttl = 60
	}
	count, err := p.q.HitRateLimit(ctx, gen.HitRateLimitParams{
		Key:       key,
		ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Duration(ttl) * time.Second), Valid: true},
	})
	if err != nil {
		return 0, fmt.Errorf("ratelimit: hit %q: %w", key, err)
	}
	return int(count), nil
}

// Sweep deletes every counter that expired before now.
func (p *Postgres) Sweep(ctx context.Context, now time.Time) (int, error) {
	removed, err := p.q.SweepRateLimit(ctx, pgtype.Timestamptz{Time: now, Valid: true})
	if err != nil {
		return 0, fmt.Errorf("ratelimit: sweep: %w", err)
	}
	return int(removed), nil
}

// ClientIP is the client's address, as far as it can be trusted (REF §A5
// item 7).
//
// On Workers this was simply cf-connecting-ip, which Cloudflare set and a
// caller could not forge. There is no such header off Cloudflare, and
// X-Forwarded-For is caller-supplied: trusting it blindly would let anyone
// mint a fresh rate-limit bucket per request and walk straight through the
// brake.
//
// So the header is only consulted when the operator has declared how many
// proxies sit in front (TRUSTED_PROXY_HOPS), and the address is counted from
// the RIGHT — the last entry a trusted proxy actually observed. Anything a
// client prepends sits further left and is ignored. With 0 hops (the default)
// the header is not read at all.
//
// Divergence from the TypeScript original: there, socketAddress came from
// Bun's `server.requestIP().address`, which is a bare IP. In Go the socket
// address arrives as net/http's r.RemoteAddr, which carries a port — and a
// port would put every single connection in its own bucket, quietly disabling
// the limiter. The port is therefore stripped here.
func ClientIP(forwardedFor string, socketAddress string, trustedHops int) string {
	socket := stripPort(socketAddress)

	if trustedHops <= 0 {
		return orUnknown(socket)
	}

	chain := make([]string, 0, 4)
	for _, part := range strings.Split(forwardedFor, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			chain = append(chain, trimmed)
		}
	}
	if len(chain) == 0 {
		return orUnknown(socket)
	}

	// The rightmost entry was appended by the nearest proxy, so hop N back
	// from the end is the address the outermost trusted proxy saw.
	index := len(chain) - trustedHops
	if index < 0 {
		index = 0
	}
	return orUnknown(chain[index])
}

// stripPort removes a trailing port from an address, leaving IPv6 literals
// unbracketed. An address without a port is returned unchanged.
func stripPort(address string) string {
	if address == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(address); err == nil {
		return host
	}
	return address
}

func orUnknown(address string) string {
	if address == "" {
		return "unknown"
	}
	return address
}
