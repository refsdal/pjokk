package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/refsdal/pjokk/server/internal/db/gen"
)

// TombstoneID is the fixed id of the tombstone user: the target FKs are
// repointed to when the real account behind them is deleted. Matches the row
// the migration seeds in 00001_init.sql.
const TombstoneID = "user_tombstone"

// New opens a pgx connection pool against databaseURL. Unlike ApplyMigrations
// (which pins to a single physical connection so pg_advisory_lock's
// per-session semantics hold), this pool is a normal multi-connection pool
// for ordinary request traffic.
func New(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("db: open pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("db: ping: %w", err)
	}
	return pool, nil
}

// EnsureTombstone re-inserts the tombstone user with ON CONFLICT DO NOTHING,
// a belt-and-braces guard alongside the migration's own seed row (REF §A2):
// safe to call on every boot.
func EnsureTombstone(ctx context.Context, pool *pgxpool.Pool) error {
	if err := gen.New(pool).UpsertTombstone(ctx, TombstoneID); err != nil {
		return fmt.Errorf("db: ensure tombstone: %w", err)
	}
	return nil
}

// IsUniqueViolation reports whether err is a Postgres unique-constraint
// violation (SQLSTATE 23505), per CLAUDE.md: detect by code, never by
// matching error text.
func IsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	return false
}

// IsForeignKeyViolation reports whether err is a Postgres foreign-key
// violation (SQLSTATE 23503) — same detect-by-code discipline as
// IsUniqueViolation. internal/jobs' purgeOrphanUsers uses this to swallow a
// delete blocked by historical data (e.g. a log row the user's account is
// still attributed to) without treating it as a job failure.
func IsForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23503"
	}
	return false
}
