# Admin restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a nightly snapshot back — the whole database into an empty one, or one deleted family into the live one — from the CLI and (for a family) the console.

**Architecture:** A new `internal/restore` package: a schema-driven loader (live FK order, `json_populate_recordset`), `Whole` and `Family` on top of it, and photo recovery from the photo-backup trees. `cmd/pjokk` gains `restore`, `restore family` and `set-password`; `internal/api` gains two console operations; the Ops tab gains a Deleted families sheet.

**Tech Stack:** Go (pgx, goose, oapi-codegen strict server), React + TanStack Query, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-11-admin-restore-design.md`

## Global Constraints

- One transaction per restore; the whole restore tolerates exactly one conflict (the tombstone user), the family restore none.
- Never restored: `sessions`; for a family also `api_key`, `device`, `push_subscription`.
- `restore` tests live in `package restore_test` (import cycle through the rig).
- Every admin write audited; the family restore's audit row is inside its transaction.
- Passwords only from stdin; minimum 8 characters.
- Green gate before the PR: `bun run check`, `goreleaser check`, `bun run test`, `golangci-lint run`, `go test -p 1 -count=1 ./...`, full Playwright with `--workers=2`.

---

### Task 1: Snapshot schema version, the loader, the whole restore

**Files:** `internal/jobs/backup.go` (`schemaVersion`; exported `Snapshot` type and a reader); create `internal/restore/{schema,load,whole,photos}.go` and tests.

- [ ] Failing tests: backup writes `schemaVersion`; load order; generated columns skipped; unknown keys ignored; defaults for missing columns; chunking; round trip through a fresh database; empty-database guard; tombstone conflict; no-version warning; photos from current and deleted trees.
- [ ] Implement; tests green.
- [ ] Commit `feat(restore): load a snapshot into an empty database`.

### Task 2: The family restore

**Files:** `internal/restore/family.go`, tests.

- [ ] Failing tests per spec §Testing (family restore, guard).
- [ ] Implement; green.
- [ ] Commit `feat(restore): bring back one deleted family`.

### Task 3: The CLI

**Files:** `cmd/pjokk/main.go` (+ a small `restore_cli.go`), tests.

- [ ] Failing tests for argument parsing and stdin passwords; implement; green.
- [ ] Commit `feat(cli): pjokk restore, restore family and set-password`.

### Task 4: The console API

**Files:** `openapi/pjokk.yaml`, `internal/api/admin_restore.go`, `api.go` tiers, tests, gate test.

- [ ] Failing tests; implement; `go generate`; green.
- [ ] Commit `feat(admin): list and restore deleted families from a snapshot`.

### Task 5: The screens and E2E

**Files:** `screens/admin/Ops.tsx` (Deleted families sheet), `e2e/admin.spec.ts`.

- [ ] Implement; `bun run check`, `bun run test`; E2E green on a rebuilt stack.
- [ ] Commit `feat(admin): restore a deleted family from the Ops tab` and `test(e2e): restore a deleted family`.

### Task 6: Docs

- [ ] README Backups (restores are no longer manual), CLAUDE.md, DECISIONS.md, privacy policy (both languages), memory.
- [ ] Commit `docs: restore`.
