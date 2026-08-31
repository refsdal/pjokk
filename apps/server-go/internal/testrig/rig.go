// Package testrig gives every internal/db (and later internal/api) test a
// real, isolated Postgres to run against — per CLAUDE.md's "the database is
// the thing most likely to differ, so faking it defeats the purpose" rule.
//
// Migrations run once per test binary (sync.Once); each individual test then
// gets a clean slate via a dynamic TRUNCATE of every public table (except
// goose_db_version) before it starts, so unrelated tests never see each
// other's rows. Because that truncation is process-wide state, tests using
// this rig must run serially: `go test -p 1 ./...`.
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

var (
	migrateOnce sync.Once
	migrateErr  error
)

// Rig bundles the shared pool and a ready-to-use Querier for a single test.
type Rig struct {
	Pool *pgxpool.Pool
	Q    *gen.Queries
}

// Setup applies migrations once per test binary, truncates every domain
// table so the test starts from an empty database, opens a pool for this
// test, and registers cleanup to close it when the test ends.
func Setup(t *testing.T) *Rig {
	t.Helper()

	url := DatabaseURL()

	migrateOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		migrateErr = db.ApplyMigrations(ctx, url)
	})
	if migrateErr != nil {
		t.Fatalf("testrig: apply migrations: %v", migrateErr)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("testrig: open pool: %v", err)
	}
	t.Cleanup(pool.Close)

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
