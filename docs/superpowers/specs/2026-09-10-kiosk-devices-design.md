# Kiosk devices — enrolment and the caretaker selector — Design

**Date:** 2026-09-10
**Status:** Approved design, pending implementation plan
**Series:** 3 of 3 — after the responsive shell (PR #70) and kiosk mode
(PR #71, spec `2026-09-08-kiosk-mode-design.md`). A Google Cast receiver
remains a possible spec 4; it would reuse this spec's device credential.

## Problem

Kiosk mode (spec 2) turned a tablet into the family's care station, but
the tablet still holds a *person's* session: every diaper logged on it is
"by" whoever switched kiosk mode on, the PIN that guards leaving lives in
that browser's localStorage, and the tablet can do anything that person
can — settings, invites, API keys — the moment someone gets past the PIN.
A shared nursery tablet needs to be the *family's*, not a parent's.

## Goals

- A tablet is enrolled as a **device** of one family, with its own
  credential, and holds no person's session.
- A row of avatars says **who is logging**. It is attribution only: it
  grants nothing, and there is no per-person PIN.
- A device can do exactly what the kiosk needs and nothing else.
- Only a family admin can enrol or revoke a device.
- Leaving kiosk mode on the tablet (with the device PIN) un-enrols it.

## Decisions taken in review

| Question | Decision |
|---|---|
| What does the PIN do on an enrolled tablet? | Un-enrols it: the credential is revoked server-side and the tablet lands on sign-in. Re-enrolling needs a new code. An admin can also revoke remotely. |
| How long does a caretaker choice last? | Until the kiosk dims (2 min idle). With nobody chosen, an action first asks "Who's logging?". |
| Does spec 2's per-person kiosk survive? | No. Enrolment is the only way to a kiosk; Preferences → Kiosk mode and the local PIN go away. |
| How does the tablet get its credential? | A one-time code created in Settings → Family → Devices and typed (or QR-opened) on the tablet. The tablet's own request sets the cookie, so it lands in the right cookie jar — an iPad home-screen app does not share Safari's. |

## Non-goals

- Recording *which device* made a log ("by Anne via Kitchen tablet"). It
  would mean a column on every log table for a question nobody has asked.
- Per-caretaker PINs, or a caretaker row that grants any permission.
- A per-device unit preference. The kiosk shows metric (see §6).
- Casting (spec 4), or any kiosk screen beyond spec 2's.
- Editing a device (rename) — revoke and add a new one.

## Design

### 1. The `device` table (migration `00014_device.sql`)

```
device(
  id               text PK default gen_random_uuid()::text,
  family_id        text NOT NULL → organizations ON DELETE CASCADE,
  name             text NOT NULL,           -- "Kitchen tablet", 1..60 chars
  created_by       text NOT NULL → users,
  created_at       timestamptz NOT NULL default now(),
  enrol_code_hash  text,                    -- SHA-256 hex of the one-time code
  enrol_expires_at timestamptz,
  token_hash       text UNIQUE,             -- SHA-256 hex of the device token
  pin_hash         text,                    -- HMAC of the PIN (§3)
  enrolled_at      timestamptz,
  last_used_at     timestamptz,
  revoked_at       timestamptz
)
index device_family_idx (family_id)
unique index device_enrol_code_idx (enrol_code_hash) where enrol_code_hash IS NOT NULL
```

A device is **pending** (code set, no token), **active** (token set, not
revoked) or **revoked**. Every query takes `family_id` except the two that
cannot know it: the redeem lookup by code hash and the per-request lookup
by token hash — the same exception as `GetAPIKeyByHash`, documented at the
query.

- **The code**: 8 characters from the invite-code alphabet (no 0/O/1/I/L),
  valid 15 minutes, stored only as a SHA-256 hash, shown once. A lost or
  expired code is replaced with a new one (pending devices only).
- **The token**: `pjd_` + 40 hex characters of `crypto/rand`, stored as
  SHA-256 — the API-key recipe, and the same reasoning for a fast hash
  (160 random bits; the search space is the defence).
- **Cap**: at most 10 non-revoked devices per family (`409 DEVICE_LIMIT`).
- **Guards that come with a new table**: `device` joins
  `jobs.BackupTables` (it holds only hashes; a restored kiosk keeps
  working, like `api_key`), and — because `created_by` references `users`
  — the user-reassignment code and its guard test map.

### 2. The credential: the `pjokk_device` cookie

- HttpOnly, `SameSite=Lax`, `Path=/`, `Secure` exactly when `APP_URL` is
  https (Limen's rule), `Max-Age` 400 days (the browser maximum).
- Re-issued with a fresh `Max-Age` when `last_used_at` is touched, at most
  once a day. A kiosk in daily use never expires; one idle over 400 days
  must be re-enrolled.
- Not a bearer token in localStorage: avatars and photos load through
  `<img src>`, which cannot send an `Authorization` header, and page script
  cannot read an HttpOnly cookie.

### 3. The PIN

Chosen on the tablet during enrolment and sent **with** the code, so no
device is ever enrolled without one. 4–6 digits. Stored as
HMAC-SHA-256(key, `device-pin:` + token hash + `:` + pin) — the token hash
is unique per device, never changes, and exists before the one-statement
enrolment, where the device id does not — and the key is
derived from `AUTH_SECRET` with its own domain separator in `cmd/pjokk`
and reaches the API through `Deps` — an unkeyed hash of a 6-digit PIN is
reversible instantly. Checked server-side on un-enrol only.

### 4. Request path

**`middleware.DeviceAuth`**, mounted on the whole API after `APIKeyAuth`
and before `Session`:

- No `pjokk_device` cookie → pass through untouched.
- Cookie present, token unknown / revoked / device not enrolled →
  `401 DEVICE_REVOKED`, **and the cookie is cleared** in the same
  response, so the sign-in screen the kiosk lands on does not loop.
- Otherwise establish the identity `{device}`; touch `last_used_at` at
  most every 5 minutes (best-effort, logged on failure), re-issuing the
  cookie at most daily.
- If a request somehow carries both a device cookie and a person's
  session, the device wins. A `pjk_` bearer still wins over both.

**`RequireFamily`** stays the single tenancy gate. For a device identity it
builds `FamilyCtx` from the device instead of a session:

| field | value |
|---|---|
| `FamilyID` | the device's family |
| `UserID`, `UserName` | the caretaker from `X-Pjokk-Caretaker`, or `""` on a read without one |
| `MemberRole` | always `"member"` — choosing yourself grants nothing |
| `IsDevice`, `DeviceID` | new fields |

- A write (non-GET) without the header → `400 CARETAKER_REQUIRED`.
- A header naming someone who is not a member of the device's family →
  `403 NOT_MEMBER` (covers a member removed since the kiosk loaded).
- Every log handler already writes `fam.UserID` as `caretaker_id`, so the
  timeline says "by Anne" with no handler change.

**The allowlist.** A device may call exactly these operations; anything
else is `403 NOT_FOR_DEVICES`. It is enforced in the per-operation auth
chain, keyed by operation ID, and a test checks every entry names a real
operation (as `assertOperationAuthCoverage` does for tiers):

- Reads: `ListBabies`, `ListFamilyMembers`, `GetSummary`, `ListFeeds`,
  `ListSleepLocations`, `ListMedicineCatalogue`, `GetFeedTimer`.
- Writes: `CreateFeed`, `DeleteFeed`, `CreateDiaper`, `DeleteDiaper`,
  `CreateSleep`, `WakeSleep`, `UpdateSleep` (resume after a mistaken
  wake), `DeleteSleep`, `StartFeedTimer`, `SetFeedTimerSide`,
  `StopFeedTimer`, `CreateMedicine`, `DeleteMedicine`.
- Device-only (§5): `GetDevice`, `UnenrolDevice`, `ListDeviceThresholds`.
- Hand-routed: `GET /api/users/{id}/avatar` only (not the avatar upload
  or delete).

Refused as a consequence: `/api/me`, profile, push, reminders, help,
calendar, export, invites, keys, and every family-admin and system-admin
route. `RequireAdmin` additionally refuses a device outright, as it does an
API key — a second guard, not the primary one.

### 5. Endpoints

All shapes are added to `openapi/pjokk.yaml` first.

**Family admin** (`tierAdmin`; refused for API keys and devices):

| | |
|---|---|
| `POST /api/devices {name}` | → `201 {device, code, expiresAt, setupUrl}`; `setupUrl` is `APP_URL/kiosk/setup?code=…` |
| `GET /api/devices` | → pending and active devices: `{id, name, status, createdAt, createdByName, enrolledAt, lastUsedAt, codeExpiresAt}`; revoked rows are not listed |
| `POST /api/devices/{id}/code` | → a new code for a **pending** device; `409` for an active one |
| `DELETE /api/devices/{id}` | → `204`; sets `revoked_at` |

**Public** — `POST /api/device/enrol {code, pin}`, rate-limited like invite
redemption (10 per 10 min per client digest, 200 per 10 min globally).
One atomic `UPDATE … SET token_hash, pin_hash, enrolled_at, enrol_code_hash
= NULL WHERE enrol_code_hash = $1 AND enrol_expires_at > now() AND
token_hash IS NULL AND revoked_at IS NULL RETURNING …` — redeem-once
without a read-then-write race. Unknown, expired and already-used codes
are one answer, `400 INVALID_CODE`. Success sets the cookie and returns
`{id, name, familyId, familyName}`.

**Device** (a new `tierDevice`: a device identity is required;
`401 NOT_A_DEVICE` for anyone else):

| | |
|---|---|
| `GET /api/device` | → `{id, name, familyId, familyName}` |
| `POST /api/device/unenrol {pin}` | wrong → `403 WRONG_PIN`; right → revoke, clear cookie, `204`. 5 attempts per device per 10 min (keyed on the device id, not the client), then `429` |
| `GET /api/device/thresholds` | → `[{kind, babyId, intervalMin}]` for every `since_last` feed/diaper reminder in the family |

**Why `thresholds` exists.** Spec 2's amber card (`cautionFor` in
`lib/kiosk-ui.ts`) fires when "the family's threshold" has passed, but
reads it from `GET /api/reminders` — the signed-in person's own reminders.
A device has no person. Rather than open a person's reminder list to a
device, it gets only what the card needs: the intervals, across every
caretaker in the family. Amber when **any** caretaker's since-last
reminder for that kind has run out — the family's threshold, as spec 2
meant it. No labels, quiet hours or schedules leave the server.

### 6. The kiosk (frontend)

**Gate.** `/kiosk` gets its own `DeviceGate` instead of `AuthGate`: it reads
`GET /api/device` (persisted, so a kiosk that reloads offline still starts)
and never touches Limen's session or `/api/me`. `lib/kiosk.ts` keeps the
`pjokk.kiosk.on` localStorage flag, set at enrolment, so `AppShell` can
send every app route to `/kiosk` without a network round-trip; the
server's answer is the authority.

**Caretaker row.** In the kiosk's top band: every family member's avatar
(initials fallback) and display name, from `ListFamilyMembers`. The
chosen one carries the accent ring. With nobody chosen the row reads
"Who's logging?", and tapping any action opens a "Who's logging?" prompt
with large avatars; choosing completes the pending action — still one
decision. `useIdle`'s `dim` clears the choice.

**Sending the caretaker.** The shared log hooks (`useLogFeed`,
`useLogDiaper`, `useStartSleep`, `useWakeSleep`, `useResumeSleep`, the
deletes, the feed-timer hooks, `useCreateOther` / `useDeleteOther`) gain
an optional `caretakerId` in their **variables**, which the request
function turns into `X-Pjokk-Caretaker`. It is deliberately not read from
a global at send time: `setMutationDefaults` persists variables, so a feed
queued offline and replayed after the kiosk dimmed still carries the
person who tapped it. Home passes nothing and is unchanged.

**What the kiosk no longer calls.** `useReminders` → `useDeviceThresholds`.
`useUnits` (which reads `/api/me`) → the kiosk shows metric, the stored
unit: a device is not a person and has no display preference (a known v1
limitation). Language keeps following the device.

**Leaving.** Same press-and-hold on the baby's name, same PIN pad, now
verified by `POST /api/device/unenrol`. Right → clear the flag, the query
cache and the persisted snapshot (one family's data does not stay on a
tablet that is no longer theirs), land on `/login`. Wrong → shake (and the
pad's existing 3-wrong/30 s lockout); `429` → "Too many tries — wait a few
minutes"; offline → "Leaving needs a connection".

**Revoked remotely.** Any `401 DEVICE_REVOKED` runs the same clean-up and
lands on `/login` with "This tablet is no longer a kiosk".

**Old-style kiosks.** A browser with spec 2's flag and no device cookie
gets `401 NOT_A_DEVICE` from `GET /api/device`: drop the old keys
(`pjokk.kiosk.pin`, `pjokk.kiosk.pinlen`, the flag) and carry on in the
normal app with a one-time toast, "Kiosk mode now needs a device —
Settings → Family → Devices".

### 7. Enrolment screens

**Settings → Family → Devices** (admins only; members do not see the
row). Rows: name + "Set up 3 Sep · used 5 min ago" or "Waiting for set-up
· code expires in 12 min". **Add device** → name field → the code in large
type, a QR (the invite sheet's QR component) of `setupUrl`, and "On the
tablet, open app.pjokk.no and tap *Set up as kiosk*." A row opens a sheet
with **Revoke** (confirm) and, while pending, **New code**.

**Use this device** — on the Add sheet, for a parent already signed in on
the spare iPad: create the device, sign this browser out, clear the cache,
and continue at the PIN step of `/kiosk/setup` with the code in hand. No
extra endpoint.

**`/kiosk/setup`** (outside the signed-in shell; reached from a **Set up as
kiosk** link on `/login`, or the QR): the 8-character code (prefilled from
`?code=`, which is then stripped from the URL), then the PIN twice on the
existing `KioskPinPad`, then `POST /api/device/enrol`. Success clears any
cached data from a previous session, sets the flag and lands on `/kiosk`.
The one place a kiosk shows the OS keyboard, once.

**Removed:** Preferences → Kiosk mode (`KioskSection`), `hashPin` /
`verifyPin` and the local PIN keys, and spec 2's Settings line about the
kiosk logging as you.

### 8. Errors

| Condition | Response | Kiosk |
|---|---|---|
| Device revoked / not enrolled | `401 DEVICE_REVOKED` (+ cookie cleared) | clean up → `/login` + notice |
| No device cookie on a device route | `401 NOT_A_DEVICE` | old-style kiosk → normal app |
| Write without caretaker | `400 CARETAKER_REQUIRED` | "Who's logging?" |
| Caretaker not in family | `403 NOT_MEMBER` | refetch members, clear choice, "Pick again" |
| Operation not allowed | `403 NOT_FOR_DEVICES` | generic error toast (a bug) |
| Wrong PIN | `403 WRONG_PIN` | shake |
| Too many attempts | `429` | "Too many tries" |
| Bad / expired / used code | `400 INVALID_CODE` | one message for all three |
| 10 devices already | `409 DEVICE_LIMIT` | on the Add sheet |

Logging offline works as today. Enrolling and leaving need a connection.

## Testing

Test-first. Go against real Postgres (`go test -p 1 ./...`):

- **DeviceAuth**: a valid cookie resolves the family; revoked and pending
  → 401 with the cookie cleared; the cookie is re-issued at most daily.
- **Caretaker**: write without header → 400; non-member → 403; a member
  lands in the log's `caretaker_id`; an admin chosen as caretaker still
  cannot reach an admin route.
- **Allowlist**: every entry is a real operation; a sample outside it
  (`CreateInvite`, `GetMe`, `ListReminders`, the CSV export, the avatar
  upload) → 403 `NOT_FOR_DEVICES`.
- **Tenancy**: a device of family A cannot read or write family B's baby.
- **Enrol**: works once; second use, expired, and revoked-while-pending
  all → `INVALID_CODE`; rate limit; cookie attributes (HttpOnly,
  SameSite, Secure per `APP_URL`).
- **Unenrol**: wrong PIN + the per-device limit; right PIN revokes and
  clears the cookie.
- **Admin routes**: a member → 403; an API key → 403; the cap of 10.
- **Thresholds**: every caretaker's since_last feed/diaper reminders,
  nothing else, own family only.
- **Schema guards**: backup table list; user reassignment.

Frontend (`bun test`): the dim clears the caretaker (pure logic in
`lib/kiosk-ui.ts`); `cautionFor` over thresholds; `caretakerId` in
variables becomes the header; the leave clean-up.

E2E (Playwright): an admin adds a device → a second browser context
enrols with the code and a PIN → chooses a caretaker, logs a diaper → the
admin's timeline shows "by <name>" → leaving with the PIN lands on
`/login` → a remote revoke shows the notice. Spec 2's kiosk specs (seeded
local PIN) move to an enrolled device.

## Docs

CLAUDE.md's kiosk paragraph (device credential shipped), a DECISIONS.md
entry, README → Backups (the `device` table and why it is kept). The
privacy policy is unchanged: a device row holds a name and hashes, no
address.
