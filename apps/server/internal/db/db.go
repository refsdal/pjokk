package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
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
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("db: parse url: %w", err)
	}
	// pgx 5.12 returns timestamptz in time.Local when it reads the text
	// format (it used to keep the server's offset), so every timestamp the
	// API marshals would carry the HOST's zone. The image sets no TZ, which
	// hides it in production and shows it on a developer's laptop. Pin the
	// location: the wire format is UTC, as it always was.
	cfg.AfterConnect = func(_ context.Context, conn *pgx.Conn) error {
		if c, ok := conn.TypeMap().TypeForOID(pgtype.TimestamptzOID); ok {
			if codec, ok := c.Codec.(*pgtype.TimestamptzCodec); ok {
				codec.ScanLocation = time.UTC
			}
		}
		return nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
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
// a belt-and-braces guard alongside the migration's own seed row:
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
