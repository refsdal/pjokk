# Admin user support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user page in the operator console (families, sign-in methods, sessions, history, email change, admin-role revoke, per-session sign-out) and keyset paging + search on the users, families and audit lists.

**Architecture:** Spec-first endpoints under `/api/admin` (tierSysadmin, audit-first writes). Limen-table writes and session-internal reads go through new `auth.Service` methods; plain reads and our own columns stay sqlc. Lists move from arrays to `{items, nextCursor}` with an opaque `(created_at, id)` keyset cursor. The SPA gains `UserDetail.tsx`, `describeDevice`, and `useInfiniteQuery` lists.

**Tech Stack:** Go 1.27 stdlib + oapi-codegen strict server, pgx/sqlc/goose, Limen v0.2.1; React + TanStack Query/Router; Playwright.

**Spec:** `docs/superpowers/specs/2026-09-11-admin-user-support-design.md`

## Global Constraints

- `openapi/pjokk.yaml` first, then `go generate ./...` + `sqlc generate` (apps/server) and `bun run gen:client` (root). Never hand-edit generated files.
- Every admin write: `adminID(ctx)` then `audit(...)` BEFORE the change, checked.
- Audit actions exactly: `user.email.change` (detail `old → new`), `user.role.revoke` (detail the email), `user.session.revoke` (detail the session's user agent, or empty).
- Errors: `409 EMAIL_TAKEN`, `400 UNCHANGED`, `400 REFUSED` (self), `409 LAST_ADMIN`, `404 NOT_FOUND`, `400 VALIDATION` for a malformed cursor.
- Paging: `limit` default 50, max 200; `{items, nextCursor}`; cursor = base64url of `RFC3339Nano|id`.
- No IP, no token, no raw metadata ever leaves the server. The console stays English-only.
- Green means every `test.yml` step: `bun run check`, `goreleaser check`, `bun run test`, `golangci-lint run` (apps/server), `go test -p 1 -count=1 ./...` — plus the full Playwright suite (`--workers=2`).
- Conventional Commits with the attribution trailer.

---

### Task 1: Keyset paging for the three admin lists

**Files:** `openapi/pjokk.yaml` (list responses → `AdminUserPage`, `AdminFamilyPage`, `AuditPage`; `cursor` + `target` params), `internal/db/queries/admin.sql` (keyset `ListAdminUsers`, `ListAdminFamilies`, `ListAdminAudit`), `internal/api/admin_paging.go` (cursor encode/decode), `internal/api/admin.go` + family list handler, SPA list screens adapted to `.items`, tests `internal/api/admin_paging_test.go`.

- [ ] Failing tests: each list walks every row exactly once in pages of 2 (users, families, audit), newest first; a row inserted between pages does not repeat or skip earlier rows; `limit=0`/`201` → 400 (spec bounds); a malformed cursor → 400 `VALIDATION`; `query` + cursor on users/families; `target` on audit returns only that target's rows.
- [ ] Queries: `WHERE (sqlc.narg('before_at')::timestamptz IS NULL OR (created_at, id) < (@before_at, @before_id))`, `ORDER BY created_at DESC, id DESC LIMIT @lim + 1` (the extra row says whether a next page exists).
- [ ] Handlers build `{items, nextCursor}`; SPA screens read `.items` so the build stays green.
- [ ] All `test.yml` Go steps green; commit `feat(admin): page and search the users, families and audit lists`.

### Task 2: The auth seam — sessions, email, activity

**Files:** `internal/auth/auth.go` (interface + `SessionInfo`, `WithSessionActivityCheckInterval(5*time.Minute)`), `internal/auth/users.go` (`ChangeEmail`), `internal/auth/sessions.go` (`UserSessions`, `RevokeSession`), `internal/db/queries/auth.sql` (`ListUserSessions`, `GetUserSessionToken`, `ChangeUserEmail`), tests `internal/auth/sessions_test.go`, `internal/auth/email_test.go`.

- [ ] Failing tests: `UserSessions` returns id/userAgent/created/lastAccess/expires/activeFamily/impersonatedBy and never the token; `RevokeSession` of another user's session → `ErrSessionNotFound`, of their own → that cookie stops resolving, the others still do; `ChangeEmail` normalises, clears `email_verified_at`, maps 23505 → `ErrEmailTaken`, keeps sessions, and password sign-in works with the new address; `last_access` set 10 min back moves forward on the next resolve.
- [ ] Implement; `go test -p 1 ./internal/auth/`; commit `feat(auth): list and revoke a user's sessions, change their email, track activity`.

### Task 3: The user detail API

**Files:** `openapi/pjokk.yaml` (`GET /api/admin/users/{id}`, `POST .../email`, `DELETE .../role`, `DELETE .../sessions/{sessionId}`; `AdminUserDetail` and parts), `internal/db/queries/admin.sql` (`AdminUserFamilies`, `AdminUserProviders`, `AdminUserHasPassword`, `CountSystemAdmins`, `RevokeSystemAdmin`), `internal/api/admin_users.go`, `api.go` tiers, tests `internal/api/admin_users_test.go`.

- [ ] Failing tests per the spec's Testing section (detail, email, role revoke, session sign-out, audit rows, tombstone 404).
- [ ] Implement; full Go suite + lint; commit `feat(admin): a user page API — detail, email change, admin revoke, session sign-out`.

### Task 4: The console

**Files:** `apps/frontend/src/lib/admin-device.ts` (`describeDevice`) + `test/admin-device.test.ts`; `screens/admin/UserDetail.tsx`; `screens/admin/Users.tsx` (search, Load more, rows link, sheet removed); `screens/admin/Families.tsx` and `Audit.tsx` (search / Load more); `router.tsx` (`/admin/users/$id`).

- [ ] Failing `describeDevice` table test; implement; screens; `bun run check` + `bun run test`; commit `feat(admin): the user page, search and Load more`.

### Task 5: End-to-end

**Files:** `e2e/admin.spec.ts`.

- [ ] A sysadmin searches for a user, opens their page, signs out one session (the other stays), changes their email; revoking the last admin is refused. Full suite green; commit `test(e2e): the admin user page`.

### Task 6: Docs

CLAUDE.md admin notes, DECISIONS.md entry, memory series note. Commit `docs: admin user support`.
