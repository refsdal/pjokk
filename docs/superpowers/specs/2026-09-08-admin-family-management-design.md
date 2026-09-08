# Admin console: family management — Design

**Date:** 2026-09-08
**Status:** Approved design, pending implementation plan

## Problem

`/admin` today can count things, list families, list users, and destroy
either. It cannot *fix* anything about a family. There is no way to see who
is in one, to add or remove a member, to change a role, to mint an invite, to
rename a family, or to create one at all — and no way to recover a family
whose last admin was deleted, which is a state the console itself can
produce (`DeleteAdminUser` cascades a membership away without consulting the
last-admin guard that `auth.RemoveMember` enforces).

The result is that every support situation past "ban this account" ends in a
hand-written `UPDATE` against production, which leaves no audit row and is
exactly what `admin_audit` exists to prevent.

This is the first of four specs expanding the operator console. The others,
in order, are: support and recovery tooling (user detail), operations
(health page, job runner, backup visibility), and restore (a `pjokk restore`
CLI plus per-family restore from a snapshot). This one comes first because
a family *detail* page is the spine the other family-scoped tools hang off.

### Not moderation

Pjokk has no public or shared user-generated content — there is nothing to
moderate in the usual sense. What this spec builds is **operator and support
tooling**, and that framing decides what "good" looks like: every tool leaves
an audit trail and answers a support ticket, rather than policing content.

## Approach

Three ways to give a sysadmin power over a family were considered.

**A. Dedicated admin routes, shared cores** (chosen). New
`/api/admin/families/{id}/…` operations, all `tierSysadmin`, each writing a
checked `admin_audit` row. The existing family-scoped handlers are thin
wrappers over sqlc queries that already take `family_id`, so a
`familyID`-taking core is extracted and both tiers call it.

**B. "Act as family"** — let a sysadmin set any family as their session's
active family and reuse every `tierFamily`/`tierAdmin` route unchanged.
Rejected: it makes "a sysadmin is not a member of any family" false, and
every resulting audit trail reads as an ordinary family-admin action with no
operator identity attached.

**C. Do it through impersonation** — no new code; impersonate a family admin
and use the normal UI. Rejected: it fails precisely in the cases the tooling
exists for (a family with no admin left; removing the only admin), it shows
the family an impersonation banner for routine support, and it files
operator actions under a caretaker's name.

A was chosen because it is the only one where the audit trail stays truthful.

## What a sysadmin may see

**Metadata only.** Family name, slug, plan, created; members with roles;
babies (name, birth date, sex); invites; API keys; and the `lastFeedAt` the
families list already computes. **No log content and no per-type counts** —
nothing derived from a child's health record enters the console.

This is deliberate and load-bearing. `apps/landing/src/legal/privacy.tsx`
currently promises an audit trail of administrative actions and says nothing
about operator access to health data; keeping the console to metadata means
this spec requires **no change to the privacy policy**. Any future feature
that surfaces a family's actual entries in `/admin` must add a clause there
first — it is a legal statement, not decoration.

Impersonation remains the only route to a family's actual data, and it is
already audited and already shows the family a banner.

## Design

### 1. API (`openapi/pjokk.yaml` → `go generate` → `bun run gen:client`)

Nine new operations, all `tierSysadmin` in `api.go`'s `operationAuthTiers`,
plus one parameter on an existing operation.

| Operation | Route |
|---|---|
| `ListAdminFamilies` | *existing*, gains `?query=` (name/slug `ILIKE`) and `hasAdmin` in its rows |
| `CreateAdminFamily` | `POST /api/admin/families` |
| `GetAdminFamily` | `GET /api/admin/families/{id}` |
| `UpdateAdminFamily` | `PATCH /api/admin/families/{id}` |
| `AddAdminFamilyMember` | `POST /api/admin/families/{id}/members` |
| `RemoveAdminFamilyMember` | `DELETE /api/admin/families/{id}/members/{userId}` |
| `SetAdminFamilyMemberRole` | `POST /api/admin/families/{id}/members/{userId}/role` |
| `CreateAdminFamilyInvite` | `POST /api/admin/families/{id}/invites` |
| `RevokeAdminFamilyInvite` | `DELETE /api/admin/families/{id}/invites/{code}` |
| `RevokeAdminFamilyKey` | `DELETE /api/admin/families/{id}/keys/{keyId}` |

`GetAdminFamily` returns **one** payload rather than four list endpoints —
it renders a single page, so it is a single round trip:

```
AdminFamilyDetail {
  id, name, slug, plan, createdAt, lastFeedAt?
  members:  [{ userId, name, email, role, joinedAt, banned }]
  babies:   [{ id, name, birthDate, sex? }]
  invites:  [{ code, role, maxUses, usedCount, expiresAt, revokedAt?, url }]
  apiKeys:  [{ id, label, readOnly, createdAt, lastUsedAt? }]
}
```

`ListAdminFamilies` gains `hasAdmin: boolean` so the list can badge families
that have been stranded without one.

`UpdateAdminFamily` changes the **name only**. The slug is left alone: it is
derived by Limen's configured slug generator at creation time, and quietly
regenerating it on rename would change an identifier under whatever already
holds it.

**Reuse, not duplication.** `ListFamilyMembers`, `ListAPIKeys`,
`ListInvites`, `RevokeInvite` and `RevokeAPIKey` are already sqlc queries
keyed on `family_id`. A `familyID`-taking core is extracted from
`CreateInvite` — code generation, the 72 h / 5-use / `member` defaults, and
`serInvite` — so the `tierAdmin` and `tierSysadmin` paths share it. There
must not be a second invite-code generator; a divergence between the two
would be silent.

`ListBabies` (`core.sql`) is already keyed on `family_id` and is reused as
is. The only new sqlc work is `GetUserIDByEmail`, to resolve an added
member, and the `hasAdmin` / `?query=` additions to `ListAdminFamilies`.

Request bodies for the three that take one:

```
AddAdminFamilyMember      { email, role: admin|member }
SetAdminFamilyMemberRole  { role: admin|member }
CreateAdminFamilyInvite   { role?, expiresInHours?, maxUses? }   // same
                          // optional-with-defaults shape as CreateInvite
```

### 2. The auth seam

`CreateAdminFamily` cannot call `auth.CreateFamily(parentID, name)` as it
stands. That method makes `userID` the family's first admin, and
`allowOrgCreation` checks *that* user: a freshly provisioned account is
neither a system admin nor inside the `OPEN_SIGNUP` founder-bootstrap
window, so creation fails closed. Creating a family *on behalf of* someone
therefore needs the sysadmin's authority to reach the hook.

One method is added to `auth.Service`:

```go
// CreateFamilyForUser creates a family whose first admin is ownerUserID,
// on the authority of a system admin rather than the owner's own.
CreateFamilyForUser(ctx context.Context, ownerUserID, name string) (familyID string, err error)
```

It is implemented by placing an **unexported context marker** on the ctx
handed to `organization.CreateOrganization`, which `allowOrgCreation`
consults before its ordinary rules. The key type is private to
`internal/auth`, so nothing outside the package can forge it, and the
closed-alpha guarantee is unchanged: the only caller is an audited
`tierSysadmin` route. This is the only change this spec makes outside
`internal/api`, and it respects the rule that Limen stays confined to
`internal/auth`.

### 3. Family creation

Request body — three behaviours from a flat shape, deliberately not a
`oneOf`, which `oapi-codegen` handles badly:

```
{ name, adminEmail?, adminName?, createAccount? }
```

- **`adminEmail` matches an existing account** → that account becomes the
  family's admin.
- **`adminEmail` has no account** → `404 No account for that email`, *unless*
  `createAccount: true`, in which case `adminName` is required and
  `auth.CreateUser(name, email, "")` provisions a **passwordless** row. The
  explicit flag exists so that a mistyped address produces an error rather
  than silently minting a stray account.
- **No `adminEmail`** → an empty family plus an `admin`-role invite; the
  response carries the `/join/CODE` URL, rendered as a link and a QR.

Response:

```
{ id, name, slug,
  firstAdmin?: { userId, email, accountCreated },
  invite?:     { code, url } }
```

A passwordless account is the right shape here and is already built for it:
`auth.CreateUser` with an empty password stores `NULL` in `users.password`,
which Limen's credential plugin reads as "signed up through OAuth" —
sign-in fails cleanly and `SetPassword` can still establish a first password
later. Limen's OAuth plugin then links by address
(`plugins/oauth@v0.2.0/account_linker.go`: `CreateOrLinkAccount` →
`findUserByEmail` → `linkAccountToUser`), so the parent signing in with
Google on the same address lands on the row that was provisioned for them.
This is the first production caller of the passwordless path, which until
now existed only for tests.

#### Partial failure

**This cannot be one transaction.** `CreateUser` and `CreateFamilyForUser`
both go through Limen, which opens its own — the same constraint
`invites.go` documents for invite redemption. The steps are therefore
ordered so that a partial failure is benign:

1. Resolve or create the first-admin user. A memberless account is inert —
   it cannot create a family (`allowOrgCreation`) or reach any family route
   — and the existing 7-day orphan purge removes it.
2. `CreateFamilyForUser`, which atomically creates the organization and
   installs the admin membership.
3. Audit.

There is **no compensating delete**. That pattern was removed during the Go
port and should not come back; the failure it would guard against already
cleans itself up.

**A mismatched Google address self-heals** the same way: if the parent signs
in with a different address than the one provisioned, Limen creates a
separate account, the pre-created row is purged within a week, and the
operator mints an invite from the family detail page — the tool this spec
adds.

### 4. Auditing

Every mutation writes a checked `admin_audit` row **before** the change, via
`admin.go`'s `audit` helper (the checked one that propagates a failure, not
`middleware.Audit`). `target` is the **family id** throughout, so filtering a
family's history becomes possible later without a schema change.

| Action | Detail |
|---|---|
| `family.create` | family name |
| `family.rename` | `old → new` |
| `family.member.add` | `email as role` |
| `family.member.remove` | email |
| `family.member.role` | `email: admin → member` |
| `family.invite.create` | `code role` |
| `family.invite.revoke` | code |
| `family.key.revoke` | key label |
| `user.create` | email (target is the **new user id**, not a family) |

`adminID(ctx)` continues to attribute every row to the real operator, never
to an account being impersonated.

The last-admin guard (`auth.ErrLastAdmin`) stays enforced for sysadmins too,
on both remove and demote, and maps to a 400. Promoting someone else first
is always available, and a refusal is a better outcome than a stranded
family.

### 5. Frontend (`apps/frontend`)

**`/admin/families` (reworked).** A search field wired to `?query=`. Rows
become links to the detail page and **lose their `DeleteButton`** — a
cascade delete one fat-fingered tap from a list row is too cheap, so it
moves to a danger zone on the detail page. Families with no admin carry a
`NO ADMIN` badge in the style of the existing `banned` chip. A **New family**
button opens the create sheet.

**`/admin/families/$id` (new).** A lazy route parented at `adminRoute`,
exactly like its four siblings, rendering `GetAdminFamily`'s payload as
iOS-style grouped `Card` sections:

- **Header** — name with inline rename, slug, plan chip, created date.
- **Members** — name, email, role chip; tapping a row opens a sheet with a
  role toggle and remove. **Add member** takes an email and a role.
  `ErrLastAdmin` surfaces as a toast explaining that someone must be
  promoted first.
- **Babies** — read-only: name, birth date, age.
- **Invites** — code, role, uses/max, expiry, revoked state; mint and revoke.
- **API keys** — label, read-only chip, created, last used; revoke.
- **Danger zone** — delete family.

**Create sheet.** Family name, then an optional admin email. On blur the
email is checked; when no account exists the sheet reveals a **Create
account** checkbox and a name field rather than proceeding silently. An
empty email switches the primary button to "Create with invite link", and
the result panel shows the `/join/CODE` URL with a copy button and a QR.

**One refactor.** `InviteQR` currently lives inside
`screens/settings/FamilySection.tsx`. It moves to `components/InviteQR.tsx`
so settings and admin share one implementation rather than growing a second
`qrcode` call site.

All user-facing strings go through `t()`, as everywhere else.

### 6. Testing

Go, against a real Postgres through `testrig` (`go test -p 1 ./...`), in a
new `internal/api/admin_families_test.go` beside `admin_test.go`:

- **Tier gate** — every new operation answers 403 to a signed-in non-sysadmin,
  *including the family's own admin*: these are not `tierAdmin` routes.
- **All three creation modes**, plus the mistyped-email case answering 404
  rather than provisioning an account.
- **Last-admin guard** on both remove and demote.
- **Cross-family isolation** — revoking an invite or a key belonging to a
  different family answers 404, not 200. The queries take `family_id`; this
  is the test that keeps it that way.
- **Audit** — a row per mutation, attributed to the operator even under
  impersonation, and a failed audit write aborting the mutation.

In `internal/auth`: `CreateFamilyForUser` succeeds under closed signup for a
memberless account — the exact regression that motivated the seam — while
plain `CreateFamily` still refuses that account.

`spec_sync_test.go` and `assertOperationAuthCoverage` already fail the build
when a new `operationId` is missing from the tier map, so that coverage is
free.

Frontend: `bun test` over the pure helpers (invite URL construction, the
"has no admin" predicate), keeping the screens thin. Plus a new
`e2e/admin.spec.ts` — **there is no e2e coverage of `/admin` at all today** —
walking create-family-with-invite → open detail → add member → change role →
revoke invite, seeded through `e2e/fixtures.ts` (which seeds day mode; new
specs must import from it).

## Out of scope

- **Pagination** on families, users and audit. Alpha scale does not need it;
  `ListAdminAudit` returning the whole append-only table is known debt.
- **The search box on the Users list** and everything else user-shaped —
  that is spec 2 (support and recovery tooling).
- **Any per-family log visibility.** Settled above: metadata only.
- **Email.** There is no SMTP or mail provider anywhere in this stack, so
  account recovery stays operator-mediated. Adding one is a separate
  decision that touches the self-host story.
