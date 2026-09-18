package db

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// adminURL is the suite's Postgres (the same default and override the
// test rig uses); each test below gets an EMPTY database of its own beside
// it, so the migrator is exercised from nothing and the tests can run in
// parallel. Made by hand: package db cannot import testrig, which imports
// db.
func adminURL() string {
	if url := os.Getenv("TEST_DATABASE_URL"); url != "" {
		return url
	}
	return "postgres://pjokk:pjokk@127.0.0.1:55432/pjokk_test"
}

var freshSeq atomic.Int64

func freshDatabaseURL(t *testing.T) string {
	t.Helper()
	admin, err := sql.Open("pgx", adminURL())
	if err != nil {
		t.Fatalf("open admin connection: %v", err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	name := fmt.Sprintf("pjokk_m_%d_%d", os.Getpid(), freshSeq.Add(1))
	if _, err := admin.Exec(`CREATE DATABASE "` + name + `"`); err != nil {
		t.Fatalf("create database: %v", err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(`DROP DATABASE IF EXISTS "` + name + `" WITH (FORCE)`) })
	u, err := url.Parse(adminURL())
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	return u.String()
}

func TestApplyMigrations_CreatesSchema(t *testing.T) {
	t.Parallel()
	url := freshDatabaseURL(t)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := ApplyMigrations(ctx, url); err != nil {
		t.Fatalf("ApplyMigrations: %v", err)
	}

	conn, err := sql.Open("pgx", url)
	if err != nil {
		t.Fatalf("open verify connection: %v", err)
	}
	defer func() { _ = conn.Close() }()

	var regclass sql.NullString
	if err := conn.QueryRowContext(ctx, "select to_regclass('public.baby')").Scan(&regclass); err != nil {
		t.Fatalf("query to_regclass: %v", err)
	}
	if !regclass.Valid || regclass.String != "baby" {
		t.Fatalf("expected baby table to exist, got to_regclass=%v", regclass)
	}
}

func TestApplyMigrations_IsIdempotent(t *testing.T) {
	t.Parallel()
	url := freshDatabaseURL(t)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := ApplyMigrations(ctx, url); err != nil {
		t.Fatalf("first ApplyMigrations: %v", err)
	}
	if err := ApplyMigrations(ctx, url); err != nil {
		t.Fatalf("second ApplyMigrations should be a no-op, got error: %v", err)
	}
}

// TestApplyMigrations_BlocksOnAdvisoryLock proves the lock genuinely
// contends: a second, independent connection stands in for a sibling
// replica that won the race to migrate. ApplyMigrations must sit blocked
// acquiring the same advisory lock until that holder releases it — verified
// by polling pg_stat_activity for the waiting backend (Postgres's own
// bookkeeping) rather than guessing from a fixed sleep.
func TestApplyMigrations_BlocksOnAdvisoryLock(t *testing.T) {
	t.Parallel()
	url := freshDatabaseURL(t)

	// A dedicated single-connection holder, exactly like ApplyMigrations
	// itself uses, so pg_advisory_lock's per-session semantics apply here
	// too: the lock stays held on this one physical connection until we
	// explicitly unlock it below.
	holder, err := sql.Open("pgx", url)
	if err != nil {
		t.Fatalf("open holder connection: %v", err)
	}
	defer func() { _ = holder.Close() }()
	holder.SetMaxOpenConns(1)
	holder.SetMaxIdleConns(1)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	var locked bool
	if err := holder.QueryRowContext(ctx, "select pg_try_advisory_lock($1)", MigrationLockKey).Scan(&locked); err != nil {
		t.Fatalf("pg_try_advisory_lock: %v", err)
	}
	if !locked {
		t.Fatalf("expected holder to acquire the advisory lock")
	}

	migrationDone := make(chan error, 1)
	go func() {
		migrationDone <- ApplyMigrations(ctx, url)
	}()

	sawWaiter := false
	for attempt := 0; attempt < 50; attempt++ {
		var n int
		err := holder.QueryRowContext(ctx, `
			select count(*)::int
			from pg_stat_activity
			where wait_event_type = 'Lock'
			  and query ilike '%pg_advisory_lock%'
			  and pid <> pg_backend_pid()
		`).Scan(&n)
		if err != nil {
			t.Fatalf("poll pg_stat_activity: %v", err)
		}
		if n > 0 {
			sawWaiter = true
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	if !sawWaiter {
		t.Fatalf("expected to observe ApplyMigrations blocked waiting on the advisory lock")
	}

	if _, err := holder.ExecContext(ctx, "select pg_advisory_unlock($1)", MigrationLockKey); err != nil {
		t.Fatalf("pg_advisory_unlock: %v", err)
	}

	select {
	case err := <-migrationDone:
		if err != nil {
			t.Fatalf("ApplyMigrations (blocked): %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("ApplyMigrations did not complete after the lock was released")
	}
}

func TestApplyMigrations_ReturnsErrorRatherThanExiting(t *testing.T) {
	t.Parallel()
	// A syntactically valid connection string pointing at a database that
	// does not exist. If ApplyMigrations ever called os.Exit on failure
	// this would kill the test binary instead of failing the assertion —
	// this test guards against that regression too.
	badURL := "postgres://pjokk:pjokk@127.0.0.1:55432/pjokk_does_not_exist"

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := ApplyMigrations(ctx, badURL); err == nil {
		t.Fatalf("expected ApplyMigrations against a nonexistent database to return an error")
	}
}
