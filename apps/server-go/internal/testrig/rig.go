// Package testrig gives every internal/db (and later internal/api) test a
// real, isolated Postgres to run against — per CLAUDE.md's "the database is
// the thing most likely to differ, so faking it defeats the purpose" rule.
//
// Every Setup probes for the migrated schema and (re)applies migrations when
// it is missing — deliberately NOT a sync.Once: other tests in the same
// binary (migrate_test.go) drop and rebuild the public schema, and nothing
// in the Go toolchain guarantees which test file runs first. The probe makes
// rig correctness independent of test ordering. Each individual test then
// gets a clean slate via a dynamic TRUNCATE of every public table (except
// goose_db_version) before it starts, so unrelated tests never see each
// other's rows. Because truncation is process-wide state, tests using this
// rig must run serially: `go test -p 1 ./...`.
package testrig

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/refsdal/pjokk/server/internal/db"
	"github.com/refsdal/pjokk/server/internal/db/gen"
)

// DatabaseURL mirrors internal/db's own testDatabaseURL default: the local
// docker-compose test Postgres, overridable for CI.
func DatabaseURL() string {
	if url := os.Getenv("TEST_DATABASE_URL"); url != "" {
		return url
	}
	return "postgres://pjokk:pjokk@127.0.0.1:55432/pjokk_test"
}

// migrateMu serializes the probe-then-migrate step so parallel Setups can't
// race each other into duplicate goose runs (ApplyMigrations' advisory lock
// would serialize them anyway; the mutex just keeps the probe cheap and the
// logs quiet).
var migrateMu sync.Mutex

// Rig bundles the shared pool and a ready-to-use Querier for a single test.
type Rig struct {
	Pool *pgxpool.Pool
	Q    *gen.Queries
}

// Setup makes sure the schema is migrated (probing per call — see the
// package comment for why this must not be a sync.Once), truncates every
// domain table so the test starts from an empty database, opens a pool for
// this test, and registers cleanup to close it when the test ends.
func Setup(t *testing.T) *Rig {
	t.Helper()

	url := DatabaseURL()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("testrig: open pool: %v", err)
	}
	t.Cleanup(pool.Close)

	if err := ensureMigrated(ctx, url, pool); err != nil {
		t.Fatalf("testrig: apply migrations: %v", err)
	}

	if err := truncateAll(ctx, pool); err != nil {
		t.Fatalf("testrig: truncate: %v", err)
	}

	if err := db.EnsureTombstone(ctx, pool); err != nil {
		t.Fatalf("testrig: ensure tombstone: %v", err)
	}

	return &Rig{
		Pool: pool,
		Q:    gen.New(pool),
	}
}

// ensureMigrated probes for the migrated schema and applies migrations when
// it is absent. The probe runs on every Setup call — cheap (one catalog
// lookup) and, unlike a once-per-binary guard, immune to another test in the
// same binary dropping the schema after we migrated it. `baby` stands in for
// "the whole schema": it is created by the same single migration as every
// other table, so it is either all there or none of it is.
func ensureMigrated(ctx context.Context, url string, pool *pgxpool.Pool) error {
	migrateMu.Lock()
	defer migrateMu.Unlock()

	var reg *string
	if err := pool.QueryRow(ctx, `SELECT to_regclass('public.baby')::text`).Scan(&reg); err != nil {
		return fmt.Errorf("testrig: probe schema: %w", err)
	}
	if reg != nil {
		return nil
	}
	return db.ApplyMigrations(ctx, url)
}

// truncateAll empties every table in the public schema except
// goose_db_version, so goose still considers the schema migrated and no
// individual test needs to know the full table list by hand.
func truncateAll(ctx context.Context, pool *pgxpool.Pool) error {
	rows, err := pool.Query(ctx, `
		SELECT tablename FROM pg_tables
		WHERE schemaname = 'public' AND tablename <> 'goose_db_version'
	`)
	if err != nil {
		return fmt.Errorf("testrig: list tables: %w", err)
	}
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return fmt.Errorf("testrig: scan table name: %w", err)
		}
		tables = append(tables, name)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("testrig: list tables: %w", err)
	}
	if len(tables) == 0 {
		return nil
	}

	stmt := `TRUNCATE TABLE `
	for i, table := range tables {
		if i > 0 {
			stmt += `, `
		}
		stmt += fmt.Sprintf(`"%s"`, table)
	}
	stmt += ` RESTART IDENTITY CASCADE`

	if _, err := pool.Exec(ctx, stmt); err != nil {
		return fmt.Errorf("testrig: truncate tables: %w", err)
	}
	return nil
}
