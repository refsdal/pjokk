package jobs

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

// BackupTables is the Go port of apps/api/src/jobs/backup.ts's BACKUP_TABLES:
// an ordered, hard-coded list of every table the nightly snapshot dumps.
// Adapted to the Go schema (REF §A7): better-auth's `user`/`session`/
// `account`/`verification`/`organization`/`member`/`invitation` become
// Limen's `users`/`sessions`/`accounts`/`verifications`/`organizations`/
// `organization_members`/`organization_invitations`; `organization_roles`
// (Limen's custom-roles catalogue) does not exist in the live schema —
// 00002_limen_align.sql drops it, since Pjokk only ever uses the built-in
// admin/member roles — so it is NOT listed, and `organization_member_roles`
// (Limen's actual role-assignment table, recreated in that same migration)
// and `impersonation` (00003_impersonation.sql, server-only bookkeeping) are
// added in its place. `passkey` and `subscription` are gone entirely —
// billing and the passkey UI never shipped in this port (REF §A1).
//
// BackupTablesTest (backup_tables_test.go) asserts this list against the
// LIVE schema in both directions: every pg_tables row must be covered by
// this list or DeliberatelyExcluded, and no entry here may name a table
// that no longer exists.
var BackupTables = []string{
	// Auth (Limen-shaped).
	"users",
	"sessions",
	"accounts",
	"verifications",
	"organizations",
	"organization_members",
	"organization_member_roles",
	"organization_invitations",
	"impersonation",
	// Domain.
	"baby",
	"feed_log",
	"diaper_log",
	"sleep_log",
	"medicine_log",
	"bath_log",
	"note_log",
	"milestone_log",
	"measurement_log",
	"pump_log",
	"play_log",
	"vaccine_log",
	"vaccine_document",
	"vaccine_dismissal",
	"family_invite",
	"sleep_location",
	"contact",
	"contact_baby",
	"calendar_event",
	"calendar_event_baby",
	"calendar_assignee",
	"push_subscription",
	"push_pref",
	"api_key",
	"admin_audit",
}

// DeliberatelyExcluded names tables that exist in the live schema but are
// intentionally left out of BackupTables — a restore that resurrected these
// would be actively wrong, not merely incomplete:
//
//   - rate_limit: our own IP-hash rate limiter's fixed-window counters.
//     Ephemeral by design; restoring week-old counters would only confuse
//     the limiter.
//   - rate_limits: Limen's own rate limiter table, same reasoning.
//   - goose_db_version: migration bookkeeping, not application data.
var DeliberatelyExcluded = map[string]bool{
	"rate_limit":       true,
	"rate_limits":      true,
	"goose_db_version": true,
}

// backupRetentionDays is BACKUP_RETENTION_DAYS: backups hold every table,
// health data included, so keeping them forever would both breach storage
// limitation and quietly defeat erasure — a deleted family would live on in
// every older snapshot. Thirty days is the window the privacy policy commits
// to for a deletion to fully take effect.
const backupRetentionDays = 30

// backupKeyPattern matches the date a snapshot key was written under, e.g.
// "backups/2026-08-24.json" -> "2026-08-24".
var backupKeyPattern = regexp.MustCompile(`^backups/(\d{4}-\d{2}-\d{2})\.json$`)

// backupSnapshot is the JSON shape written to object storage:
// {exportedAt, tables: {name: rows[]}}, matching backup.ts's dump literal.
type backupSnapshot struct {
	ExportedAt string                      `json:"exportedAt"`
	Tables     map[string][]map[string]any `json:"tables"`
}

// RunBackup dumps every table in BackupTables to a single dated JSON
// snapshot in object storage and returns the key it wrote
// ("backups/YYYY-MM-DD.json", the UTC date of now).
//
// Secrets are nulled before they reach the snapshot — a deliberate
// improvement over a byte-for-byte port, not an oversight: the TypeScript
// original only ever had a dev-only `account.password` to strip. Limen's
// `accounts` table instead carries real OAuth tokens (access_token,
// refresh_token, id_token), and those are credentials that simply do not
// belong in a JSON file sitting in object storage — a restore loses the
// ability to silently reuse a stolen token, never the ability to sign in
// (the user just re-authorizes with the provider). `users.password` is
// nulled for the same reason the TypeScript job nulled `account.password`.
func RunBackup(ctx context.Context, d Deps, now time.Time) (string, error) {
	dump := make(map[string][]map[string]any, len(BackupTables))

	for _, table := range BackupTables {
		// BackupTables is a hard-coded Go slice, never user input, so
		// interpolating the identifier is safe — but it is quoted all the
		// same, because "users" (and several others) would otherwise parse
		// fine while a bare `user` — not a table in THIS schema, but the
		// general Postgres hazard CLAUDE.md calls out — would silently mean
		// the current_user function instead of a table reference.
		query := fmt.Sprintf(`SELECT * FROM "%s"`, table)
		rows, err := d.Pool.Query(ctx, query)
		if err != nil {
			return "", fmt.Errorf("jobs: backup %s: %w", table, err)
		}
		records, err := pgx.CollectRows(rows, pgx.RowToMap)
		if err != nil {
			return "", fmt.Errorf("jobs: backup %s: scan rows: %w", table, err)
		}

		switch table {
		case "users":
			for _, r := range records {
				r["password"] = nil
			}
		case "accounts":
			for _, r := range records {
				r["access_token"] = nil
				r["refresh_token"] = nil
				r["id_token"] = nil
			}
		}

		dump[table] = records
	}

	key := fmt.Sprintf("backups/%s.json", now.UTC().Format("2006-01-02"))
	body, err := json.Marshal(backupSnapshot{
		ExportedAt: now.UTC().Format(time.RFC3339),
		Tables:     dump,
	})
	if err != nil {
		return "", fmt.Errorf("jobs: marshal backup snapshot: %w", err)
	}

	if err := d.Storage.Put(ctx, key, bytes.NewReader(body), int64(len(body)), "application/json"); err != nil {
		return "", fmt.Errorf("jobs: write backup snapshot: %w", err)
	}
	return key, nil
}

// PruneBackups deletes backup snapshots older than backupRetentionDays and
// returns the keys removed, so the caller (Task 24's cron wiring) can log a
// count. Mirrors backup.ts's pruneBackups, including the key-date-first,
// UploadedAt-fallback rule: the date in the key is stable and is what names
// the snapshot, so it is preferred; an unexpected key (one that does not
// match backupKeyPattern) falls back to the object's own upload time.
func PruneBackups(ctx context.Context, d Deps, now time.Time) ([]string, error) {
	cutoff := now.Add(-backupRetentionDays * 24 * time.Hour)

	objects, err := d.Storage.List(ctx, "backups/")
	if err != nil {
		return nil, fmt.Errorf("jobs: list backups: %w", err)
	}

	var stale []string
	for _, o := range objects {
		stamp := o.UploadedAt
		if m := backupKeyPattern.FindStringSubmatch(o.Key); m != nil {
			t, err := time.Parse("2006-01-02", m[1])
			if err == nil {
				stamp = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
			}
		}
		if stamp.Before(cutoff) {
			stale = append(stale, o.Key)
		}
	}

	if len(stale) > 0 {
		if err := d.Storage.Delete(ctx, stale...); err != nil {
			return nil, fmt.Errorf("jobs: delete stale backups: %w", err)
		}
	}
	return stale, nil
}
