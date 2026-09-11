# Admin console: user support and recovery — Design

**Date:** 2026-09-11
**Status:** Approved design, pending implementation plan
**Series:** 2 of 4 in the operator-console expansion — after family
management (spec `2026-09-08-admin-family-management-design.md`, PR #74),
before operations (health page, job runner, backup visibility) and restore.

## Problem

Spec 1 gave the console a family page; people still have only a sheet. A
support ticket about a *person* — "I can't sign in", "I left it signed in on
my sister's phone", "I typed my address wrong", "Ola isn't an operator any
more" — ends in a database session: the console cannot show which families
someone belongs to, how they sign in, or where they are signed in, and it
cannot change an email address or take the system-admin role away. Its lists
also stop scaling: users come back as the first 200, families all at once,
and the audit trail as its newest 100, none of them pageable.

This spec keeps spec 1's two framings: it is **operator and support
tooling, not moderation** — every tool leaves an audit row and answers a
ticket — and the console is **metadata-only**: no log content anywhere.

## Decisions taken in review

| Question | Decision |
|---|---|
| What does an operator's email change do to sign-in? | Changes the address only. Refused if taken; sessions and the linked Google account stay (Google sign-in follows the Google account's id, not the address). Audited old → new. |
| Grant the system-admin role, or only take it away? | **Revoke only**, never your own and never the last admin's. Granting stays a database step: no route mints system admins (e2e `makeSysadmin`'s standing rule) — a stolen operator session cannot make itself a second, permanent admin. |
| Sessions? | Listed, with a per-session Sign out as well as Sign out everywhere. |
| Which lists get search and paging? | All three: users, families, and the audit trail. |

## Non-goals

- Granting the system-admin role (above).
- Unlinking a Google account or removing a password. Recovery stays
  "set a password", which exists.
- Merging two accounts (someone who signed in with a new Google account).
- Any e-mail sending: there is still no mail provider, so nothing proves a
  new address belongs to its owner — the operator's word is the check.
- A client IP anywhere. Sessions are described by their user agent.

## Design

### 1. The user page (`/admin/users/$id`)

Rows in the Users list open it; the Users sheet goes away and its actions
move here. From the top:

- **Header:** name, email, joined date, a "System admin" badge, and a
  "Banned — reason" banner when it applies.
- **Families:** each family's name and the person's role in it, linking to
  the family page (`/admin/families/$id`).
- **Sign-in:** "Password set" / "No password", and linked providers (Google,
  and when it was linked). Read-only.
- **Sessions:** one row each — "Chrome on Android · started 3 Sep · active
  5 min ago · in Hansen", marked "impersonated by Ola" where that is so —
  with **Sign out** per row and **Sign out everywhere**.
- **History:** audit entries whose target is this person, newest first,
  paged.
- **Actions:** change email; revoke system admin; and, moved from the sheet,
  set password, ban / unban, impersonate, delete.

### 2. API (`openapi/pjokk.yaml` first)

All `tierSysadmin`; every write writes its audit row first, checked (the
console's existing rule).

| | |
|---|---|
| `GET /api/admin/users/{id}` | `AdminUserDetail`: the `AdminUser` fields + `hasPassword`, `families[{familyId, name, role}]`, `providers[{provider, linkedAt}]`, `sessions[{id, userAgent, createdAt, lastActiveAt, expiresAt, familyName, impersonatedByName}]`. `404` for an unknown id or the tombstone, which the users list leaves out too: it is not a person, and a row that opens onto a 404 is a dead end. |
| `POST /api/admin/users/{id}/email {email}` | → the updated `AdminUser`. `409 EMAIL_TAKEN`; `400 UNCHANGED`. Audit `user.email.change`, detail `old → new`. |
| `DELETE /api/admin/users/{id}/role` | → `204`. `400 REFUSED` for yourself; `409 LAST_ADMIN`; `404` when not a system admin. Audit `user.role.revoke`. Also ends every session they are driving through impersonation. |
| `DELETE /api/admin/users/{id}/sessions/{sessionId}` | → `204`. `404` when the session is not theirs. Audit `user.session.revoke`, detail the session's user agent. |

**Paging.** `GET /api/admin/users`, `/families` and `/audit` take
`?cursor=&limit=` (default 50, max 200) and answer `{items, nextCursor}`,
`nextCursor` null at the end. The cursor is an opaque encoding of the last
row's `(created_at, id)`; keyset rather than offset, because the audit trail
grows while someone reads it. Users and families keep `?query=`; audit gains
`?target=` (the user page's history).

### 3. The auth seam

Writes to Limen's tables and reads of session internals go through new
`auth.Service` methods (Limen stays confined to `internal/auth`):

- `UserSessions(ctx, userID) ([]SessionInfo, error)` — never a token; the
  user agent and the impersonation marker come from the session's metadata.
- `RevokeSession(ctx, userID, sessionID) error` — `ErrSessionNotFound` when
  the session is not that user's. Revoking an impersonated session cascades
  its impersonation record away (00003).
- `ChangeEmail(ctx, userID, email) error` — normalised with
  `auth.NormalizeEmail`; `ErrEmailTaken` on the unique index (SQLSTATE
  23505); clears `email_verified_at` (nobody has verified the new address;
  nothing in the pinned Limen v0.2.1 gates sign-in on it).

Plain reads and our own columns stay sqlc, as today: a user's families,
their providers (provider name and link time only — never the token
columns), whether a password is set, and the role revoke on our
`users.role` column (as ban writes `banned`).

**One auth configuration change:** `WithSessionActivityCheckInterval(5 min)`.
Without it the pinned Limen writes `last_access` only when a session is
created or its expiry extended (at most daily), so "active 5 min ago" would
be days stale. One write per session per five minutes — the cadence API keys
and kiosk devices already use.

### 4. The console (`apps/frontend/src/screens/admin`)

- **Users, Families, Audit:** a debounced (300 ms) server-side search box on
  Users and Families, **Load more** at the foot of all three
  (`useInfiniteQuery`), not infinite scroll.
- **The user page** (`UserDetail.tsx`, route beside the family detail):
  Section 1's layout in `FamilyDetail.tsx`'s style. Change email in a sheet
  (a `409` says "That address belongs to another account" inline); revoke
  system admin and each session's Sign out use the tap-twice confirm.
- **`describeDevice(userAgent)`** — a small pure function ("Chrome on
  Android", "Safari on iPhone", "Firefox on Windows", fallback "Unknown
  device"), tested against a table of real user-agent strings.
- The console's strings go through `t()`, as the family pages' already
  did, but `scripts/check-i18n.mjs` skips `screens/admin/`, so they stay
  English until someone translates them. The existing structural test that
  keeps admin screens off log endpoints covers the new page.

## Testing

Test-first. Go against real Postgres (`go test -p 1 -count=1 ./...`):

- **User detail:** families, providers and sessions are right; no token or
  raw metadata leaves the server; an impersonated session is marked; the
  tombstone and an unknown id are 404.
- **Email change:** taken 409; unchanged 400; normalised; verified cleared;
  sessions and the Google link survive; password sign-in works with the new
  address; audit old → new.
- **Role revoke:** self 400; last admin 409; a non-admin 404; the demoted
  admin's next `/admin` request is refused; their impersonated sessions end;
  audited.
- **Session sign-out:** another user's session 404; the signed-out cookie
  stops working; the others do not; audited.
- **Paging:** each list's cursor walks every row exactly once; stable while
  rows are inserted; limit bounds; `query`/`target` combine with the cursor;
  a malformed cursor is a 400.
- **Activity interval:** with `last_access` set back ten minutes, a request
  moves it forward.

Frontend (`bun test`): `describeDevice` against the table.

E2E (`admin.spec.ts`): a system admin searches for a user, opens their
page, signs out one of their sessions, changes their email; revoking the
last admin is refused.

## Docs

CLAUDE.md's admin notes, a DECISIONS.md entry, and the
admin-console-expansion series note.
