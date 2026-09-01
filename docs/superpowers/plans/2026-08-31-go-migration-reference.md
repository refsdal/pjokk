# Go Migration Reference — Backend Inventory & Limen Integration

This document is the **parity contract** for the Go rewrite. Part A is a
verified inventory of the TypeScript backend as of commit `1ec665c`. Part B is
a source-verified integration guide for Limen. Implementation tasks cite
sections of this file; when in doubt, the TS source is ground truth and this
file is the map to it.

Billing is being **dropped** in the rewrite (see the design spec). Inventory
entries mentioning Stripe/402/plan gates document today's behavior; the plan
says what replaces them (almost always: the gate is removed, the route is
free).

---

# Part A — TypeScript Backend Inventory

## A1. API Routes

### Mount order (`apps/api/src/app.ts`)

1. Deps injection middleware on `/*`.
2. `GET /robots.txt` → `text/plain`, body `"User-agent: *\nDisallow: /\n"`.
3. `GET /healthz` → `{ ok: true }` (liveness; touches nothing).
4. `GET /readyz` → `{ ok: true }`, or `503 { ok: false, error }` if `select 1` fails.
5. Security headers on `/api/*` (after next): `X-Content-Type-Options: nosniff`,
   `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`,
   `Strict-Transport-Security: max-age=31536000; includeSubDomains`. No CSP on API.
6. Rate limit `auth-signin` 20/600s per-IP on `POST /api/auth/sign-in/email`
   (Go: the Limen equivalent path `POST /api/auth/signin/credential`).
7. Audit middleware on `/api/auth/admin/*` (better-auth admin calls) — in Go the
   admin endpoints are our own and audit directly.
8. Auth handler mounted at `/api/auth/*`.
9. `apiKeyAuth` then `sessionMiddleware` on `/api/*`.
10. `requireFamily` on `/api/*`; `requireAdmin` on `/api/invites*`, `/api/keys*`;
    `rejectApiKey` on `/api/push/*`.
11. `requireSession` on `/api/openapi.json` + `/api/docs` (Scalar).
12. `requireSysadmin` on `/api/admin/*`.
13. Public invite routes are mounted BEFORE the family gate.
14. Any unmatched `/api/*` → `404 {error:"Not found", code:"NOT_FOUND"}`.
15. Validation failures → `400 {error:"Invalid request", code:"VALIDATION", issues:[{path,message}]}`.

Error envelope everywhere: `{error: string, code: string}`.

### babies.ts

| Method | Path | Shape |
|---|---|---|
| GET | `/api/babies` | → `Baby[]` `{id, name, birthDate, sex}` |
| POST | `/api/babies` | `{name, birthDate, sex?}` → `201 Baby` (402 multipleBabies gate REMOVED in Go) |
| PATCH | `/api/babies/{id}` | `{name?, birthDate?, sex?}` → `Baby` / 404 |
| DELETE | `/api/babies/{id}` | → `{ok:true}`; 403 unless memberRole admin/owner; cascades logs |
| GET | `/api/family/members` | → `Member[]` `{memberId, userId, name, email, role, image}` |
| GET | `/api/family` | → `{id, name, slug, plan}` / 404 |

`sex` is `girl|boy`, nullable.

### feeds.ts

| Method | Path | Shape |
|---|---|---|
| GET | `/api/feeds?babyId&limit(1..200)` | → `FeedLog[]` newest first |
| POST | `/api/feeds` | `{babyId, time, type: bottle\|breast\|solids, amountMl?, side?: left\|right\|both, durationMin?, leftMin?, rightMin?, notes?}` → `201` / 404 unknown baby |
| PATCH | `/api/feeds/{id}` | partial (nullable clears) → `FeedLog` / 404 |
| DELETE | `/api/feeds/{id}` | → `{ok:true}` / 404 |

`FeedLog = {id, babyId, caretakerId, caretakerName, notes, time, type, amountMl, side, durationMin, leftMin, rightMin}`.
All log responses include `caretakerName` (join to user).

### diapers.ts

Same skeleton; `type: wet|dirty|both`; GET/POST/PATCH/DELETE at `/api/diapers`.

### sleep.ts (owns /api/summary)

| Method | Path | Shape |
|---|---|---|
| GET | `/api/sleep?babyId&limit` | → `SleepLog[]` |
| POST | `/api/sleep` | `{babyId, startTime, endTime?, location?, notes?}` → 201; 404; **409 ALREADY_ACTIVE** (pre-check + unique-violation catch on partial index) |
| GET | `/api/sleep/active?babyId` | → `SleepLog \| null` |
| POST | `/api/sleep/{id}/wake` | optional `{endTime?}` (default now) → `SleepLog` / 404 |
| PATCH | `/api/sleep/{id}` | `{startTime?, endTime?(nullable), location?, notes?}` → 200 / 404 |
| DELETE | `/api/sleep/{id}` | → `{ok:true}` / 404 |
| GET | `/api/summary?babyId&tz(-840..840, default 0)` | → `Summary` / 404 |

`Summary = {lastFeed, lastDiaper, activeSleep, lastSleep, activePlay, today:{feeds,intakeMl,solidsG,wet,dirty,both,sleepMin}}`.
`tz` = caller's `getTimezoneOffset()` minutes; today window computed as `dayIdx*DAY + tzMs`.

### sleep-locations.ts

| Method | Path | Shape |
|---|---|---|
| GET | `/api/sleep-locations` | → `{id,name}[]` |
| POST | `/api/sleep-locations` | `{name: 1..40 trimmed}` → 201; 403 API key; 403 non-admin; 409 duplicate (vs `DEFAULT_LOCATIONS = ["crib","stroller","arms","contact nap"]`, case-insensitive) or `MAX_CUSTOM_LOCATIONS = 20` |
| DELETE | `/api/sleep-locations/{id}` | → `{ok:true}`; 403 API key/non-admin; 404 |

### other-logs.ts — makeLogRoutes factory (24 routes)

Per kind: `GET /api/{base}?babyId&limit`, `POST /api/{base}` → 201/404,
`PATCH /api/{base}/{id}` → 200/404, `DELETE /api/{base}/{id}` → `{ok:true}`/404.
All previously-gated creates become free in Go.

| base | Extra create fields (beyond `{babyId, time, notes?}`) |
|---|---|
| `medicine` | `name (1..100)`, `amount? (0..1000)`, `unit?: ml\|mg\|drops\|dose` |
| `baths` | — |
| `notes` | `content (1..2000)` |
| `milestones` | `title (1..200)` |
| `measurements` | `type: weight\|length\|head`, `value (0..200)` |
| `pumps` | `side?`, `amountMl? (0..1000)`, `durationMin? (0..600)` |

### play.ts

| Method | Path | Shape |
|---|---|---|
| GET | `/api/play?babyId&limit` | → `PlayLog[]` |
| GET | `/api/play/active?babyId` | → `PlayLog \| null` |
| POST | `/api/play` | `{babyId, type: tummy\|walk\|play, startTime, endTime?, notes?}` → 201; 404; **409 ALREADY_ACTIVE** |
| POST | `/api/play/{id}/stop` | optional `{endTime?}` → `PlayLog` / 404 |
| PATCH | `/api/play/{id}` | partial → 200 / 404 |
| DELETE | `/api/play/{id}` | → `{ok:true}` / 404 |

### vaccines.ts (+ files)

Dismissal routes registered BEFORE `/api/vaccines/{id}` (so "dismissals" is not an id).

| Method | Path | Shape |
|---|---|---|
| GET | `/api/vaccines/dismissals?babyId` | → `{id, babyId, slotKey}[]` |
| POST | `/api/vaccines/dismissals` | `{babyId, slotKey (1..60)}` → 201 (idempotent on unique) / 404 |
| DELETE | `/api/vaccines/dismissals/{id}` | → `{ok:true}` / 404 |
| GET | `/api/vaccines?babyId&limit` | → `VaccineLog[]` (documents as `{…, url: "/api/files/{docId}"}`) |
| POST | `/api/vaccines` | `{babyId, time, name (1..120), doseNumber?, scheduleSlot?, notes?}` → 201 / 404 |
| PATCH | `/api/vaccines/{id}` | partial → 200 / 404 |
| DELETE | `/api/vaccines/{id}` | → `{ok:true}`; also deletes stored objects for attached docs |
| POST | `/api/vaccines/{id}/documents` | multipart `file`. `DOCUMENT_UPLOADS_ENABLED = false` → always `403 FEATURE_DISABLED`. Behind the flag: 404 unknown entry, 400 TOO_MANY (>5), 400 NO_FILE, 415 BAD_TYPE (jpeg/png/webp/heic/heif/pdf), 413 TOO_LARGE (>10 MiB). Key = `vaccine-docs/{familyId}/{uuid}` |
| GET | `/api/files/{id}` | streams `storage.GetStream(objectKey)`; headers: `content-type`, `content-length`, `content-disposition: attachment; filename="…"` (quotes stripped; never inline), `cache-control: private, max-age=3600`, `x-content-type-options: nosniff`. 404 row-missing or object-missing (check existence BEFORE streaming) |
| DELETE | `/api/files/{id}` | → `{ok:true}`; deletes object |

### timeline.ts

`GET /api/timeline?babyId&before&limit(1..100, default 50)&filter` →
`{entries: TimelineEntry[], nextCursor: string|null}` / 404.

- `before` regex `^\d{1,15}\|.{1,64}$` — keyset cursor `"<epochMs>|<id>"`.
- `filter` ∈ `feeds|diapers|sleep|other`; omitted = everything.
- Merges 11 sources: feeds, diapers, sleeps, medicine, bath, note, milestone,
  measurement, pump, play, vaccines. Sleep/play sort key is `startTime`; rest `time`.
- Sort `(time DESC, id DESC)`; `hasMore` when merged > page OR any single
  source returned exactly `limit`.
- Entry shape: `{kind, id, time, endTime?, …kind fields, caretakerName}`.

### calendar.ts

| Method | Path | Shape |
|---|---|---|
| GET | `/api/calendar/events?from&to` (ISO with offset) | → `CalendarEvent[]`; 400 `INVALID_RANGE` when `to <= from` or span > 366 days |
| POST | `/api/calendar/events` | `{title(1..200), description?, location?, category (default "other"), startTime, allDay (default false), durationMin?(5..1440), remindMinutesBefore?(15..10080), babyIds[] ≤10, assigneeUserIds[] ≤20}` → 201; 400 `INVALID_REFERENCE` |
| PATCH | `/api/calendar/events/{id}` | partial; effective allDay clears durationMin; changing startTime/remindMinutesBefore resets `remindedAt = null` → 200 / 400 / 404 |
| DELETE | `/api/calendar/events/{id}` | → `{ok:true}` / 404 |

`refsValid()` verifies every babyId/userId belongs to the family (join tables
carry no familyId). Ids deduped before insert (pair PK). Category ∈
`doctor|vaccination|babysitting|family|other`.

### contacts.ts

| Method | Path | Shape |
|---|---|---|
| GET | `/api/contacts` | → `Contact[]` (ordered by name) `{id,name,role,icon,phone,email,website,notes,babies[]}` |
| POST | `/api/contacts` | `{name(1..100), role?, icon?, phone?, email?, website?, notes?, babyIds[] ≤10}` → 201; 400 `INVALID_REFERENCE` |
| PATCH | `/api/contacts/{id}` | partial; `babyIds` present ⇒ replaces link set → 200 / 400 / 404 |
| DELETE | `/api/contacts/{id}` | → `{ok:true}` / 404 |

Icon enum: `user|doctor|nurse|hospital|dental|family|grandparent|daycare|friend|phone`.

### stats.ts

`GET /api/stats?babyId&days(1..90, default 7)&tz` → `Stats` / 404 (days>7 gate REMOVED).
`Stats = {days:[{date,sleepMin,intakeMl,feeds,diapers}], avgSleepMin, avgIntakeMl, avgFeeds, avgDiapers, weight:{value,time,prevValue,prevTime}|null}`.
Sleep sessions split across local midnights; active sessions counted up to now.

### export.ts

`GET /api/export.csv` → `text/csv; charset=utf-8`,
`content-disposition: attachment; filename="pjokk-export-YYYY-MM-DD.csv"`.
Columns: `kind, baby, time, end_time, type, detail, amount, unit, side, duration_min, value, location, caretaker, notes`.
All 11 sources, MAX 100_000 each, ascending. `esc()` guards CSV formula
injection: cell matching `^[=+\-@\t\r]` prefixed with `'`. Never gated (GDPR).

### push.ts (all behind rejectApiKey)

| Method | Path | Shape |
|---|---|---|
| GET | `/api/push/config` | → `{publicKey}` |
| POST | `/api/push/subscribe` | `{endpoint (≤1000, url), p256dh, auth}` → `{ok:true}`; 400 `BAD_ENDPOINT` unless https + host suffix ∈ `fcm.googleapis.com`, `push.apple.com`, `push.services.mozilla.com`, `mozaws.net`, `notify.windows.com`. Upsert on endpoint |
| POST | `/api/push/unsubscribe` | `{endpoint}` → `{ok:true}` (own rows only) |
| GET | `/api/push/prefs` | → `{feedReminderHours: 0\|3\|4\|6}` |
| PUT | `/api/push/prefs` | `{feedReminderHours}` → same; resets `lastRemindedAt = null` |
| POST | `/api/push/test` | → `{sent: number}` |

### keys.ts (behind requireAdmin; apiKeys gate REMOVED)

| Method | Path | Shape |
|---|---|---|
| POST | `/api/keys` | `{name(1..60), expiresInDays?(1..3650), readOnly (default false)}` → `201 {id,name,prefix,createdAt,lastUsedAt,revokedAt,expiresAt,readOnly,key}` — full key shown once |
| GET | `/api/keys` | → `ApiKey[]` (no `key`) |
| DELETE | `/api/keys/{id}` | → `{ok:true}` / 404 |

Key format `pjk_` + random; stored as SHA-256 hex in `key_hash`; `prefix` is
the displayable head (e.g. `pjk_ab12…`).

### invites.ts

Admin-scoped (requireAdmin):

| Method | Path | Shape |
|---|---|---|
| POST | `/api/invites` | optional `{role (default "member"), expiresInHours (default 72, 1..720), maxUses (default 5, 1..50)}` → `201 Invite {code, familyId, role, expiresAt, maxUses, usedCount, revokedAt, url: "{appUrl}/join/{code}"}` |
| GET | `/api/invites` | → `Invite[]` |
| DELETE | `/api/invites/{code}` | → `{ok:true}` / 404 |

Public (mounted BEFORE family gate):

| Method | Path | Rate limits |
|---|---|---|
| GET | `/api/invites/info/{code}` | `invite-info` 30/600s ip + `invite-info-global` 500/600s global → `{valid, familyName, role, reason: revoked\|expired\|exhausted\|not_found \| null}` |
| POST | `/api/invites/redeem` | `invite-redeem` 10/600s ip + `invite-redeem-global` 200/600s global. `{code (1..64)}` → `{familyId, familyName, role, alreadyMember}`; 400 invalid; 401 not signed in |

Redeem: real transaction, `SELECT … FOR UPDATE` on invite row, re-check
validity + membership inside the lock, insert member, increment usedCount,
best-effort set active organization. Codes uppercased on both endpoints.

### admin.ts (behind requireSysadmin = `user.role == "admin"`)

| Method | Path | Shape |
|---|---|---|
| GET | `/api/admin/stats` | → `{families, users, babies, coreLogs, pushSubscriptions, usersLast7d}` |
| GET | `/api/admin/families` | → `[{id,name,slug,plan,createdAt,members,babies,lastFeedAt}]` |
| DELETE | `/api/admin/families/{id}` | → `{ok:true}` / 404; audits `family.delete`; deletes organization (cascades). (Stripe cancel/subscription rows GONE in Go) |
| POST | `/api/admin/families/{id}/plan` | REMOVED in Go (billing gone) |
| POST | `/api/admin/users/{id}/delete` | → `{ok:true}`; 400 REFUSED for self or tombstone; 404. Reassigns caretakerId on 9 log tables + familyInvite.createdBy + apiKey.createdBy (and revokes keys) + adminAudit.adminId + calendarEvent.createdBy to `user_tombstone`; deletes calendarAssignee rows; audits `user.delete`; deletes user (cascades) |
| GET | `/api/admin/audit` | → last 100 `{id, adminId, adminName, action, target, detail, createdAt}` |
| POST | `/api/admin/audit` | `{action(1..60), target(1..200), detail?(≤500)}` → `{ok:true}` |

**NEW in Go** (replacing better-auth admin-plugin client calls the frontend
makes today — `authClient.admin.listUsers/banUser/unbanUser/setUserPassword/revokeUserSessions/impersonateUser`):

| Method | Path | Shape |
|---|---|---|
| GET | `/api/admin/users?query&limit` | → `[{id,name,email,role,banned,banReason,createdAt}]` |
| POST | `/api/admin/users/{id}/ban` | `{reason?}` → `{ok:true}`; revokes all sessions; audits |
| POST | `/api/admin/users/{id}/unban` | → `{ok:true}`; audits |
| POST | `/api/admin/users/{id}/password` | `{password (8..128)}` → `{ok:true}`; audits |
| POST | `/api/admin/users/{id}/sessions/revoke` | → `{ok:true}`; audits |
| POST | `/api/admin/users/{id}/impersonate` | → `{ok:true}`; swaps session cookie to a session for the target with `impersonated_by` + admin token in metadata; audits |
| POST | `/api/admin/stop-impersonating` | → `{ok:true}`; restores the admin session cookie |

Plus **`GET /api/me`** (session info for the SPA shell, replaces scattered
better-auth session casts): `{userId, name, email, role, familyId, memberRole, plan, impersonatedBy}`
(familyId/memberRole/plan null when no active family; requires session only).

**NEW in Go** (replacing `authClient.organization.removeMember/updateMemberRole`):

| Method | Path | Shape |
|---|---|---|
| DELETE | `/api/family/members/{memberId}` | → `{ok:true}`; requireAdmin; 404; 400 CANNOT_REMOVE_SELF-equivalent guards as better-auth had |
| POST | `/api/family/members/{memberId}/role` | `{role: admin\|member}` → `{ok:true}`; requireAdmin; 404 |

## A2. Database schema (Go version)

Conventions: `id text PK` default generated UUID (Go generates
`uuid.NewString()`; DB default `gen_random_uuid()::text` acceptable),
`family_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`,
all instants `timestamptz`, `created_at timestamptz NOT NULL DEFAULT now()`.

### Auth tables (Limen-shaped, with our additional fields)

- `users`: Limen columns (`id`, `public_id`, `first_name`, `last_name`,
  `email` UNIQUE, `password`, `email_verified_at`, `created_at`,
  `updated_at`, `deleted_at`) + additional fields: `name text`, `image text`,
  `role text` (`"admin"` = sysadmin), `banned boolean NOT NULL DEFAULT false`,
  `ban_reason text`.
- `sessions`: Limen columns (`user_id`, `token`, `created_at`, `expires_at`,
  `last_access`, `metadata`) + org plugin's `active_organization_id`.
- `accounts`, `verifications`, `rate_limits` (Limen's own): per Limen schema.
- `organizations`: Limen columns (`name`, `user_id`, `slug`, `logo`,
  `metadata`) + additional field `plan text NOT NULL DEFAULT 'free'`.
- `organization_members`, `organization_member_roles`, `organization_roles`,
  Limen invitations table: per Limen schema (email invitations unused; our
  `family_invite` is the real mechanism).

Exact Limen DDL is produced once with `limen generate migrations` against a
dev database and committed as goose migrations (see plan Task 2).

### Domain tables (ported verbatim, names/types/indexes preserved)

- `baby(id, family_id, name NN, birth_date timestamptz NN, sex CHECK IN ('girl','boy') NULL, created_at)`; idx `baby_family_idx(family_id)`.
- `api_key(id, family_id, name NN, key_hash NN UNIQUE, prefix NN, created_by → users NN, last_used_at, revoked_at, expires_at, read_only bool NN DEFAULT false, created_at)`; idx family.
- `sleep_log(id, family_id, baby_id → baby CASCADE NN, caretaker_id → users NN, start_time NN, end_time NULL, location, notes, created_at)`; idx `(family_id, start_time)`, `(baby_id)`; **partial UNIQUE `sleep_one_active_per_baby(baby_id) WHERE end_time IS NULL`**.
- `feed_log(…, time NN, type CHECK bottle/breast/solids NN, amount_ml int, side CHECK left/right/both, duration_min int, left_min int, right_min int, notes)`; idx `(family_id,time)`, `(baby_id)`.
- `diaper_log(…, time NN, type CHECK wet/dirty/both NN, notes)`.
- `medicine_log(… + name NN, amount double precision, unit CHECK ml/mg/drops/dose)`.
- `bath_log` (base), `note_log(+ content NN)`, `milestone_log(+ title NN)`,
  `measurement_log(+ type CHECK weight/length/head NN, value double precision NN)`,
  `pump_log(+ side CHECK, amount_ml int, duration_min int)` — each with `(family_id, time)` index.
- `play_log(id, family_id, baby_id CASCADE, caretaker_id, type CHECK tummy/walk/play NN, start_time NN, end_time NULL, notes, created_at)`; **partial UNIQUE `play_one_active_per_baby(baby_id) WHERE end_time IS NULL`**.
- `vaccine_log(…, time NN, name NN, dose_number int, schedule_slot text, notes)`.
- `vaccine_document(id, family_id, vaccine_log_id → vaccine_log CASCADE NN, object_key NN, filename NN, content_type NN, size int NN, uploaded_by → users NN, created_at)`.
- `vaccine_dismissal(id, family_id, baby_id CASCADE, slot_key NN, dismissed_by → users NN, created_at)`; **UNIQUE `(baby_id, slot_key)`**.
- `push_subscription(id, family_id, user_id → users CASCADE NN, endpoint NN UNIQUE, p256dh NN, auth NN, created_at)`.
- `push_pref(user_id → users CASCADE NN, family_id, feed_reminder_hours int NN DEFAULT 0, last_reminded_at)`; **PK `(user_id, family_id)`**.
- `admin_audit(id, admin_id → users NN, action NN, target NN, detail, created_at)`; idx `(created_at)`. Append-only.
- `family_invite(code text PK, family_id, role CHECK admin/member NN, expires_at NN, max_uses int NN, used_count int NN DEFAULT 0, revoked_at, created_by → users NN, created_at)`.
- `sleep_location(id, family_id, name NN, created_at)`.
- `contact(id, family_id, name NN, role, icon CHECK …, phone, email, website, notes, created_at)`.
- `contact_baby(contact_id → contact CASCADE, baby_id → baby CASCADE)`; **PK pair**. Zero rows = family-wide.
- `calendar_event(id, family_id, created_by → users NN, title NN, description, location, category CHECK NN DEFAULT 'other', start_time NN, all_day bool NN DEFAULT false, duration_min int, remind_minutes_before int, reminded_at, created_at)`; idx `(family_id, start_time)`.
- `calendar_event_baby(event_id CASCADE, baby_id CASCADE)` PK pair;
  `calendar_assignee(event_id CASCADE, user_id → users NO CASCADE)` PK pair.
- `rate_limit(key text PK, count int NN DEFAULT 0, expires_at NN)`; idx `(expires_at)`. Ours, distinct from Limen's `rate_limits`.
- Tombstone: `TOMBSTONE_ID = "user_tombstone"`, name "Deleted user", email
  `deleted@pjokk.invalid`, banned, inserted `ON CONFLICT DO NOTHING` at startup.

Dropped vs. TS: `subscription` table, `passkey` table, `stripe_customer_id`
columns, better-auth `invitation` (Limen has its own; unused).

## A3. Environment variables (Go internal/config)

| Var | Type | Default | Required |
|---|---|---|---|
| `DATABASE_URL` | string | — | yes |
| `APP_URL` | url | — | yes |
| `SITE_URL` | url | `https://pjokk.no` | no |
| `AUTH_SECRET` | string ≥32 bytes | — | yes (renamed from BETTER_AUTH_SECRET; Limen wants 32 bytes) |
| `STORAGE_DRIVER` | `s3` \| `fs` | — | yes |
| `S3_BUCKET`/`S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` | string | — | required when driver=s3 |
| `S3_REGION` | string | `auto` | no |
| `STORAGE_FS_PATH` | string | — | required when driver=fs |
| `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` | string | `""` | no |
| `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` | string | `""` | no |
| `OPEN_SIGNUP` | `0`\|`1` | `0` | no |
| `PORT` | int > 0 | `3000` | no |
| `TRUSTED_PROXY_HOPS` | int ≥ 0 | `0` | no |

Removed: all `STRIPE_*`, `STATIC_DIR` (SPA is embedded), `MIGRATIONS_DIR`
(migrations embedded). Config load reports **all** invalid fields at once.
`DisabledSubsystems()` returns names: "Google sign-in" (either Google var
empty), "web push" (either VAPID var empty).

## A4. Dispatch modes & cron

`pjokk <mode>` (argv[1]):

| Mode | Behavior |
|---|---|
| *(none)* | applyMigrations (advisory lock) → serve + scheduler |
| `server` | HTTP only; NO migration, NO scheduler |
| `worker` | scheduler only + minimal `/healthz` on PORT |
| `migrate` / `migrations` | run migrations, exit 0/1 |
| `cron <nightly\|frequent>` | one job, exit 0/1; bad job → usage + exit 2 |
| `healthcheck` | GET `http://127.0.0.1:PORT/healthz`, exit 0/1 |
| other | `Unknown dispatch mode: "…"`, exit 2 |

- `MIGRATION_LOCK_KEY = 72450001` — MUST NEVER CHANGE. Dedicated single
  connection (`pg_advisory_lock` is per-session), unlock + close in defer.
- Schedules (UTC): nightly `15 3 * * *`, frequent `*/15 * * * *`.
- **nightly**: runBackup → pruneBackups → purgeOrphanUsers → rateLimit.Sweep.
  (reconcilePlans GONE.)
- **frequent**: runReminders → runCalendarReminders.
- Each job wrapped in recover/log — a panicking job must not kill the process.
- Graceful shutdown on SIGTERM/SIGINT: stop scheduler, drain server, exit 0.

## A5. Middleware & tenancy

1. **sessionMiddleware** — resolve Limen session once per request into
  context; never rejects.
2. **requireFamily** — 401 `UNAUTHENTICATED` no session; 403 `NO_FAMILY` no
  active org; join members×organizations — missing row → 403 `NOT_MEMBER`;
  sets familyId, memberRole, plan in context. If impersonated and method not
  GET/HEAD, write `impersonated.write` audit row (target = user id, detail =
  `"METHOD path"`), errors swallowed.
3. **requireAdmin** — 403 for API keys; 403 unless memberRole ∈ {admin, owner}.
4. **requireSysadmin** — 401 no session; 403 API key; 403 unless user role
  `admin`. Helper `audit(adminID, action, target, detail?)`.
5. **apiKeyAuth** — only on `Authorization: Bearer pjk_…`. SHA-256 the token,
  join api_key×users×organizations where hash matches and revoked_at IS NULL.
  401 `INVALID_KEY`, 401 `KEY_EXPIRED`, 403 `READ_ONLY_KEY` for non-GET/HEAD.
  On success: synthetic session (familyId from the key), flag apiKeyAuth,
  update last_used_at at most once per 5 min. (402 apiKeys gate GONE.)
6. **rejectApiKey** — 403 `FORBIDDEN` when apiKeyAuth flag set.
7. **clientIp(forwardedFor, socketAddr, trustedHops)** — hops ≤ 0 ⇒ ignore
  XFF entirely; else pick from the right (`len(chain) - hops`, floored at 0);
  fall back socket, then `"unknown"`.
8. **rateLimit(name, limit, windowSeconds, scope ip|global)** — bucket =
  hex(sha256(ip))[:32] or "global"; key `rl:{name}:{bucket}:{window}`,
  window = floor(unix/windowSeconds). One atomic
  `INSERT … ON CONFLICT DO UPDATE SET count = rate_limit.count + 1 RETURNING count`.
  Over → `429 {error:"Too many attempts, try again later", code:"RATE_LIMITED"}`.

Rate-limit points: `auth-signin` 20/600 ip (on Limen's credential sign-in
path), `invite-info` 30/600 ip + `invite-info-global` 500/600 global,
`invite-redeem` 10/600 ip + `invite-redeem-global` 200/600 global.

## A6. Ports (Go)

```go
type StoredObject struct { Key string; UploadedAt time.Time }

type Storage interface {
    Put(ctx context.Context, key string, body io.Reader, size int64, contentType string) error
    GetStream(ctx context.Context, key string) (io.ReadCloser, bool, error) // (rc, found, err)
    Delete(ctx context.Context, keys ...string) error
    List(ctx context.Context, prefix string) ([]StoredObject, error)
}

type RateLimitStore interface {
    Hit(ctx context.Context, key string, windowSeconds int) (int, error)
    Sweep(ctx context.Context, now time.Time) (int, error)
}

type PushPayload struct { Title, Body, URL string }

type PushSender interface {
    ToUser(ctx context.Context, userID string, p PushPayload) (int, error)
}

type Clock func() time.Time
```

## A7. Jobs

### Backup

`BACKUP_TABLES` — ordered, hard-coded; Go list (billing/passkey tables and
better-auth spellings replaced by the Go schema):
`users, sessions, accounts, verifications, organizations, organization_members,
organization_member_roles, organization_roles, baby, feed_log, diaper_log,
sleep_log, medicine_log, bath_log, note_log, milestone_log, measurement_log,
pump_log, play_log, vaccine_log, vaccine_document, vaccine_dismissal,
family_invite, sleep_location, contact, contact_baby, calendar_event,
calendar_event_baby, calendar_assignee, push_subscription, push_pref, api_key,
admin_audit` (+ Limen's invitations table under its actual name).
`SELECT * FROM "<t>"` per table; `users.password` (and account tokens' secret
columns if present) nulled; write `backups/YYYY-MM-DD.json` as
`{exportedAt, tables: {name: rows[]}}`. `BACKUP_RETENTION_DAYS = 30`;
prune parses `^backups/(\d{4}-\d{2}-\d{2})\.json$`, falls back to UploadedAt.
A schema-sync test asserts every `pg_tables` row is either backed up or in
`DELIBERATELY_EXCLUDED = {rate_limit, rate_limits, goose_db_version}`.

### Feed reminders

Prefs with `feed_reminder_hours > 0`; per pref `max(feed_log.time)` for the
family; skip if none. Send when `gap >= hours` AND NOT
(`last_reminded_at != null && last_reminded_at >= lastFeed`). Payload
`{title:"Pjokk", body:"No feed logged for {h} h", url:"/home"}`. Stamp
`last_reminded_at = now`.

### Calendar reminders

1. Grace latch: `UPDATE calendar_event SET reminded_at = now WHERE
   remind_minutes_before IS NOT NULL AND reminded_at IS NULL AND
   start_time < now - interval '1 hour'`.
2. Due: pending, `start_time >= now - 1h`,
   `start_time - (remind_minutes_before * interval '1 minute') <= now`.
3. Targets: assignees, else every family member.
4. Body: title when allDay, else `"{title} · {HH:mm}"` in Europe/Oslo 24h.
   URL `/calendar`.
5. Latch reminded_at even when every delivery failed.

### purgeOrphanUsers

Delete users where (`role IS NULL OR role NOT IN ('admin')`), id != tombstone,
`created_at < now - 7 days`, no membership rows. FK-blocked deletes swallowed.
Log id only, never email.

## A8. Frontend integration points

- `apps/frontend/src/lib/api.ts` — replace hono `hc` with `openapi-fetch`
  client; keep exports `API_BASE`, `ApiError{status,message,code}`, `unwrap`.
- `apps/frontend/src/lib/auth-client.ts` — replace better-auth client with
  `limen-auth` (`createAuthClient` from `limen-auth/react`, plugins
  `credentialPasswordPlugin`, `organizationPlugin`; `basePath: "/api/auth"`).
- Data layer files importing the API client: `lib/data/{calendar,contacts,family,insights,logs,other,play,sleep-locations,vaccines}.ts`, sheets `BabySheet/ContactSheet/VaccineSheet`, screens `admin/{Audit,Families,Overview,Users}`, `Join`, `settings/{ApiKeysSection,BillingSection,FamilySection,index,NotificationsSection}`, `WelcomePlan`, `Welcome`.
- better-auth call sites to rewrite: `Login` (signIn.email → auth.signIn
  credential, signIn.social), `Join` (social + setActive → organization.switch),
  `Welcome` (organization.create/setActive, signOut), `shell` + `admin/shell`
  (useSession; impersonation banner now from `GET /api/me`),
  `settings/index` (signOut), `settings/FamilySection`
  (removeMember/updateMemberRole → new `/api/family/members/*` endpoints),
  `admin/Users` (admin.* → new `/api/admin/users*` endpoints), `Home` (useSession).
- Billing removal: delete `settings/BillingSection.tsx`, `WelcomePlan.tsx`;
  strip `stripeClient` from auth-client; `usePremium()` → constant true (keep
  hook, one-line body — call sites untouched); remove `PLAN_REQUIRED` 402
  special-casing in `lib/data/calendar.ts`, `lib/data/other.ts`,
  `BabySheet.tsx`, `ContactSheet.tsx`; simplify plan-conditioned rendering in
  `Stats.tsx`, `Calendar.tsx`, `settings/BabiesSection.tsx`,
  `settings/ContactsSection.tsx`, `OtherLogSheet.tsx`, `BabySwitcher.tsx`,
  `TabBar.tsx`, `admin/Families.tsx`; Welcome flow loses the plan step.
- Landing copy `apps/landing/src/copy.ts` lines about "Premium" → rewrite.

## A9. Static serving & headers (Go internal/web)

Non-`/api` responses get: `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: same-origin`,
`Strict-Transport-Security: max-age=31536000; includeSubDomains`,
`Permissions-Policy: camera=(), microphone=(), geolocation=()`,
`X-Robots-Tag: noindex, nofollow`, CSP:
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`.
Serve embedded SPA assets; unmatched non-API path → embedded `index.html`
(200); unmatched `/api/*` → JSON 404. `/robots.txt` → `Disallow: /`.
`/api/docs` → embedded Scalar page referencing `/api/openapi.json` (spec
embedded); both require a session.

## A10. Test suite map (port targets)

From `apps/api/test/` (bun:test → Go tests, same coverage):
admin, api-keys, backup-tables, backup, calendar-reminders, calendar,
contacts, defects (empty-PATCH no-op; timeline same-timestamp pagination;
case-insensitive invite codes; DB-enforced single active sleep),
entitlement-rework (now: previously-gated actions succeed on free),
feedback-batch (per-side nursing minutes, summary today block, custom sleep
locations), household (multi-baby, member management, self-serve family
creation), invites, other-logs, play, push, security, sleep, stats (+ csv
export), tenancy (no crafted request crosses family boundaries), timeline,
vaccines. From `apps/server/test/`: config (all-problems-at-once, defaults),
migrate (advisory lock genuinely blocks a second connection — verified via
`pg_stat_activity`, not a sleep).
Dropped: app-type (TS-only), billing (feature gone — replaced by
free-tier-open assertions).
Harness: real Postgres `TEST_DATABASE_URL` (default
`postgres://pjokk:pjokk@127.0.0.1:55432/pjokk_test`), truncate all tables
between tests, in-memory Storage, per-package isolation.

---

# Part B — Limen Integration (source-verified, v0.2.1)

## B1. Modules

- Core `github.com/thecodearcher/limen` v0.2.1, Go 1.25+, MIT.
- Separate modules: `…/adapters/sql`, `…/plugins/credential-password` v0.2.0,
  `…/plugins/oauth`, `…/plugins/oauth-google`, `…/plugins/organization` v0.1.0,
  `…/plugins/api-key`, `…/plugins/session-jwt`, `…/cmd/limen` (CLI).
- TS client: npm `limen-auth` v0.1.1 (`limen-auth/react`, `limen-auth/plugins`).

## B2. Construction (the shape we use)

```go
import (
    "database/sql"
    "github.com/jackc/pgx/v5/stdlib" // registers "pgx" driver
    "github.com/thecodearcher/limen"
    sqladapter "github.com/thecodearcher/limen/adapters/sql"
    credentialpassword "github.com/thecodearcher/limen/plugins/credential-password"
    "github.com/thecodearcher/limen/plugins/oauth"
    oauthgoogle "github.com/thecodearcher/limen/plugins/oauth-google"
    "github.com/thecodearcher/limen/plugins/organization"
)

sqlDB := stdlib.OpenDBFromPool(pool) // share the pgx pool
auth, err := limen.New(&limen.Config{
    BaseURL:  cfg.AppURL,
    Database: sqladapter.NewPostgreSQL(sqlDB),
    Secret:   []byte(cfg.AuthSecret), // 32 bytes
    HTTP: limen.NewDefaultHTTPConfig(
        limen.WithHTTPBasePath("/api/auth"),      // REQUIRED: router matches full path, no prefix strip
        limen.WithHTTPDisabledPaths("signup"),    // closed signup (skip when OPEN_SIGNUP=1)
    ),
    Plugins: []limen.Plugin{
        credentialpassword.New(),
        oauth.New(oauth.WithProviders(oauthgoogle.New(
            oauthgoogle.WithClientID(cfg.GoogleClientID),
            oauthgoogle.WithClientSecret(cfg.GoogleClientSecret),
        ))),
        organization.New(),
        newCorePlugin(), // ours: captures *limen.LimenCore for impersonation
    },
})
mux.Handle("/api/auth/", auth.Handler())
```

Google callback URL: `{APP_URL}/api/auth/oauth/google/callback`.
Cookie: `limen_session`, Path=/, Secure, HttpOnly, SameSite=Lax.
Sign-in path: `POST /api/auth/signin/credential` (rate-limit target).
CSRF + origin checks default-on; BaseURL auto-trusted (same-origin fits).
Check what Limen's `rate_limits.key` stores — if raw IPs, replace via
`WithHTTPRateLimiter` with a hashed-key implementation (EU/GDPR rule: never
store raw client addresses).

## B3. Server-side APIs (verified signatures)

- `auth.GetSession(r *http.Request) (*limen.ValidatedSession, error)`;
  `ValidatedSession{User *User; Session *Session; Refreshed *SessionResult}`.
- `Session{ID any; Token string; UserID any; CreatedAt, ExpiresAt, LastAccess time.Time; Metadata map[string]any}`.
- `User{ID any; Email string; Password *string; EmailVerifiedAt *time.Time}` —
  name/image/role/banned are OUR additional fields via
  `limen.WithSchemaUser(limen.WithUserAdditionalFields(...))`; read them from
  our own `users` queries (sqlc), not from the Limen struct.
- `auth.RevokeSession(ctx, token)`, `auth.RevokeAllSessions(ctx, userID)`,
  `auth.ListSessions(ctx, userID)`.
- Organization plugin (`org := organization.Use(auth)` — panics if not registered):
  `CreateOrganization(ctx, user, &organization.CreateOrganizationRequest{Name, Slug})`,
  `AddMember(ctx, orgID, userID, role)`,
  `GetActiveOrganizationID(ctx, session)`, `SetActiveOrganization(ctx, session, org)`,
  `SwitchOrganization(ctx, session, orgIdentifier)`,
  `RemoveMember(ctx, user, org, memberID)`, `AssignMemberRole/RevokeMemberRole`.
- Credential plugin (`cp := credentialpassword.Use(auth)`):
  `SignUpWithCredentialAndPassword(ctx, user *limen.User, additionalFields map[string]any)`,
  `UpdatePassword(ctx, user, current, new, revokeOthers)`,
  `SetPassword(ctx, user, new, revokeOthers)` (admin set-password uses this).
- **Impersonation**: `LimenCore.CreateSession(ctx, r, w, &limen.AuthenticationResult{User: target}, opts...)`
  exists but the core is only reachable from a plugin's
  `Initialize(core *limen.LimenCore) error` — register a one-struct custom
  plugin that stores the pointer. Impersonated session carries
  `metadata: {"impersonated_by": adminID, "admin_token": adminSessionToken}`;
  stop-impersonating restores the admin cookie from `admin_token` and revokes
  the impersonated session.
- **No user deletion API** — admin delete stays hand-rolled SQL (as today).

## B4. Schema & migrations

Limen does NOT auto-migrate. With `Config.CLI` enabled the app writes
`./.limen/schemas.json`; `go install github.com/thecodearcher/limen/cmd/limen@latest`
then `limen generate migrations --driver postgres --dsn …` emits up/down SQL.
We run this ONCE in development, review, and commit the result as goose
migrations (then our additional-fields columns ride the same migration).
Tables: `users`, `sessions` (+`active_organization_id`), `accounts`,
`verifications`, `rate_limits`, `organizations`, `organization_members`,
`organization_member_roles`, `organization_roles`, invitations, and (unused
by us) `api_keys` if the plugin were registered — it is NOT; our own
`api_key` table remains the only key store.

## B5. TS client (npm `limen-auth`)

```ts
import { createAuthClient } from "limen-auth/react";
import { credentialPasswordPlugin, organizationPlugin } from "limen-auth/plugins";

export const auth = createAuthClient({
  baseURL: API_BASE || window.location.origin,
  basePath: "/api/auth",
  plugins: [credentialPasswordPlugin(), organizationPlugin()],
});
// auth.useSession(); auth.signIn.credential({email,password}); auth.signIn.social({provider:"google", redirectUri});
// auth.signout(); auth.organization.create({name}); auth.organization.switch({id});
// auth.useActiveOrganization(); auth.getSession()
```

Exact `signIn.credential` call shape unverified — confirm against the
package's TypeScript types when installing, adjust Login.tsx accordingly.

## B6. Known risks

1. Org plugin is v0.1.0 (Aug 2026). Pin all Limen modules to exact versions.
2. Base-path examples in the repo are wrong; always set `WithHTTPBasePath`.
3. Isolation rule: only `internal/auth` imports Limen. Everything else
   consumes our own `Session`/`Family` types.
4. Limen rate_limits key contents unverified — inspect, replace if raw IP.
