# User profile, avatars and the account sheet — Design

**Date:** 2026-09-06
**Status:** Approved design, pending implementation plan

## Problem

The app knows almost nothing about the person holding the phone. The Home
header shows an "A" in a circle where a face should be, the timeline says
"by Anders Refsdal Olsen" where the family says "by Pappa", and there is no
screen where a user can change any of it. Google already hands us a display
name and a picture URL at sign-in — the URL is even stored — but nothing
renders it, and the app's Content-Security-Policy (`img-src 'self' data:`)
would block it if something did. There is also no way to move between
families for a member of more than one, although the server, Limen's
`organizations:switch` route and the CLAUDE.md IA ("caretaker chip
(avatar → family switcher)") all already provide for it.

## What it is

A **profile** is global user state — the same nickname, photo and phone in
every family the user belongs to — edited on a new `/profile` screen and
read everywhere the app names or depicts a person. An **avatar** is a
square photo, imported once from Google or uploaded by the user, stored
through the storage port and streamed back through an authed route to the
people who share a family with its owner. The **account sheet** opens from
the avatar chip on Home and is where a user reaches their profile, switches
family, and signs out.

## Decisions taken during design (and why)

- **The login email is shown, not edited, and there is no separate contact
  email.** Limen's `users.email` is NOT NULL, UNIQUE and the credential
  login subject; Limen owns its verification state and its own user-update
  route is deliberately disabled in the allowlist. Every account today has
  a real address (Google always supplies one; credential signup requires
  one), so a contact email would duplicate it for everyone and make the
  profile screen explain the difference. **Deferred, not rejected:** a
  nullable `contact_email` shown in place of the login one is a one-column
  change if a provider that supplies no email (GitHub, a generic OIDC
  issuer) ever ships.
- **Phone and email are private to the user for now.** They are not added
  to the `Member` object, the Caretakers list or the help-request card. A
  later "share with my families" toggle is the natural place to open that
  up.
- **No family slug in the URL.** The server resolves the family from the
  session's active organization and every domain query scopes on
  `family_id`; the client never names a family. A URL-scoped family would
  be a second source of truth that can disagree across tabs, would need a
  switch call on every navigation, and would complicate the PWA start URL,
  precaching, push-notification links and `/join/CODE`. Switching is rare
  (a grandparent with two grandchildren). The real hazards are client-side
  — stale caches and replayed offline writes — and §5 handles them
  directly.
- **Nothing else moves out of Settings.** Notifications are per user but
  configured per device; Appearance is per device. The Settings tab is, in
  practice, family and device settings; `/profile` is the person.
- **Avatar bytes go through the storage port**, not a `bytea` column.
  CLAUDE.md's rule is "files go through the port", the vaccine-document
  path proves it, and it keeps blobs out of every nightly row dump. The
  consequence — avatars are not in the backup, exactly like vaccine
  documents — is recorded in DECISIONS.md.
- **Night mode stays text-only.** No images in the night layout.

## Design

### 1. Data model

Goose migration `00006_user_profile.sql`, on Limen's `users` table (our
added columns already live there — `name`, `image`, `role`, `banned`):

```
ALTER TABLE "users"
  ADD COLUMN "nickname"            text,
  ADD COLUMN "phone"               text,
  ADD COLUMN "avatar_key"          text,          -- storage key; NULL = no photo
  ADD COLUMN "avatar_imported_at"  timestamptz,   -- first Google import ATTEMPT
  ADD COLUMN "display_name"        text GENERATED ALWAYS AS
      (COALESCE(NULLIF(btrim("nickname"), ''), "name", '')) STORED;
```

- `display_name` is the ONE place the "nickname, else full name" rule
  lives. Every query that joins `u."name"` to show a person **to the
  family** switches to `u."display_name"`: the `caretaker_name` joins in
  `feeds.sql`, `diapers.sql`, `sleep.sql`, `other_logs.sql`, `play.sql`,
  `vaccines.sql`, `timeline.sql`, `summary.sql` and `export.sql` (the CSV
  says what the screen says), the members list in `family.sql`, and the
  creator and assignee names in `calendar.sql`. Three joins deliberately
  keep the full name: `auth.sql` (the session's own `Name`, which `Me`
  reports separately from `displayName`), `admin.sql` (the operator sees
  real names in the audit trail) and `middleware.sql`. The frontend never
  learns the rule.
- `image` keeps exactly its current meaning — the picture URL Google's
  profile mapping writes at sign-in — and is now used purely as an import
  source (§3). It is never served.
- `avatar_imported_at` is set the first time an import is *attempted*,
  success or not, so a photo the user removed is never silently
  re-imported on their next Google sign-in.
- `internal/auth`'s `Session` struct and `GetAuthSession` gain
  `Nickname`, `Phone`, `DisplayName`, `AvatarKey`, `AvatarImportedAt` and
  `Image`, so `GetMe` needs no second query.
- No new table, so `backup_tables_test.go` is unaffected. The nightly dump
  gets the new columns for free; the `users` row is already in it.

### 2. API (spec first — `openapi/pjokk.yaml`)

**Shapes**

- `Me` gains `nickname` (nullable string), `phone` (nullable string),
  `displayName` (string) and `avatarUrl` (nullable string). All required
  keys.
- `Member.image` (present in the schema, unused by the SPA) is replaced by
  `avatarUrl` (nullable string). `Member.name` becomes the display name.
  `Member` does NOT gain phone; `email` stays as it is today.
- `CalendarEvent.assignees[].name`, `CalendarEvent.createdByName` and every
  `caretakerName` become display names — a query change, not a shape
  change.
- `avatarUrl` is always `/api/users/{userId}/avatar?v={avatar_key}`. The
  key doubles as the cache-busting version: a new upload is a new key, so
  a `<img>` never shows a stale photo from the browser cache.

**Routes**

- `PATCH /api/me` (session tier, family NOT required — a profile is
  global). Body: `name?`, `nickname?` (nullable), `phone?` (nullable).
  Validation at the edge in the spec, semantic checks in the handler:
  `name` trimmed, non-blank, ≤ 100 chars; `nickname` ≤ 40; `phone` ≤ 32
  and limited to digits, spaces, `+`, `-`, `(`, `)`. `null` clears
  nickname or phone; an absent key leaves the field alone (the existing
  `patch.go` optional-field convention). Returns the updated `Me`.
- `PUT /api/me/avatar` — multipart, field `file`. Registered by hand on the
  mux next to the vaccine-document routes (the strict server cannot
  express multipart), behind the session chain. Accepts `image/jpeg` and
  `image/png`, ≤ 512 KB. The handler **decodes the bytes with the standard
  library** (`image/jpeg`, `image/png`) to confirm the declared type and
  reject anything above 1024 px on either edge — the content type is
  client-supplied and not evidence. Writes through `storage.Storage` under
  a fresh key (`avatars/{userId}/{uuid}`), updates `avatar_key`, deletes
  the previous object best-effort, returns `Me`. Error codes follow
  `files.go`: `NO_FILE`, `BAD_TYPE`, `TOO_LARGE`.
- `DELETE /api/me/avatar` — clears `avatar_key`, deletes the object,
  leaves `avatar_imported_at` set (see §1). Returns `Me`.
- `GET /api/users/{userId}/avatar` — session tier. Allowed for the caller
  themself and for anyone who shares at least one organization membership
  with the target user (one EXISTS query on `organization_members`).
  Everyone else, and any user without a photo, gets **404, not 403** — the
  route must not confirm that a user id exists. Streams the object with
  its stored content type, `ETag` = avatar key, and
  `Cache-Control: private, max-age=86400` (safe because the URL is keyed
  by version). Sysadmins are not special-cased; the admin console keeps
  its initials.
- `api_key` bearer tokens are NOT accepted on any of these: an
  integration has no profile to edit and no need to read faces.

**Deletion.** The admin cascade delete (`admin.go`) and the orphan-account
purge delete the avatar object from the store when they delete the user
row. The in-memory `Storage` in tests makes both assertable.

### 3. Google import

Happens inside `GET /api/me` — the SPA's first call after sign-in, session
tier, with `Deps.Storage` at hand — when **all** of: `avatar_key IS NULL`,
`avatar_imported_at IS NULL`, and `image` is an `https` URL whose host is
`lh3.googleusercontent.com` or ends in `.googleusercontent.com`. The host
allowlist is the SSRF guard: the URL is data from a third party, never
something the server should fetch blindly.

The fetch runs **synchronously** with a 3-second context timeout and a
1 MiB read cap, checks the response `Content-Type` is JPEG or PNG and that
the bytes decode (same check as upload), writes through the port, sets
`avatar_key`, and sets `avatar_imported_at` on the way out **whatever
happened**. Worst case: one three-second delay, once per account lifetime;
a Google outage at that moment costs the user their photo (they can upload
one), never their sign-in. The HTTP client is a `Deps` field
(`AvatarFetcher`, an `*http.Client` plus the host allowlist) so tests point
it at an `httptest.Server` with the allowlist widened; production wires
the default client. The `scratch` image already carries CA certificates
for web-push's outbound TLS, so nothing new is needed there.

### 4. Frontend

**`Avatar` component** (`components/Avatar.tsx`): props `src` (nullable),
`name`, `size`. Renders `<img>` when `src` is set and falls back to the
initial-in-a-circle on `null` **and on image error** — which is also what
offline looks like when the photo is not in the service-worker cache. Used
in:

- the Home header chip (44 px; tap opens the account sheet — §5);
- the Caretakers list in Settings → Family (36 px);
- the timeline row, **at the far right, spanning the clock and "by name"
  lines** (32 px). The row becomes icon · title · clock/author block ·
  avatar. The text attribution stays;
- the assignee chips in the event sheet, **at the far left of each chip**
  (20 px). `MultiChipGroup` gains an optional `leading` node per option;
- the account sheet header and the profile screen.

Timeline entries and calendar events carry `caretakerId`/`userId` only;
the row looks the URL up in the `members` query (`useMemberAvatars()`
returns a `userId → avatarUrl` map). A caretaker who has since left the
family, or a members query that has not resolved, gives the initial
fallback. The timeline stays offline-viewable because it does not depend
on `members` (never persisted) to render.

**Client-side resize** (`lib/avatar-image.ts`): the picker accepts
`image/*`; the image is decoded, centre-cropped square, drawn to a 512 px
canvas and exported as JPEG at quality 0.85. Safari decodes HEIC on iOS
for us, and the server never sees anything but a small JPEG.

**`/profile` screen** (`screens/Profile.tsx`, under the authed shell,
reachable from the account sheet and from Settings): avatar with "Change
photo" / "Remove", Full name, Nickname (hint: "Shown instead of your full
name everywhere"), Phone, Email read-only with the hint "Sign-in address".
react-hook-form + zod, Save at the bottom, `PATCH /api/me` then invalidate
`me` and `members`.

**Settings** → Account card: a profile row (avatar, display name, email,
chevron) linking to `/profile`, then Sign out. The bare name/email
paragraph goes. The admin-console link stays.

**i18n**: every new string through `t()` with `nb` entries in
`lib/i18n.ts`; the coverage check in `bun run check` enforces it.

### 5. Account sheet and the family switch

The avatar chip on Home opens `AccountSheet` (vaul):

1. header — avatar, display name, email;
2. "Your profile" → `/profile`;
3. "Families" — every organization the user belongs to
   (`authClient.organization.list`, already allowlisted), the active one
   marked. Shown even with one family, so the section exists when a second
   invite is redeemed. No create button (creation is gated; Welcome and
   Join own it);
4. Sign out (moved here; Settings keeps its copy).

**Switch flow.** Tapping another family:

- **refuses while paused offline mutations are queued**
  (`queryClient.getMutationCache()` has entries in `paused` state) with a
  toast: those writes carry family-1 baby ids and would be rejected under
  family 2's tenancy checks — the server cannot cross families, but the
  entry would be silently lost;
- calls `authClient.organization.switch({ id })` (the same call
  `Join.tsx` already makes);
- runs the existing `resetCache()` (memory + IndexedDB), clears the
  selected-baby store, records the new family id in the fence (below), and
  navigates to `/home`.

**Family fence** (`lib/family-fence.ts`, wired in `AppShell`). The app
keeps the last family id it rendered in `localStorage`
(`pjokk.familyId`). Every time the `me` query resolves, the shell compares
`me.familyId` with it; on mismatch it stores the new id, runs
`resetCache()` and reloads. `me` is never persisted and refetches on
window focus, so this one check catches a switch made in **another tab**
(shared cookie), on **another device**, and a crash mid-switch — cases
the flow above cannot reach. The first ever resolve (nothing stored)
simply records the id.

Why this and not a family-scoped cache buster: the persister is configured
once at boot, before `me` is known; the fence needs no boot-order change
and covers the same ground.

### 6. Tests

**Go** (`apps/server`, real Postgres, `-p 1`):

- `me_test.go`: PATCH validation (blank name, over-long nickname, bad
  phone characters, `null` clears, absent leaves); nickname set → the same
  user's feed row on `/api/timeline` and `/api/feeds` reads the nickname
  as `caretakerName`; nickname cleared → full name again.
- `avatar_test.go`: upload JPEG and PNG OK; GIF, oversize, and bytes that
  do not decode despite a JPEG content type → `BAD_TYPE`/`TOO_LARGE`; the
  old object is gone from the in-memory store after a second upload; GET
  as self and as a co-member streams with the right ETag; a user in a
  different family gets 404; a user with no photo gets 404; DELETE clears
  and a later GET is 404.
- `avatar_import_test.go`: an `httptest.Server` serving a PNG, allowlist
  widened via `Deps.AvatarFetcher` → first `GET /api/me` returns
  `avatarUrl`; a non-allowlisted host is never fetched; a failing server
  leaves `avatarUrl` null and `avatar_imported_at` set, and a second
  `GET /api/me` does not retry.
- `admin_test.go`: cascade delete removes the avatar object.
- `TestLimenRouteAllowlist` unchanged — nothing new is enabled upstream.

**Frontend** (`bun test apps/frontend`): `Avatar` falls back on `null` and
on `onError`; `family-fence` records on first resolve, no-ops on match,
resets on mismatch; the i18n coverage check.

**Playwright** (`e2e/`): edit the nickname on `/profile`, log a feed, see
the nickname on the timeline row; upload the fixture PNG, see the header
chip render an `<img>`; the account sheet lists the family and signs out.

### 7. Documentation

- **CLAUDE.md**: IA — Home's caretaker chip opens the account sheet
  (profile, family switch, sign out); `/profile` added to the screen list;
  the "Attribution is ambient" principle notes it uses the display name.
- **DECISIONS.md**: the five decisions under "Decisions taken during
  design" above, plus "avatars are outside the nightly backup, like
  vaccine documents".

## Out of scope

Contact email, sharing phone/email with family members, family slug
routes, avatars in the admin console, avatars in push-notification
payloads, avatars in the night layout.
