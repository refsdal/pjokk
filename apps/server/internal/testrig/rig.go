// Package testrig gives every database-backed test a real, isolated
// Postgres to run against — per CLAUDE.md's "the database is the thing
// most likely to differ, so faking it defeats the purpose" rule.
//
// Each test gets a DATABASE OF ITS OWN, cloned from a migrated template
// (CREATE DATABASE … TEMPLATE, tens of milliseconds) and dropped when the
// test ends. Tests are therefore independent by construction: t.Parallel
// is safe everywhere, and packages run side by side. This replaced one
// shared database truncated before every test, which forced the whole
// suite through `go test -p 1` and cost about six minutes; the same suite
// now takes about one (measured 2026-09-18: internal/api 332 s → 33 s).
//
// The template is named after a hash of the embedded migrations, so a
// schema change makes a new template and a stale one is dropped, and it
// is created once per Postgres under an advisory lock, because go test
// starts several package binaries at once. Two limits keep Postgres's
// connection cap in view: every pool is capped at four connections
// (pgxpool would otherwise open one per core), and at most dbParallel
// tests per process hold a database at a time.
package testrig

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/refsdal/pjokk/server/internal/db"
	"github.com/refsdal/pjokk/server/internal/db/gen"
)

// DatabaseURL is the Postgres the suite runs against: the local
// docker-compose test database, overridable for CI. It is the ADMIN
// database — templates and per-test databases are created beside it;
// nothing runs tests in it any more.
func DatabaseURL() string {
	if url := os.Getenv("TEST_DATABASE_URL"); url != "" {
		return url
	}
	return "postgres://pjokk:pjokk@127.0.0.1:55432/pjokk_test"
}

// Rig is one test's own database: a pool, a Querier, and the URL for
// anything that connects by URL (a CLI under test, a migration).
type Rig struct {
	Pool *pgxpool.Pool
	Q    *gen.Queries
	URL  string
}

const (
	// One session-level advisory lock, shared by every test binary,
	// around creating the template.
	templateLockKey = 7331
	poolMaxConns    = "4"
)

var (
	adminOnce sync.Once
	adminErr  error
	admin     *pgxpool.Pool
	template  string
	seq       atomic.Int64
	slots     chan struct{}
)

// dbParallel is how many tests in one process may hold a database at
// once. Beyond about sixteen the suite gains nothing (the floor is per-test
// setup, not CPU), and every slot is up to four connections against a
// Postgres that allows a few hundred. TEST_DB_PARALLEL overrides it.
func dbParallel() int {
	if v, err := strconv.Atoi(os.Getenv("TEST_DB_PARALLEL")); err == nil && v > 0 {
		return v
	}
	return 8
}

// withDatabase points the admin URL at another database on the same
// server. Pooled URLs cap the pool; a plain URL is for database/sql (the
// migrator), which rejects pool options.
func withDatabase(base, name string, pooled bool) string {
	u, err := url.Parse(base)
	if err != nil {
		return base
	}
	u.Path = "/" + name
	q := u.Query()
	if pooled {
		q.Set("pool_max_conns", poolMaxConns)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// prepare opens the admin pool and makes sure the template for THIS
// build's migrations exists, once per process and once per Postgres.
func prepare(ctx context.Context) error {
	pool, err := db.New(ctx, withDatabase(DatabaseURL(), databaseName(DatabaseURL()), true))
	if err != nil {
		return fmt.Errorf("testrig: open admin pool: %w", err)
	}
	admin = pool
	slots = make(chan struct{}, dbParallel())

	fp, err := db.MigrationsFingerprint()
	if err != nil {
		return err
	}
	template = "pjokk_tmpl_" + fp

	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, templateLockKey); err != nil {
		return fmt.Errorf("testrig: template lock: %w", err)
	}
	defer func() { _, _ = conn.Exec(ctx, `SELECT pg_advisory_unlock($1)`, templateLockKey) }()

	// A template from another build is dead weight: drop it while we hold
	// the lock and nobody can be cloning it.
	rows, err := conn.Query(ctx, `SELECT datname FROM pg_database WHERE datname LIKE 'pjokk_tmpl_%' AND datname <> $1`, template)
	if err != nil {
		return err
	}
	var stale []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		stale = append(stale, name)
	}
	rows.Close()
	for _, name := range stale {
		if _, err := conn.Exec(ctx, `DROP DATABASE IF EXISTS "`+name+`" WITH (FORCE)`); err != nil {
			return fmt.Errorf("testrig: drop stale template %s: %w", name, err)
		}
	}

	var exists bool
	if err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, template).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	if _, err := conn.Exec(ctx, `CREATE DATABASE "`+template+`"`); err != nil {
		return fmt.Errorf("testrig: create template: %w", err)
	}
	// ApplyMigrations opens and closes its own connection: a template must
	// have no sessions when it is cloned.
	if err := db.ApplyMigrations(ctx, withDatabase(DatabaseURL(), template, false)); err != nil {
		return fmt.Errorf("testrig: migrate template: %w", err)
	}
	return nil
}

func databaseName(base string) string {
	u, err := url.Parse(base)
	if err != nil || len(u.Path) < 2 {
		return "pjokk_test"
	}
	return u.Path[1:]
}

// Setup gives the test a migrated database of its own and a pool on it,
// both gone when the test ends. Safe from t.Parallel.
func Setup(t *testing.T) *Rig {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	adminOnce.Do(func() { adminErr = prepare(ctx) })
	if adminErr != nil {
		t.Fatalf("testrig: %v", adminErr)
	}
	name := fmt.Sprintf("pjokk_t_%d_%d", os.Getpid(), seq.Add(1))
	slots <- struct{}{}
	if _, err := admin.Exec(ctx, `CREATE DATABASE "`+name+`" TEMPLATE "`+template+`"`); err != nil {
		<-slots
		t.Fatalf("testrig: clone database: %v", err)
	}
	// The rig's own pool is capped; the URL handed out is plain, because a
	// CLI or migrator under test opens it with database/sql, which rejects
	// pool options.
	dsn := withDatabase(DatabaseURL(), name, false)
	pool, err := db.New(ctx, withDatabase(DatabaseURL(), name, true))
	if err != nil {
		<-slots
		t.Fatalf("testrig: open pool: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(context.Background(), `DROP DATABASE IF EXISTS "`+name+`" WITH (FORCE)`)
		<-slots
	})
	if err := db.EnsureTombstone(ctx, pool); err != nil {
		t.Fatalf("testrig: ensure tombstone: %v", err)
	}
	return &Rig{Pool: pool, Q: gen.New(pool), URL: dsn}
}

// Empty truncates every table in THIS test's database except
// goose_db_version and reseeds the tombstone: "an empty, migrated
// database", for a test that backs up, empties and restores. It touches
// nobody else's database.
func (r *Rig) Empty(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	rows, err := r.Pool.Query(ctx, `
		SELECT tablename FROM pg_tables
		WHERE schemaname = 'public' AND tablename <> 'goose_db_version'
	`)
	if err != nil {
		t.Fatalf("testrig: list tables: %v", err)
	}
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			t.Fatalf("testrig: scan table name: %v", err)
		}
		tables = append(tables, name)
	}
	rows.Close()
	if len(tables) > 0 {
		stmt := `TRUNCATE TABLE `
		for i, table := range tables {
			if i > 0 {
				stmt += `, `
			}
			stmt += `"` + table + `"`
		}
		stmt += ` RESTART IDENTITY CASCADE`
		if _, err := r.Pool.Exec(ctx, stmt); err != nil {
			t.Fatalf("testrig: truncate: %v", err)
		}
	}
	if err := db.EnsureTombstone(ctx, r.Pool); err != nil {
		t.Fatalf("testrig: ensure tombstone: %v", err)
	}
}

// FreshDatabaseURL is an EMPTY database — no schema at all — for a test
// of the migrator itself, dropped when the test ends.
func FreshDatabaseURL(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	adminOnce.Do(func() { adminErr = prepare(ctx) })
	if adminErr != nil {
		t.Fatalf("testrig: %v", adminErr)
	}
	name := fmt.Sprintf("pjokk_f_%d_%d", os.Getpid(), seq.Add(1))
	slots <- struct{}{}
	if _, err := admin.Exec(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
		<-slots
		t.Fatalf("testrig: create database: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), `DROP DATABASE IF EXISTS "`+name+`" WITH (FORCE)`)
		<-slots
	})
	return withDatabase(DatabaseURL(), name, false)
}
