// Package db owns Pjokk's schema migrations: the embedded goose migration
// files and the advisory-lock-guarded runner that applies them. This is the
// Go port of apps/server/src/migrate.ts — same lock key, same "serialise
// several replicas racing to migrate at boot" reasoning, same
// throw-don't-exit contract so callers (the default dispatch mode, the
// one-off `migrate` mode) can each decide what to do on failure.
package db

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"

	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" database/sql driver
	"github.com/pressly/goose/v3"
)

// MigrationLockKey is the fixed Postgres advisory-lock key used to
// serialise concurrent migrators (several containers booting at once, or
// the default dispatch mode racing an explicit one-off `migrate` job).
//
// MUST NEVER CHANGE. pg_advisory_lock contends by key: renumbering this
// later means an old and a new binary running side by side (mid-rollout)
// would use different keys, stop contending with each other, and the whole
// point of this lock — serialising concurrent migrators — silently stops
// working with no error anywhere.
//
// Matches apps/server/src/migrate.ts's MIGRATION_LOCK_KEY (7245_0001)
// exactly — do not let the two drift apart during the migration.
const MigrationLockKey int64 = 72450001

// ApplyMigrations runs every pending goose migration under the advisory
// lock and returns an error rather than exiting the process, so it is safe
// to call both from the default dispatch mode (which continues on to start
// the server afterwards) and from a one-off `migrate` mode (whose thin
// wrapper owns the exit code).
//
// pg_advisory_lock is per-SESSION (i.e. per physical connection), so the
// lock acquisition, the migration itself, and the unlock must all run on
// the exact same connection. database/sql's *sql.DB is a connection pool
// that would otherwise be free to hand each statement a different physical
// connection — silently defeating the lock. To prevent that, the pool used
// here is pinned to a single connection (SetMaxOpenConns(1) +
// SetMaxIdleConns(1)): with only one physical connection ever open, every
// borrow-and-return from the lock, the migration, and the unlock resolves
// to that same connection, which is the same-session guarantee
// pg_advisory_lock needs. Verified in migrate_test.go by observing a
// second, independent connection genuinely block on pg_advisory_lock while
// this one holds it, using pg_stat_activity as ground truth rather than a
// fixed sleep.
func ApplyMigrations(ctx context.Context, databaseURL string) error {
	sqlDB, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return fmt.Errorf("db: open database: %w", err)
	}
	defer sqlDB.Close()

	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)

	if _, err := sqlDB.ExecContext(ctx, "select pg_advisory_lock($1)", MigrationLockKey); err != nil {
		return fmt.Errorf("db: acquire advisory lock: %w", err)
	}
	defer func() {
		_, _ = sqlDB.ExecContext(ctx, "select pg_advisory_unlock($1)", MigrationLockKey)
	}()

	migrationsDir, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		return fmt.Errorf("db: resolve embedded migrations dir: %w", err)
	}

	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrationsDir)
	if err != nil {
		return fmt.Errorf("db: create goose provider: %w", err)
	}

	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("db: apply migrations: %w", err)
	}

	return nil
}
