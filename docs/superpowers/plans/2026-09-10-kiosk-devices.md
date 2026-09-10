# Kiosk devices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrol a tablet as a family *device* with its own httpOnly credential, let an avatar row attribute each kiosk log to a chosen caretaker, and restrict a device to an allowlist of the kiosk's operations.

**Architecture:** A `device` table holds hashed enrolment codes, tokens and PINs. `middleware.DeviceAuth` turns the `pjokk_device` cookie into an identity; `RequireFamily` builds the tenancy context from the device plus an `X-Pjokk-Caretaker` header; `authChain` refuses any operation outside `deviceOperations`. The SPA gets a `/kiosk/setup` enrolment screen, a `DeviceGate` for `/kiosk`, a caretaker row, and a Settings → Family → Devices admin section; the spec-2 local PIN is removed.

**Tech Stack:** Go 1.27 stdlib `net/http`, oapi-codegen strict server, pgx v5 + sqlc + goose, Postgres; Vite + React + TanStack Query/Router, openapi-fetch; Playwright.

**Spec:** `docs/superpowers/specs/2026-09-10-kiosk-devices-design.md`

## Global Constraints

- Spec first: every endpoint is added to `openapi/pjokk.yaml`, then `go generate ./...` (from `apps/server`) and `bun run gen:client` (repo root). Never hand-edit `internal/api/pjokk.yaml`, `internal/api/gen`, `internal/db/gen` or `api-schema.d.ts`.
- Every sqlc query on `device` takes `family_id`, except `EnrolDevice` (by code hash) and `GetDeviceByTokenHash` (by token hash), each documented at the query.
- Cookie `pjokk_device`: HttpOnly, SameSite=Lax, Path=/, Secure iff `APP_URL` starts with `https://`, Max-Age 400 days; re-issued on the first `last_used_at` touch of each UTC day.
- Header `X-Pjokk-Caretaker: <userId>`; device writes without it → `400 CARETAKER_REQUIRED`; non-member → `403 NOT_MEMBER`; device `MemberRole` is always `"member"`.
- Code: 8 chars, invite alphabet, 15 min, SHA-256 at rest. Token: `pjd_` + 40 hex, SHA-256 at rest. PIN: 4–6 digits, HMAC-SHA-256 with a key derived from `AUTH_SECRET` + `":device-pin"`. Cap: 10 non-revoked devices per family.
- Error codes exactly: `DEVICE_REVOKED` (401, clears cookie), `NOT_A_DEVICE` (401), `CARETAKER_REQUIRED` (400), `NOT_MEMBER` (403), `NOT_FOR_DEVICES` (403), `WRONG_PIN` (403), `INVALID_CODE` (400), `DEVICE_LIMIT` (409), `429` on limits.
- Rate limits: enrol 10/600 s per client digest + 200/600 s global; unenrol 5/600 s per device id.
- Go tests: `cd apps/server && go test -p 1 ./...` with `PATH=$HOME/.local/go/bin:$HOME/go/bin:$PATH` and (on this machine) `TEST_DATABASE_URL=postgres://pjokk:pjokk@127.0.0.1:56432/pjokk_test`. TS: `bun run test`, `bun run check`. Every user-facing string goes through `t()` with an `nb` entry.
- Conventional Commits; attribution trailer on every commit.

---

### Task 1: The `device` table, its queries, and the schema guards

**Files:**
- Create: `apps/server/internal/db/migrations/00014_device.sql`
- Create: `apps/server/internal/db/queries/devices.sql`
- Modify: `apps/server/internal/jobs/backup.go` (BackupTables), `apps/server/internal/db/queries/admin.sql` (ReassignUserReferences), `apps/server/internal/api/admin_test.go` (reference map)

**Interfaces — Produces (sqlc, `dbgen`):** `CreateDevice`, `CountActiveDevices`, `ListDevices` (row has `CreatedByName string`), `GetDevice(id, family_id)`, `RenewDeviceCode :execrows`, `RevokeDevice :execrows`, `EnrolDevice` (row: `ID, FamilyID, Name, FamilyName`), `GetDeviceByTokenHash` (row: `ID, FamilyID, Name, FamilyName, LastUsedAt`), `TouchDevice`, `GetDevicePinHash(id, family_id)`, `ListFamilyReminderThresholds(family_id)` (rows: `Kind, BabyID *string, IntervalMin int32`).

- [ ] **Step 1: Migration** — `00014_device.sql`:

```sql
-- +goose Up
-- Kiosk devices (spec 2026-09-10-kiosk-devices-design.md): a tablet enrolled
-- as the FAMILY's care station, with its own credential. Pending = code set,
-- no token; active = token set, not revoked; revoked = revoked_at set.
CREATE TABLE "device" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 60),
	"created_by" text NOT NULL REFERENCES "users" ("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"enrol_code_hash" text,
	"enrol_expires_at" timestamptz,
	"token_hash" text,
	"pin_hash" text,
	"enrolled_at" timestamptz,
	"last_used_at" timestamptz,
	"revoked_at" timestamptz,
	CONSTRAINT "device_token_hash_unique" UNIQUE ("token_hash"),
	-- No device is ever enrolled without a PIN: both arrive in one UPDATE.
	CONSTRAINT "device_token_needs_pin" CHECK (("token_hash" IS NULL) = ("pin_hash" IS NULL))
);
CREATE INDEX "device_family_idx" ON "device" ("family_id");
CREATE UNIQUE INDEX "device_enrol_code_idx" ON "device" ("enrol_code_hash")
	WHERE "enrol_code_hash" IS NOT NULL;

-- +goose Down
DROP TABLE IF EXISTS "device";
```

- [ ] **Step 2: Run the schema guards to watch them fail**

Run: `go test -p 1 ./internal/jobs/ -run TestBackupTables ./internal/api/ -run TestUserDeleteCoversEveryNonCascadingUserReference`
Expected: FAIL — `device` covered by neither backup list; `device.created_by` not handled.

- [ ] **Step 3: Make them pass** — add `"device"` to `BackupTables` (after `"api_key"`, comment: holds only hashes; a restored kiosk keeps working, like api_key); add to `ReassignUserReferences`:

```sql
    device AS (UPDATE "device" SET "created_by" = @tombstone_id WHERE "device"."created_by" = @user_id),
```
and `"device.created_by": true,` to the map in `admin_test.go`.

- [ ] **Step 4: Queries** — `devices.sql` (header comment naming the two cross-family lookups):

```sql
-- name: CreateDevice :one
INSERT INTO "device" ("family_id", "name", "created_by", "enrol_code_hash", "enrol_expires_at")
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: CountActiveDevices :one
SELECT COUNT(*)::int FROM "device" WHERE "family_id" = $1 AND "revoked_at" IS NULL;

-- name: ListDevices :many
SELECT d.*, COALESCE(u."display_name", u."name", '')::text AS created_by_name
FROM "device" d JOIN "users" u ON u."id" = d."created_by"
WHERE d."family_id" = $1 AND d."revoked_at" IS NULL
ORDER BY d."created_at" DESC;

-- name: GetDevice :one
SELECT * FROM "device" WHERE "id" = $1 AND "family_id" = $2;

-- name: RenewDeviceCode :execrows
UPDATE "device" SET "enrol_code_hash" = $3, "enrol_expires_at" = $4
WHERE "id" = $1 AND "family_id" = $2 AND "token_hash" IS NULL AND "revoked_at" IS NULL;

-- name: RevokeDevice :execrows
UPDATE "device" SET "revoked_at" = $3
WHERE "id" = $1 AND "family_id" = $2 AND "revoked_at" IS NULL;

-- name: EnrolDevice :one
-- Cross-family by nature (the code is the only thing the tablet has), like
-- GetAPIKeyByHash. One statement redeems the code: a second use, an expired
-- code and a device revoked while pending all match zero rows.
WITH d AS (
    UPDATE "device"
    SET "token_hash" = @token_hash, "pin_hash" = @pin_hash, "enrolled_at" = @now,
        "last_used_at" = @now, "enrol_code_hash" = NULL, "enrol_expires_at" = NULL
    WHERE "enrol_code_hash" = @code_hash AND "enrol_expires_at" > @now
      AND "token_hash" IS NULL AND "revoked_at" IS NULL
    RETURNING "id", "family_id", "name"
)
SELECT d."id", d."family_id", d."name", o."name" AS family_name
FROM d JOIN "organizations" o ON o."id" = d."family_id";

-- name: GetDeviceByTokenHash :one
-- The per-request lookup (middleware.DeviceAuth). Cross-family by nature.
SELECT d."id", d."family_id", d."name", o."name" AS family_name, d."last_used_at"
FROM "device" d JOIN "organizations" o ON o."id" = d."family_id"
WHERE d."token_hash" = $1 AND d."revoked_at" IS NULL;

-- name: TouchDevice :exec
UPDATE "device" SET "last_used_at" = $2 WHERE "id" = $1;

-- name: GetDevicePinHash :one
SELECT COALESCE("pin_hash", '')::text FROM "device"
WHERE "id" = $1 AND "family_id" = $2 AND "revoked_at" IS NULL;

-- name: ListFamilyReminderThresholds :many
-- The kiosk's amber card: every caretaker's since_last feed/diaper interval.
SELECT DISTINCT "kind", "baby_id", "interval_min"::int AS interval_min
FROM "reminder"
WHERE "family_id" = $1 AND "mode" = 'since_last' AND "kind" IN ('feed', 'diaper')
ORDER BY "kind", interval_min;
```

- [ ] **Step 5:** `go generate ./...` then `go vet ./... && go test -p 1 ./internal/jobs/ ./internal/api/ -run 'TestBackupTables|TestUserDelete'` → PASS.
- [ ] **Step 6: Commit** `feat(devices): device table, queries and schema guards`.

---

### Task 2: `DeviceAuth`, the device-aware tenancy gate, and admin refusal

**Files:**
- Modify: `apps/server/internal/api/middleware/middleware.go`
- Modify: `apps/server/internal/api/api.go` (`mwDeps` passes `SecureCookies`)
- Test: `apps/server/internal/api/middleware/device_test.go`

**Interfaces — Produces (package `middleware`):**

```go
const DeviceCookieName = "pjokk_device"
const CaretakerHeader = "X-Pjokk-Caretaker"
type Device struct{ ID, FamilyID, Name, FamilyName string }
func DeviceFromContext(ctx context.Context) *Device
func IsDevice(r *http.Request) bool
func SetDeviceCookie(w http.ResponseWriter, token string, secure bool)
func ClearDeviceCookie(w http.ResponseWriter, secure bool)
func DeviceAuth(d Deps) func(http.Handler) http.Handler
func RequireDevice() func(http.Handler) http.Handler // 401 NOT_A_DEVICE
// Deps gains: SecureCookies bool
// FamilyCtx gains: IsDevice bool; DeviceID string
```

- [ ] **Step 1: Failing tests** (`device_test.go`, reusing the file's `fixture`/`probe`): a helper `f.createDevice(familyID, createdBy string, opts deviceOpts) (token string)` inserts an active device (`token_hash` = sha256 hex, `pin_hash` = "x", `enrolled_at` now; `revoked` option). Tests:
  - `TestDeviceAuthResolvesTheDevicesFamily` — GET with the cookie through `DeviceAuth → Session → RequireFamily` → 200, `FamilyCtx{FamilyID, IsDevice: true, MemberRole: "member", UserID: ""}`.
  - `TestDeviceAuthRejectsARevokedDeviceAndClearsTheCookie` — 401 `DEVICE_REVOKED`, response `Set-Cookie` has `pjokk_device=` with `Max-Age=0`.
  - `TestDeviceAuthRejectsAnUnknownToken` — same 401.
  - `TestDeviceAuthPassesThroughWithoutACookie` — anonymous → RequireFamily's 401 `UNAUTHENTICATED`.
  - `TestDeviceWriteRequiresACaretaker` — POST without header → 400 `CARETAKER_REQUIRED`.
  - `TestDeviceCaretakerMustBeAMember` — header = a user of another family → 403 `NOT_MEMBER`.
  - `TestDeviceCaretakerBecomesTheUser` — header = family member → `FamilyCtx.UserID` = member, `UserName` = their display name, `MemberRole` = "member" even though the member is an admin.
  - `TestRequireAdminRejectsDevices` — admin caretaker → 403 `FORBIDDEN`.
  - `TestDeviceCookieReissuedOncePerDay` — `last_used_at` yesterday → response sets the cookie with `Max-Age=34560000`; a second request (touch within 5 min) sets none.
  - `TestDeviceCookieAttributes` — `SetDeviceCookie(rec, "t", true)` → HttpOnly, Secure, SameSite=Lax, Path=/.

- [ ] **Step 2:** run `go test -p 1 ./internal/api/middleware/ -run 'Device|RequireAdminRejectsDevices'` → compile failure / FAIL.

- [ ] **Step 3: Implement.** `identity` gains `device *Device`. `DeviceAuth`:

```go
func DeviceAuth(d Deps) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, ok := identityFrom(r); ok { // a pjk_ key already won
				next.ServeHTTP(w, r)
				return
			}
			c, err := r.Cookie(DeviceCookieName)
			if err != nil || c.Value == "" {
				next.ServeHTTP(w, r)
				return
			}
			sum := sha256.Sum256([]byte(c.Value))
			row, err := d.Q.GetDeviceByTokenHash(r.Context(), hex.EncodeToString(sum[:]))
			switch {
			case errors.Is(err, pgx.ErrNoRows):
				ClearDeviceCookie(w, d.SecureCookies)
				respond.Error(w, http.StatusUnauthorized, "This device is no longer enrolled", "DEVICE_REVOKED")
				return
			case err != nil:
				respond.Error(w, http.StatusInternalServerError, "device lookup failed", "INTERNAL")
				return
			}
			now := d.now()
			if !row.LastUsedAt.Valid || now.Sub(row.LastUsedAt.Time) > lastUsedInterval {
				if err := d.Q.TouchDevice(r.Context(), gen.TouchDeviceParams{ID: row.ID, LastUsedAt: pgtype.Timestamptz{Time: now, Valid: true}}); err != nil {
					log.Printf("middleware: device last_used_at update failed (device=%s): %v", row.ID, err)
				}
				if !row.LastUsedAt.Valid || !sameUTCDay(row.LastUsedAt.Time, now) {
					SetDeviceCookie(w, c.Value, d.SecureCookies)
				}
			}
			dev := &Device{ID: row.ID, FamilyID: row.FamilyID, Name: row.Name, FamilyName: row.FamilyName}
			next.ServeHTTP(w, withIdentity(r, identity{device: dev}))
		})
	}
}
```
`RequireFamily` gets a device branch before the session branch: read `CaretakerHeader`; if empty and `!isRead(r.Method)` → 400 `CARETAKER_REQUIRED`; if set → `GetFamilyMembershipRole(dev.FamilyID, caretaker)` (no rows → 403 `NOT_MEMBER`) and a name lookup (reuse an existing member-name query or add `GetUserDisplayName`); build `FamilyCtx{UserID: caretaker, UserName, FamilyID: dev.FamilyID, MemberRole: auth.RoleMember, IsDevice: true, DeviceID: dev.ID}`. `RequireAdmin` refuses `family.IsDevice` with 403 `FORBIDDEN` "Not available to devices". `RequireDevice` → 401 `NOT_A_DEVICE` when `identity.device == nil`. `SetDeviceCookie`: `http.SetCookie(w, &http.Cookie{Name, Value: token, Path: "/", MaxAge: 400*24*3600, HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode})`; `ClearDeviceCookie`: same with `MaxAge: -1`. `mwDeps()` sets `SecureCookies: strings.HasPrefix(d.AppURL, "https://")`.

- [ ] **Step 4:** tests PASS; whole package green.
- [ ] **Step 5: Commit** `feat(devices): device credential middleware and caretaker attribution`.

---

### Task 3: The device operation allowlist in the auth chain

**Files:**
- Modify: `apps/server/internal/api/api.go` (`deviceOperations`, `authChain`, `familyChain`, coverage assertion), `apps/server/internal/api/avatar.go` (GET chain)
- Test: `apps/server/internal/api/devices_access_test.go`; `apps/server/internal/testrig/http.go` (`CreateDevice` helper)

**Interfaces — Produces:** `testrig.(*AppRig).CreateDevice(familyID, createdBy string) (cookie string)` returning `"pjokk_device=<token>"`; `var deviceOperations map[string]bool`; `assertDeviceOperationCoverage(spec)`.

- [ ] **Step 1: Failing tests** (`devices_access_test.go`): family with admin + second member + baby; `dev := a.CreateDevice(fam, adminID)`; helper `doAs(method, path, cookie, caretaker string, body)` building the request with `X-Pjokk-Caretaker`.
  - Allowed read: `GET /api/summary?babyId=` → 200.
  - `GET /api/me`, `GET /api/reminders`, `POST /api/invites`, `GET /api/export.csv`, `GET /api/keys` → 403 `NOT_FOR_DEVICES` (export via its hand-routed chain: device cookie gives no session → 401 is acceptable there; assert `!= 200`).
  - `POST /api/diapers` with caretaker = member → 201 and `caretakerName` is the member's name; without header → 400.
  - Tenancy: `GET /api/summary?babyId=<family B baby>` → 404.
  - Avatar: `GET /api/users/{memberId}/avatar` → not 401/403 (404 without a photo is fine); `PUT /api/me/avatar` → 401/403.

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** In `api.go`:

```go
// deviceOperations is the ALLOWLIST a kiosk device may call (spec §4).
// Anything else answers 403 NOT_FOR_DEVICES. Add a line here when the kiosk
// gains a feature; never make it a denylist.
var deviceOperations = map[string]bool{
	"ListBabies": true, "ListFamilyMembers": true, "GetSummary": true, "ListFeeds": true,
	"ListSleepLocations": true, "ListMedicineCatalogue": true, "GetFeedTimer": true,
	"CreateFeed": true, "DeleteFeed": true, "CreateDiaper": true, "DeleteDiaper": true,
	"CreateSleep": true, "WakeSleep": true, "UpdateSleep": true, "DeleteSleep": true,
	"StartFeedTimer": true, "SetFeedTimerSide": true, "StopFeedTimer": true,
	"CreateMedicine": true, "DeleteMedicine": true,
	"GetDevice": true, "UnenrolDevice": true, "ListDeviceThresholds": true,
}
```
`authChain` builds `device := middleware.DeviceAuth(mwDeps)` and a per-operation `gate` (403 `NOT_FOR_DEVICES` when `middleware.IsDevice(r) && !deviceOperations[operationID]`); every non-public chain becomes `apiKey(device(gate(session(...))))`; new `tierDevice` chain `apiKey(device(gate(requireDevice(captureHTTP(h)))))`; `tierPublic` wraps `captureHTTP` for operations in `publicNeedsHTTP` (`EnrolDevice`). `assertDeviceOperationCoverage` panics if an entry names no spec operation (called next to `assertOperationAuthCoverage`). Avatar: `mountAvatarRoutes` takes a second chain for GET: `apiKey(device(session(requireSessionOrDevice(rejectAPIKey(h)))))` and `getUserAvatar`'s access check accepts a device whose family contains the user (read it before changing). `testrig.CreateDevice` inserts an active row like `CreateAPIKey` and returns the cookie header value. (GetDevice/UnenrolDevice/ListDeviceThresholds exist from Task 5 on; add them to the map in that task so coverage passes here.)

- [ ] **Step 4:** tests PASS; `go test -p 1 ./internal/api/...` green.
- [ ] **Step 5: Commit** `feat(devices): allowlist what a kiosk device may call`.

---

### Task 4: Family-admin device management endpoints

**Files:**
- Modify: `openapi/pjokk.yaml` (paths `/api/devices`, `/api/devices/{id}`, `/api/devices/{id}/code`; schemas `Device`, `CreateDevice`, `DeviceCode`)
- Create: `apps/server/internal/api/devices.go`
- Modify: `apps/server/internal/api/api.go` (tiers: `ListDevices`, `CreateDevice`, `RenewDeviceCode`, `RevokeDevice` → `tierAdmin`)
- Test: `apps/server/internal/api/devices_test.go`

**Interfaces — Produces:** wire `Device {id, name, status: pending|active, createdAt, createdByName, enrolledAt?, lastUsedAt?, codeExpiresAt?}`; `DeviceCode {device: Device, code, expiresAt, setupUrl}`; Go helpers `generateEnrolCode() (string, error)` (reuses `inviteCodeAlphabet`, length 8), `generateDeviceToken() (string, error)` (`pjd_` + 40 hex), `const deviceCodeTTL = 15 * time.Minute`, `const maxDevicesPerFamily = 10`.

- [ ] **Step 1: Failing tests:** create → 201 with 8-char code from the alphabet, `setupUrl == AppURL+"/kiosk/setup?code="+code`, status pending, `codeExpiresAt ≈ now+15m`; list shows it with `createdByName`; renew → new code, old code hash gone; renew an active device → 409; revoke → 200/`{ok:true}` then list omits it; revoke twice → 404; cross-family id → 404; member → 403; API key → 403; 11th create → 409 `DEVICE_LIMIT`; name "" or 61 chars → 400 (spec validation).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement** spec (YAML first, `go generate ./...`), then handlers mirroring `keys.go` (`CreateDevice` counts, generates, stores `sha256Hex(code)`; `RenewDeviceCode` uses `RenewDeviceCode` and on 0 rows `GetDevice` → 404 or 409; `RevokeDevice` like `RevokeApiKey`; `serDevice` derives `status` from `token_hash`).
- [ ] **Step 4:** PASS. **Step 5: Commit** `feat(devices): family-admin device management API`.

---

### Task 5: Enrol, the device's own routes, and the PIN

**Files:**
- Modify: `openapi/pjokk.yaml` (`POST /api/device/enrol`, `GET /api/device`, `POST /api/device/unenrol`, `GET /api/device/thresholds`; schemas `EnrolDevice`, `DeviceSelf`, `Unenrol`, `DeviceThreshold`)
- Create: `apps/server/internal/api/device_self.go`
- Modify: `api.go` (tiers: `EnrolDevice` tierPublic + `tierPublicAPIAllowlist` + `publicNeedsHTTP`; `GetDevice`, `UnenrolDevice`, `ListDeviceThresholds` → `tierDevice`; add them to `deviceOperations`; `rateLimitChain` case `EnrolDevice`), `api.Deps` (`DevicePINKey [32]byte`), `cmd/pjokk/main.go` (derive), `testrig/http.go` (fixed key)
- Test: `apps/server/internal/api/device_self_test.go`

**Interfaces — Produces:** `func devicePINHash(key [32]byte, deviceID, pin string) string` (HMAC-SHA-256 hex of `"device-pin:"+deviceID+":"+pin`); `DeviceSelf {id, name, familyId, familyName}`; `DeviceThreshold {kind: feed|diaper, babyId: string|null, intervalMin}`.

- [ ] **Step 1: Failing tests:** admin creates a device → `POST /api/device/enrol {code, pin:"2468"}` → 200 DeviceSelf + `Set-Cookie pjokk_device` (HttpOnly, SameSite=Lax); the cookie then reads `GET /api/device`; second enrol with the same code → 400 `INVALID_CODE`; expired (`SetNow(+16m)`) → 400; revoked while pending → 400; bad PIN format ("12", "abcd") → 400 (spec pattern `^[0-9]{4,6}$`); `GET /api/device` with a session cookie → 401 `NOT_A_DEVICE`; unenrol wrong PIN → 403 `WRONG_PIN`; 6th attempt within 10 min → 429; right PIN → 204, `Set-Cookie` clears, the old cookie now → 401 `DEVICE_REVOKED`; thresholds returns two members' since_last feed/diaper intervals and not an at_time or pump reminder nor another family's; the stored `pin_hash` is not `sha256(pin)` and differs for the same PIN on two devices.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** The PIN hash is keyed per device by the **token hash**: `devicePINHash(key, tokenHash, pin)` = HMAC-SHA-256(key, `"device-pin:" + tokenHash + ":" + pin`). The token hash is generated before the enrol UPDATE, is unique per device and never changes, so enrolment stays one atomic statement (the device id is only known after it). `middleware.Device` gains `TokenHash` (DeviceAuth already computed it).
  - `EnrolDevice`: `code` upper-cased and hashed; `token := generateDeviceToken()`; `tokenHash := sha256Hex(token)`; `EnrolDevice{CodeHash, TokenHash, PinHash: devicePINHash(d.DevicePINKey, tokenHash, pin), Now}`; `pgx.ErrNoRows` → 400 `INVALID_CODE`; set the cookie via `middleware.HTTPFromContext` + `middleware.SetDeviceCookie(w, token, secure)`; 200 `DeviceSelf`.
  - `GetDevice` → the identity's `DeviceSelf`.
  - `UnenrolDevice`: `d.RateLimit.Hit(ctx, "device-unenrol:"+dev.ID, 600)` > 5 → 429; `GetDevicePinHash(dev.ID, dev.FamilyID)`; `hmac.Equal` against `devicePINHash(key, dev.TokenHash, pin)`; wrong → 403 `WRONG_PIN`; right → `RevokeDevice(dev.ID, dev.FamilyID, now)` + `middleware.ClearDeviceCookie` → 204.
  - `ListDeviceThresholds` → `ListFamilyReminderThresholds(dev.FamilyID)`.
  - `cmd/pjokk`: `DevicePINKey: sha256.Sum256([]byte(cfg.AuthSecret + ":device-pin"))`; testrig: a fixed key.
- [ ] **Step 4:** PASS; full `go test -p 1 ./...` + `go vet ./...` green.
- [ ] **Step 5: Commit** `feat(devices): enrolment, unenrol with a server-checked PIN, kiosk thresholds`.

---

### Task 6: Client data layer — generated types, device hooks, caretaker header

**Files:**
- Regenerate: `apps/frontend/src/lib/api-schema.d.ts` (`bun run gen:client`)
- Create: `apps/frontend/src/lib/data/devices.ts`; export from `lib/data/index.ts`
- Modify: `lib/api.ts` (`caretakerInit`), `lib/data/logs.ts`, `lib/data/feed-timer.ts`, `lib/data/other.ts`, `lib/query.ts` (device-revoked event)
- Test: `apps/frontend/test/caretaker-header.test.ts`

**Interfaces — Produces:**

```ts
// lib/api.ts
export const CARETAKER_HEADER = "X-Pjokk-Caretaker";
export function caretakerInit(caretakerId?: string): { headers?: Record<string, string> };
// lib/data/devices.ts
export type Device = components["schemas"]["Device"];
export type DeviceSelf = components["schemas"]["DeviceSelf"];
export function useDevices(enabled: boolean): UseQueryResult<Device[]>;
export function useCreateDevice(); useRenewDeviceCode(); useRevokeDevice();
export function useDeviceSelf(): UseQueryResult<DeviceSelf>;       // key ["device"]
export function useDeviceThresholds(enabled: boolean);             // key ["device","thresholds"]
export async function enrolDevice(code: string, pin: string): Promise<DeviceSelf>;
export type UnenrolResult = "ok" | "wrong" | "limited" | "offline";
export async function unenrolDevice(pin: string): Promise<UnenrolResult>;
// lib/query.ts
export const DEVICE_REVOKED_EVENT = "pjokk:device-revoked";
```
Every kiosk-used Vars type gains `caretakerId?: string` (LogFeedVars, LogDiaperVars, StartSleepVars, WakeSleepVars, ResumeSleepVars, DeleteVars, StartFeedTimerVars, SetFeedTimerSideVars, StopFeedTimerVars, CreateOtherVars, DeleteOtherVars); each `mutationFn` destructures it out of the body and passes `...caretakerInit(caretakerId)` to the client call.

- [ ] **Step 1: Failing test** — `caretakerInit("u1")` → `{headers: {"X-Pjokk-Caretaker": "u1"}}`, `caretakerInit()` → `{}`; and a registered `logDiaper` mutation executed with a stubbed `fetch` sends the header and **not** a `caretakerId` body field (`queryClient` + `registerLogMutationDefaults` + `globalThis.fetch` stub recording the Request).
- [ ] **Step 2:** `bun test apps/frontend/test/caretaker-header.test.ts` → FAIL.
- [ ] **Step 3: Implement** (gen:client first). In `lib/query.ts`'s QueryCache/MutationCache `onError`, an `ApiError` with `code === "DEVICE_REVOKED"` dispatches `window.dispatchEvent(new Event(DEVICE_REVOKED_EVENT))`.
- [ ] **Step 4:** PASS; `bun run check`. **Step 5: Commit** `feat(devices): client hooks and the caretaker header`.

---

### Task 7: Enrolment screen, `DeviceGate`, and the end of the local PIN

**Files:**
- Modify: `lib/kiosk.ts` (drop `hashPin`/`verifyPin`/`enableKiosk`/`disableKiosk`; add `markEnrolled(pinLength)`, `clearKioskFlags()`, `leaveKiosk()`), `test/kiosk.test.ts`
- Create: `screens/KioskSetup.tsx`, `screens/kiosk/DeviceGate.tsx`
- Modify: `router.tsx` (`/kiosk/setup` route under root with `validateSearch {code?}`), `screens/Login.tsx` (**Set up as kiosk** link), `screens/Kiosk.tsx` (`KioskRoute` uses `DeviceGate`), `screens/settings/index.tsx` (remove `KioskSection`); Delete: `screens/settings/KioskSection.tsx`

**Interfaces — Produces:** `markEnrolled(pinLength: number): void` (sets `ON_KEY`, `PIN_LEN_KEY`); `clearKioskFlags(): void` (removes ON, PIN_LEN and legacy `pjokk.kiosk.pin`); `leaveKiosk(): Promise<void>` (clear flags + `resetCache()`); `DeviceGate({children})`.

- [ ] **Step 1: Failing tests** (`kiosk.test.ts`): `markEnrolled(6)` → `isKioskOn()` and `storedPinLength() === 6`; `clearKioskFlags()` removes all three keys including the legacy PIN hash; `isValidPin` unchanged.
- [ ] **Step 2:** FAIL. **Step 3: Implement.**
  - `DeviceGate`: `useDeviceSelf()`; `ApiError` `NOT_A_DEVICE` → `clearKioskFlags()`, toast "Kiosk mode now needs a device — Settings → Family → Devices", `<Navigate to="/home"/>`; `DEVICE_REVOKED` (query error or the window event) → `await leaveKiosk()` then `window.location.assign("/login?notice=revoked")`; pending without persisted data → blank; else children.
  - `/login` shows "This tablet is no longer a kiosk" when `notice=revoked`.
  - `KioskSetup`: if `useKiosk()` → `<Navigate to="/kiosk"/>`. Code input (uppercase, filtered to the alphabet, 8 max; prefilled from `?code=`, then `navigate({search: {}, replace: true})`), PIN + repeat inputs (the removed KioskSection's validation), **Start kiosk** → `enrolDevice` → `resetCache()` → `markEnrolled(pin.length)` → `navigate({to: "/kiosk"})`. `ApiError` `INVALID_CODE` → "That code is not valid. Ask for a new one."; 429 → "Too many tries — wait a few minutes"; offline → "Setting up needs a connection".
- [ ] **Step 4:** `bun run test`, `bun run check` → PASS. **Step 5: Commit** `feat(kiosk): enrol a tablet with a code; the device gate replaces the local PIN`.

---

### Task 8: The caretaker row and a device-backed kiosk screen

**Files:**
- Create: `components/kiosk/KioskCaretakers.tsx` (row + "Who's logging?" prompt)
- Modify: `screens/Kiosk.tsx`, `components/kiosk/KioskPinPad.tsx` (`verify` prop), `lib/kiosk-ui.ts` (`thresholdsToReminders`, `caretakerAfterIdle`)
- Test: `test/kiosk-ui.test.ts`

**Interfaces — Produces:** `thresholdsToReminders(t: DeviceThreshold[]): ReminderLike[]`; `caretakerAfterIdle(state: IdleState, current: string | null): string | null` (null when `dim`); `KioskPinPad` props `{length, verify: (pin) => Promise<UnenrolResult>, onSuccess, onCancel, onLockout}`; `KioskCaretakers({members, selected, onSelect, prompt: boolean, onPromptClose})`.

- [ ] **Step 1: Failing tests:** `caretakerAfterIdle("dim","u1") === null`, `("awake","u1") === "u1"`; `cautionFor` fed by `thresholdsToReminders([{kind:"feed", babyId:null, intervalMin:180}])` is amber after 181 min and not after 179.
- [ ] **Step 2:** FAIL. **Step 3: Implement.**
  - Kiosk: `const [caretaker, setCaretaker] = useState<string|null>(null)`; `useEffect(() => setCaretaker((c) => caretakerAfterIdle(idle, c)), [idle])`; `const members = useMembers()`; `const act = (fn: (id: string) => void) => caretaker ? fn(caretaker) : setPending(() => fn)`; the prompt's choice sets `caretaker` and runs `pending(id)`. Every `mutate` passes `caretakerId`; `Undo` stores `caretakerId` and the undo delete uses it. `useReminders` → `useDeviceThresholds(true)` mapped with `thresholdsToReminders`; `useUnits()` → `const units: Units = "metric"`. The pad's `verify` calls `unenrolDevice`; `ok` → `leaveKiosk()` then `window.location.assign("/login")`; `wrong` → shake; `limited` → status "Too many tries — wait a few minutes" and `onLockout`; `offline` → "Leaving needs a connection".
  - `KioskCaretakers`: a horizontal row under the band — 56 px avatars (`components/Avatar`) + first name, selected ring `ring-accent`; empty state "Who's logging?"; the prompt is a centred dialog with 88 px avatars, `role="dialog"`, Cancel.
- [ ] **Step 4:** `bun run test`, `bun run check`. **Step 5: Commit** `feat(kiosk): who's logging — the caretaker row and device-backed data`.

---

### Task 9: Settings → Family → Devices

**Files:**
- Create: `screens/settings/DevicesSection.tsx`
- Modify: `screens/settings/index.tsx` (`{isAdmin && <DevicesSection />}` directly after `FamilySection`)

- [ ] **Step 1: Implement** (UI; covered by the E2E in Task 10): list rows (name; "Set up <day> · used <relative>" or "Waiting for set-up · code expires in <n> min"); **Add device** sheet → name `Input` (default "Kiosk") → **Create** → code in large mono type, `InviteQR` of `setupUrl`, the instruction line, and **Use this device** (→ `signOut()`, `resetCache()`, `window.location.assign(setupUrl)`); row sheet → **Revoke** (confirm via `DeleteButton`) and, when pending, **New code**. `409 DEVICE_LIMIT` → "A family can have at most 10 devices".
- [ ] **Step 2:** `bun run check` (i18n coverage). **Step 3: Commit** `feat(settings): manage kiosk devices under Family`.

---

### Task 10: End-to-end

**Files:**
- Modify: `e2e/kiosk.spec.ts` (seed an enrolled device instead of a local PIN), `e2e/helpers.ts` (`enrolKiosk(page, request, familyCookie)`)
- Create: `e2e/devices.spec.ts`

- [ ] **Step 1:** `enrolKiosk`: `POST /api/devices` as the admin → code; `page.goto("/kiosk/setup?code=" + code)`; fill PIN + repeat; **Start kiosk**; expect `/kiosk`.
- [ ] **Step 2:** `devices.spec.ts`: admin adds a device in Settings (code visible) → second context enrols → picks the admin's avatar → logs Wet → admin's Timeline shows the diaper "by <name>" → hold name, PIN → `/login`; second scenario: revoke from Settings → kiosk shows "This tablet is no longer a kiosk".
- [ ] **Step 3:** port the existing kiosk specs (diaper + undo, sleep/wake, resume, nursing timer, `/home` → `/kiosk`, night) to `enrolKiosk` + a caretaker pick; drop "Settings turns kiosk on with a PIN".
- [ ] **Step 4:** `E2E_REBUILD=1 bash scripts/e2e-stack.sh up`, then from `e2e/`: `bunx playwright test kiosk devices` → PASS, then the full suite.
- [ ] **Step 5: Commit** `test(e2e): enrolled kiosk devices`.

---

### Task 11: Docs

**Files:** `CLAUDE.md` (kiosk paragraph: device credential + caretaker row shipped; spec 3 path), `DECISIONS.md` (2026-09-10 entry: cookie not bearer, code typed on the tablet, PIN server-side and un-enrols, allowlist, thresholds, metric on the kiosk), `README.md` → Backups (`device` kept: hashes only).

- [ ] **Step 1:** write. **Step 2: Commit** `docs: kiosk devices`.
