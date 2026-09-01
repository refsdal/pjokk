package db

import (
	"embed"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// migrationsFS embeds the goose migration files into the binary, so the
// container image needs no separate copy step for SQL files (unlike the
// Bun predecessor, which resolved MIGRATIONS_DIR against the working
// directory — see apps/server/src/migrate.ts).
//
//go:embed migrations/*.sql
var migrationsFS embed.FS

// LatestMigrationVersion is the highest migration version embedded above,
// derived from the filenames rather than hand-maintained. Callers that need
// to know whether a database is up to date (internal/testrig's probe) compare
// it against goose_db_version: probing for a specific table would only ever
// answer "migration 1 ran", which silently goes stale the moment a second
// migration is added.
func LatestMigrationVersion() (int64, error) {
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return 0, fmt.Errorf("db: read embedded migrations: %w", err)
	}

	var latest int64
	for _, entry := range entries {
		version, _, ok := strings.Cut(entry.Name(), "_")
		if !ok {
			continue
		}
		n, err := strconv.ParseInt(version, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("db: migration %q has no numeric version prefix", entry.Name())
		}
		if n > latest {
			latest = n
		}
	}
	if latest == 0 {
		return 0, errors.New("db: no embedded migrations found")
	}
	return latest, nil
}
