package db

import "embed"

// migrationsFS embeds the goose migration files into the binary, so the
// container image needs no separate copy step for SQL files (unlike the
// Bun predecessor, which resolved MIGRATIONS_DIR against the working
// directory — see apps/server/src/migrate.ts).
//
//go:embed migrations/*.sql
var migrationsFS embed.FS
