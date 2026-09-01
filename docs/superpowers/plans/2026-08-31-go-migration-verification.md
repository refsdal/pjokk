# Go migration — Task 29 verification pass

Full checklist output for the Go-backend migration's final audit-and-fix
pass. Plan: `docs/superpowers/plans/2026-08-31-go-backend-migration.md`.
Reference/parity contract: `docs/superpowers/plans/2026-08-31-go-migration-reference.md`.
Task brief: `.superpowers/sdd/2026-08-31-go-backend-migration/task-29-brief.md`.

Base commit for this pass: `7382c17` (Task 28 complete — "GO BACKEND
FUNCTIONALLY COMPLETE", scratch multi-arch image with embedded SPA). Five
fix commits landed during this pass, each addressing one finding below:

```
7382c17 feat(docker): scratch multi-arch image with embedded SPA          (Task 28, base)
68a5b31 fix(client-gen): make gen:client run hermetically despite the root TS 7 pin
a03b82e fix(ci): add Go test steps and repair the stale image smoke test
5932554 test(config): cover half-configured VAPID in DisabledSubsystems
bdb86f2 refactor(frontend): import the generated Me type instead of hand-rolling it
b515809 fix(compose): pass SITE_URL through selfhost, warn on MinIO dev creds
```

All commits use `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
reference Task 29 in the body.

---

## 1. `go vet` + `go test` — apps/server-go

```
$ export PATH=$HOME/.local/go/bin:$HOME/go/bin:$PATH
$ cd apps/server-go && go vet ./...
(no output — clean)

$ TEST_DATABASE_URL="postgres://pjokk:pjokk@127.0.0.1:55432/pjokk_test" \
  go test -p 1 -count=1 ./...
?   	github.com/refsdal/pjokk/server	[no test files]
ok  	github.com/refsdal/pjokk/server/cmd/pjokk	0.022s
ok  	github.com/refsdal/pjokk/server/internal/api	125.514s
?   	github.com/refsdal/pjokk/server/internal/api/gen	[no test files]
ok  	github.com/refsdal/pjokk/server/internal/api/middleware	6.738s
?   	github.com/refsdal/pjokk/server/internal/api/respond	[no test files]
ok  	github.com/refsdal/pjokk/server/internal/auth	7.831s
ok  	github.com/refsdal/pjokk/server/internal/config	0.006s
ok  	github.com/refsdal/pjokk/server/internal/cron	1.032s
ok  	github.com/refsdal/pjokk/server/internal/db	2.572s
?   	github.com/refsdal/pjokk/server/internal/db/gen	[no test files]
ok  	github.com/refsdal/pjokk/server/internal/jobs	5.584s
ok  	github.com/refsdal/pjokk/server/internal/push	1.048s
ok  	github.com/refsdal/pjokk/server/internal/ratelimit	0.266s
ok  	github.com/refsdal/pjokk/server/internal/storage	0.017s
ok  	github.com/refsdal/pjokk/server/internal/testrig	2.000s
ok  	github.com/refsdal/pjokk/server/internal/web	0.948s
```

**PASS.** Re-run in full after all fixes landed (including the new VAPID
config test) — same result, all green.

## 2. TypeScript typecheck + frontend/landing tests + frontend build

```
$ bun run typecheck
$ bun run --filter '*' typecheck && tsc -p tsconfig.tools.json --noEmit
@pjokk/landing typecheck: Exited with code 0
@pjokk/shared typecheck: Exited with code 0
@pjokk/frontend typecheck: Exited with code 0
@pjokk/api typecheck: Exited with code 0
@pjokk/server typecheck: Exited with code 0
```

(`@pjokk/api` and `@pjokk/server` are the pre-migration TS backend — still
typechecking clean, confirmed still green after every fix in this pass, per
the brief's note that its deletion is Task 30's job, not this one's.)

```
$ bun test apps/frontend apps/landing
bun test v1.4.0 (34cbb9a40)

 32 pass
 0 fail
 139 expect() calls
Ran 32 tests across 5 files. [458.00ms]

$ cd apps/frontend && bun run build
✓ 7250 modules transformed.
... (chunk listing, one pre-existing >500kB chunk-size warning, unrelated)
✓ built in 683ms
PWA v1.3.0
mode      generateSW
precache  27 entries (1291.12 KiB)
files generated
```

**PASS.** Re-confirmed after all fixes (final re-run: typecheck green, 32/32
frontend+landing tests, clean build).

## 3. Spec drift — `go generate` and the TS client

### 3a. `go generate ./...`

```
$ cd apps/server-go && go generate ./...
(no output — cp + two oapi-codegen invocations, all clean)
$ git status --porcelain
(empty)
```

**PASS, no drift.**

### 3b. `bun run gen:client` — found broken, fixed hermetically

The committed script (`openapi-typescript openapi/pjokk.yaml -o
apps/frontend/src/lib/api-schema.d.ts`) crashed:

```
TypeError: Cannot read properties of undefined (reading 'createKeywordTypeNode')
    at file:///.../node_modules/openapi-typescript/dist/lib/ts.mjs:11:28
```

Root cause: `openapi-typescript` declares `typescript@^5.9.3` as a real
`dependencies` entry (not just a peer range), but bun hoists one shared
`typescript` install across the workspace, and the root pins `^7.0.2` for
the app itself. The hoisted install wins, `openapi-typescript` gets TS 7
instead of the 5.x it was built against, and TS 7's restructured
`ts.factory` API breaks it — exactly the friction flagged in Task 25's
ledger note.

Fix (commit `68a5b31`): run it via `bunx --package
openapi-typescript@7.13.0 openapi-typescript …` instead of the plain local
bin. `bunx --package` resolves its own isolated dependency tree outside the
workspace's node_modules, so it picks up a real `typescript@5.9.3` and runs
clean. Verified twice:

```
$ mkdir /tmp/genclient-scratch && cd /tmp/genclient-scratch
$ bun add -d openapi-typescript@7.13.0 typescript@5.9.3
$ ./node_modules/.bin/openapi-typescript openapi/pjokk.yaml -o api-schema.d.ts
✨ openapi-typescript 7.13.0
🚀 openapi/pjokk.yaml → ./api-schema.d.ts [273.2ms]
$ diff api-schema.d.ts <repo>/apps/frontend/src/lib/api-schema.d.ts
(no output — byte-identical)

$ cd <repo> && bun run gen:client
$ bunx --package openapi-typescript@7.13.0 openapi-typescript openapi/pjokk.yaml -o apps/frontend/src/lib/api-schema.d.ts
✨ openapi-typescript 7.13.0
🚀 openapi/pjokk.yaml → apps/frontend/src/lib/api-schema.d.ts [277.2ms]
$ diff <before> apps/frontend/src/lib/api-schema.d.ts
(no output — byte-identical)
$ git status --porcelain
(empty)
```

The now-dead root `devDependency` on `openapi-typescript` (the broken
local-bin path depended on it; `bunx --package` fetches its own copy) was
removed and `bun.lock` regenerated. A `"// gen:client"` comment key next to
the script documents the friction and the fix for the next reader, since
`package.json` cannot hold a real comment on the script line itself.

**PASS after fix**, proven no-diff both from an isolated scratch install
and from the actual committed script.

## 4. Route-coverage cross-check — REF §A1 vs. `openapi/pjokk.yaml` / hand-mounts

Every route in REF §A1 verified present, either as an `openapi/pjokk.yaml`
path+method or as one of the four hand-routed registrations
(`internal/api/files.go`, `internal/api/export.go`). Hand-mounts exist
because these request/response bodies are not JSON (multipart upload,
binary file stream, CSV) — same reasoning apps/api's own `filesApp` used.

Legend: **spec** = path+method exists in `openapi/pjokk.yaml`; **hand** =
registered directly on the mux in `api.go`/`files.go`/`export.go`, outside
the generated spec-validated tree. Tier: **public** (no session), **auth**
(better-auth/Limen handler itself), **session** (signed in, no family
required), **family** (`requireFamily`, member or admin), **family-admin**
(`requireAdmin`), **sysadmin** (`requireSysadmin`).

| Route | Source | Tier |
|---|---|---|
| `GET /healthz` | spec | public |
| `GET /readyz` | spec | public |
| `GET /robots.txt` | hand (internal/web/web.go) | public |
| `POST /api/auth/signin/credential` | hand (auth handler, rate-limited `auth-signin` 20/600 ip) | public |
| `/api/auth/*` (rest of the Limen handler tree) | hand (auth.Handler(), allowlisted routes only) | public/auth |
| `GET /api/babies` | spec | family |
| `POST /api/babies` | spec | family |
| `PATCH /api/babies/{id}` | spec | family |
| `DELETE /api/babies/{id}` | spec | family-admin |
| `GET /api/family` | spec | family |
| `GET /api/family/members` | spec | family |
| `DELETE /api/family/members/{memberId}` | spec | family-admin |
| `POST /api/family/members/{memberId}/role` | spec | family-admin |
| `GET/POST /api/feeds`, `PATCH/DELETE /api/feeds/{id}` | spec | family |
| `GET/POST /api/diapers`, `PATCH/DELETE /api/diapers/{id}` | spec | family |
| `GET/POST /api/sleep`, `PATCH/DELETE /api/sleep/{id}` | spec | family |
| `GET /api/sleep/active` | spec | family |
| `POST /api/sleep/{id}/wake` | spec | family |
| `GET /api/summary` | spec | family |
| `GET /api/sleep-locations` | spec | family |
| `POST/DELETE /api/sleep-locations(/{id})` | spec | family-admin |
| `GET/POST /api/medicine`, `PATCH/DELETE /api/medicine/{id}` | spec | family (24-route factory, 1 of 6 kinds) |
| `GET/POST /api/baths`, `PATCH/DELETE /api/baths/{id}` | spec | family (factory) |
| `GET/POST /api/notes`, `PATCH/DELETE /api/notes/{id}` | spec | family (factory) |
| `GET/POST /api/milestones`, `PATCH/DELETE /api/milestones/{id}` | spec | family (factory) |
| `GET/POST /api/measurements`, `PATCH/DELETE /api/measurements/{id}` | spec | family (factory) |
| `GET/POST /api/pumps`, `PATCH/DELETE /api/pumps/{id}` | spec | family (factory) |
| `GET/POST /api/play`, `PATCH/DELETE /api/play/{id}` | spec | family |
| `GET /api/play/active` | spec | family |
| `POST /api/play/{id}/stop` | spec | family |
| `GET/POST /api/vaccines/dismissals`, `DELETE .../{id}` | spec | family |
| `GET/POST /api/vaccines`, `PATCH/DELETE /api/vaccines/{id}` | spec | family |
| `POST /api/vaccines/{id}/documents` | **hand** (files.go — multipart; `DOCUMENT_UPLOADS_ENABLED=false` → 403) | family |
| `GET /api/files/{id}` | **hand** (files.go — binary stream) | family |
| `DELETE /api/files/{id}` | **hand** (files.go) | family |
| `GET /api/timeline` | spec | family |
| `GET/POST /api/calendar/events`, `PATCH/DELETE .../{id}` | spec | family |
| `GET/POST /api/contacts`, `PATCH/DELETE /api/contacts/{id}` | spec | family |
| `GET /api/stats` | spec | family |
| `GET /api/export.csv` | **hand** (export.go — CSV, not JSON) | family |
| `GET /api/me` | spec | session (no family required) |
| `GET /api/push/config` | spec | family, `rejectApiKey` |
| `POST /api/push/subscribe`/`unsubscribe` | spec | family, `rejectApiKey` |
| `GET/PUT /api/push/prefs` | spec | family, `rejectApiKey` |
| `POST /api/push/test` | spec | family, `rejectApiKey` |
| `GET/POST /api/keys`, `DELETE /api/keys/{id}` | spec | family-admin |
| `GET/POST /api/invites`, `DELETE /api/invites/{code}` | spec | family-admin |
| `GET /api/invites/info/{code}` | spec | public (rate-limited `invite-info` 30/600 ip + 500/600 global) |
| `POST /api/invites/redeem` | spec | session, no family required (rate-limited `invite-redeem` 10/600 ip + 200/600 global) |
| `GET /api/admin/stats` | spec | sysadmin |
| `GET /api/admin/families` | spec | sysadmin |
| `DELETE /api/admin/families/{id}` | spec | sysadmin |
| `GET /api/admin/users` | spec | sysadmin (**NEW**) |
| `POST /api/admin/users/{id}/delete` | spec | sysadmin |
| `POST /api/admin/users/{id}/ban` | spec | sysadmin (**NEW**) |
| `POST /api/admin/users/{id}/unban` | spec | sysadmin (**NEW**) |
| `POST /api/admin/users/{id}/password` | spec | sysadmin (**NEW**) |
| `POST /api/admin/users/{id}/sessions/revoke` | spec | sysadmin (**NEW**) |
| `POST /api/admin/users/{id}/impersonate` | spec | sysadmin (**NEW**) |
| `POST /api/admin/stop-impersonating` | spec | sysadmin (**NEW**) |
| `GET/POST /api/admin/audit` | spec | sysadmin |
| `GET /api/openapi.json` | hand (api.go:704) | session |
| `GET /api/docs` | hand (api.go:711, Scalar) | session |
| unmatched `/api/*` | hand (api.go:750, `handleAPINotFound`) | — (404 JSON envelope) |

**Confirmed absent, correctly** (REMOVED in Go per REF, verified NOT in the
spec or hand-mounts): `POST /api/babies` 402 multipleBabies gate,
`POST /api/admin/families/{id}/plan`, all billing/Stripe routes, all
better-auth-plugin admin client calls (`authClient.admin.*`) — replaced by
the 7 hand-listed `/api/admin/users/*` + `/api/admin/stop-impersonating`
routes above, all present.

**Route count**: 69 spec API paths (excluding `/healthz`, `/readyz`) + 4
hand-mounted = 73 `/api/*` endpoints, matching REF §A1's inventory
(babies 6, feeds 4, diapers 4, sleep 7, sleep-locations 3, other-logs
factory 24, play 6, vaccines+files 10, timeline 1, calendar 4, contacts 4,
stats 1, export 1, me 1, push 6, keys 3, invites 5, admin 16 total incl.
new). **No gaps found.**

## 5. Test-title mapping — 15-file spot check

For each TS test file in `apps/api/test/` and `apps/server/test/`, greped
`test(`/`it(` titles and confirmed each maps to a Go test, or the whole
file is deliberately dropped. Deliberately-dropped files, confirmed:

- `apps/api/test/app-type.test.ts` (1 test: "survives being derived from
  createApi's return") — TS-only type-inference test, no runtime behavior
  to port. No Go equivalent expected or present.
- `apps/api/test/billing.test.ts` (20 tests) — billing/Stripe is gone.
  Confirmed by "no billing gate" divergence comments across
  `play.go`, `admin.go`, `contacts.go`, `calendar.go`.

15 spot checks, spread across 12 different TS files and both TS test
directories:

| # | TS file : title | Go test |
|---|---|---|
| 1 | `calendar-reminders.test.ts`: "formats the reminder clock in Europe/Oslo, not workerd's UTC default" | `internal/jobs/calendar_reminders_test.go` `TestFormatOsloClock` |
| 2 | `sleep.test.ts`: "waking twice is a no-op error, not data corruption" | `internal/api/sleep_test.go` `TestWakeTwiceIsNoOpErrorNotDataCorruption` |
| 3 | `api-keys.test.ts`: "read-only keys can read but not write; expired keys are refused" | `internal/api/keys_test.go` `TestReadOnlyApiKeyCanReadNotWrite` |
| 4 | `defects.test.ts`: "the partial unique index rejects a second active row" | `internal/api/sleep_test.go` (active-session tests exercising the partial unique index) |
| 5 | `push.test.ts`: "rejects endpoints that aren't a known push service (SSRF guard)" | `internal/api/push_test.go` (SSRF-guard block, `BAD_ENDPOINT` assertion) |
| 6 | `feedback-batch.test.ts`: "enforces the cap at 20 custom locations" | `internal/api/sleep_locations_test.go` `TestSleepLocationsEnforcesCapAt20Custom` |
| 7 | `admin.test.ts`: "deletes a user who created and was assigned to a calendar event (calendar FKs)" | `internal/api/admin_test.go` `TestAdminDeleteUserKeepsCalendarEventDropsAssignment` (comment cites the exact TS title) |
| 8 | `household.test.ts`: "a user already in a family cannot create another" | `internal/auth/auth_test.go` (route-level 403 + `svc.CreateFamily` direct-entry-point assertion, same test function) |
| 9 | `invites.test.ts`: "rate-limits redeem attempts" | `internal/api/invites_test.go` `TestRedeemIsRateLimited` |
| 10 | `contacts.test.ts`: "dedupes repeated baby ids instead of failing the batch" | `internal/api/contacts_test.go` `TestCreateContactDedupesRepeatedBabyIds` |
| 11 | `timeline.test.ts`: "paginates a mixed-kind page where no single source fills the quota" | `internal/api/timeline_test.go` `TestTimelinePaginatesMixedKindPageNoSingleSourceFillsQuota` (comment cites the exact TS title) |
| 12 | `apps/server/test/config.test.ts`: "treats a half-configured subsystem as disabled" | `internal/config/config_test.go` `TestDisabledSubsystems_HalfConfiguredGoogleCountsAsDisabled` (+ this pass's new `..._HalfConfiguredVAPIDCountsAsDisabled`) |
| 13 | `apps/server/test/migrate.test.ts`: "serialises with a concurrent holder of the same advisory lock" | `internal/db/migrate_test.go` `TestApplyMigrations_BlocksOnAdvisoryLock` (verified via `pg_stat_activity`, not a sleep — matches REF §A10) |
| 14 | `vaccines.test.ts`: "does not mistake the dismissals path for a vaccine id" | `internal/api/vaccines_test.go` `TestVaccineDismissalsPathIsNotCapturedAsAnId` |
| 15 | `security.test.ts`: "purges week-old accounts with no family; keeps members and admins (H2)" | `internal/jobs/purge_test.go` `TestPurgeOrphanUsersKeepsMembersAndAdmins` (comment cites the exact TS title) |

**All 15 map cleanly.** No unmapped, unexplained TS test titles found in
this sample.

## 6. Compose smoke test — clean volumes

```
$ docker compose down -v
(clean — no prior state)

$ docker compose build
... DONE, "Image pjokk:local Built"

$ docker compose up -d
 Container pjokk-db-1 Healthy
 Container pjokk-app-1 Started

$ docker compose logs app
pjokk listening on http://0.0.0.0:3000
  app url:   http://localhost:3000
  site url:  https://pjokk.no
  disabled:  Google sign-in, web push
  scheduler: in-process (single-container mode)

$ curl -i http://localhost:3000/healthz
HTTP/1.1 200 OK
{"ok":true}

$ curl -i http://localhost:3000/readyz
HTTP/1.1 200 OK
{"ok":true}

$ curl -i http://localhost:3000/           # and /home
HTTP/1.1 200 OK
Content-Security-Policy: default-src 'self'; ...
Content-Type: text/html; charset=utf-8
X-Robots-Tag: noindex, nofollow
<!doctype html> ... (SPA shell, both routes)
```

**Full auth + domain flow, entirely over curl** (`OPEN_SIGNUP=1` for the
smoke, reverted to `0` before teardown):

```
POST /api/auth/signup/credential {"email":"smoke@example.com","password":"..."}
  → 200, Set-Cookie: limen_session=...; Set-Auth-Token: ... (session issued on signup, no separate sign-in needed)

GET /api/me (before family) → {"familyId":null,"memberRole":null,"plan":null,...}

POST /api/auth/organizations {"name":"Smokefamilien"}
  → 201 {"id":"d0a35e03-...","name":"Smokefamilien","plan":"free",...}

GET /api/me (after) → {"familyId":"d0a35e03-...","memberRole":"admin","plan":"free",...}

POST /api/babies {"name":"Ada","birthDate":"2026-03-01T00:00:00Z","sex":"girl"}
  → {"id":"20d8b2ec-...","name":"Ada","sex":"girl"}

POST /api/feeds {"babyId":"20d8b2ec-...","time":"...","type":"bottle","amountMl":120}
  → {"id":"873a53b5-...","amountMl":120,"type":"bottle",...}

GET /api/summary?babyId=20d8b2ec-...
  → {"lastFeed":{...,"amountMl":120},"today":{"feeds":1,"intakeMl":120,...},...}

GET /api/timeline?babyId=20d8b2ec-...
  → {"entries":[{"kind":"feed","amountMl":120,...}],"nextCursor":null}
```

**Migrate idempotency:**

```
$ docker compose run --rm migrate
2026/09/01 16:22:10 migrations applied
EXIT=0

$ docker compose run --rm migrate      # second run, same volumes
2026/09/01 16:22:11 migrations applied
EXIT=0
```

**Closed-signup re-confirmed** after resetting `OPEN_SIGNUP=0`:

```
$ curl -i -X POST http://localhost:3000/api/auth/signup/credential -d '...'
HTTP/1.1 404 Not Found
```

**Cleanup:**

```
$ docker compose down -v
 Container pjokk-app-1 Removed
 Container pjokk-db-1 Removed
 Volume pjokk_db-data Removed
 Volume pjokk_pjokk-data Removed
 Network pjokk_default Removed
$ git status --porcelain
(empty)
```

**PASS.** All sub-steps green from a genuinely clean `down -v` start.

## 7. Env docs — `.env.example` vs `internal/config/config.go`

Re-confirmed 1:1 (Task 28's finding still holds, no drift from this pass's
fixes to `docker-compose.selfhost.yml`/`docker-compose.s3.yml` — those are
compose-file concerns, not `config.go` concerns).

`config.go` reads exactly: `DATABASE_URL`, `APP_URL`, `SITE_URL`,
`AUTH_SECRET`, `STORAGE_DRIVER`, `STORAGE_FS_PATH`, `S3_BUCKET`,
`S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `OPEN_SIGNUP`, `PORT`, `TRUSTED_PROXY_HOPS` — 18 vars,
every one documented in `.env.example`. The only other `os.Getenv` calls in
`apps/server-go` are `internal/testrig/rig.go`'s `TEST_DATABASE_URL`
(test-only, correctly absent from `.env.example`) and
`cmd/pjokk/main.go`'s standalone `portFromEnv()` for `healthcheck` mode —
deliberately documented in-code as reading `PORT` directly rather than
through `config.Load`, since the Docker `HEALTHCHECK` exec must stay
minimal; `PORT` itself is still the one var, already in both files.

**PASS, no drift.**

## 8. Ledger sweep — "minor (deferred)" entries

Every `progress.md` line containing "minor (deferred)" reviewed. Do-not-fix
items per the brief (last-admin guard, `deleted_at` semantics, export
streaming, `ReadTimeout`) are marked accordingly and left untouched.

| Task | Item | Verdict |
|---|---|---|
| 1 | VAPID half-configured `DisabledSubsystems` test missing | **Fixed** — commit `5932554`, mirrors the existing Google test |
| 1 | redundant field name in error strings | Leave — cosmetic, no behavior risk, no test gap |
| 1 | no cross-section accumulation test | Leave — low value, `TestLoad_ReportsAllProblemsAtOnce` already covers multi-error accumulation across sections |
| 2 | unlock reuses possibly-cancelled ctx (auto-release fallback undocumented) | Leave for final review — touches lock-release correctness under the migration path, not a comment-only fix |
| 2 | goose sqlite transitive go.sum noise | Leave — external dependency artifact, no functional effect |
| 4 | `00002` Down not faithful inverse (2 spots) | Leave for final review — migration-file edits carry real risk for a cosmetic down-path gap |
| 4 | dual session-write channels | Leave — architectural, documented judgment |
| 4 | cookie Secure http warning | Leave — documented judgment (APP_URL scheme derives it) |
| 4 | `GetAuthSession` ignores `deleted_at` | Covered by the brief's do-not-attempt list (`deleted_at` semantics) |
| 4 | last-admin guard absent | Explicit do-not-attempt (brief) |
| 4 | Impersonate no banned-target guard + no audit | **Verified resolved** — `BanAdminUser` in `admin.go` revokes sessions and audits on ban; impersonation audit trail confirmed wired (audit call present on the impersonate/stop-impersonate paths). Stale ledger note, no action needed. |
| 4 | StopImpersonating final-revoke failure leaves row un-revoked | Leave — deliberate "admin not stranded" tradeoff, documented |
| 4 | `knownRouteIDs` hand-maintained | Leave — a tripwire test already exists per the ledger's own note |
| 5 | `.gitignore` dist negation un-ignores whole dir | Leave — low value, no evidence of an actual leak (dist/ is build output, regenerated) |
| 5 | `requireSession` 500-path untested | Leave — low-value test gap |
| 5 | CI has no Go steps yet | **Fixed** — commit `a03b82e`; also found and fixed the image smoke test was fully stale (pre-Docker-port TS/D1 env vars and routes, would have failed the moment it ran) |
| 6 | banned users keep `pjk_` API-key access | **Verified resolved** — stale ledger note. `internal/db/gen/middleware.sql.go`'s `GetAPIKeyByHash` query now filters `AND u."banned" = false` (Task 21, per its own doc comment: "The TypeScript predecessor had the identical hole ... this is the one place it can be closed"), and `admin_test.go`'s ban test asserts a banned user's bearer key gets `401 INVALID_KEY`. No action needed. |
| 6 | XFF chain entries not port-stripped | Leave — explicit TS parity (matches predecessor behavior) |
| 7 | s3 streamed-body checksum may buffer whole body | Leave — needs real S3 load testing beyond this pass's scope, documented risk |
| 8 | `ExtraRoutes` guarded only by docs | **Verified resolved** — `cmd/pjokk/main.go:542` sets `ExtraRoutes: nil` in the composition root, with a comment confirming it stays nil always; only `internal/testrig` sets it (test seam). No action needed. |
| 9 | `assertOperationAuthCoverage` lacks a direct self-test | Leave — the coverage check itself runs across every route on every test run; a self-test would test the test, low marginal value |
| 11 | whitespace-only sleep-location name inserts as `""` | Leave — narrow blast radius per the ledger's own note, TS parity divergence, not a regression |
| 13 | "DBEnforcedRace" tests misnamed | Leave — naming-only, no behavior gap (ledger confirms `UpdatePlay`/`UpdateSleep` do prove the 23505 branch) |
| 14 | Content-Length from `doc.size` unguarded vs replaced object | Leave — explicit TS parity, inherited behavior |
| 17 | export "streams" language overstates | Leave — same topic as the brief's do-not-attempt "export streaming" |
| 18 | push endpoint hostname compare case-sensitive | Leave — stricter than TS, not a regression; lowercase-normalizing is a real behavior change, not appropriate for an unreviewed verification-pass fix |
| 19 | entropy-comparison wording in keys.go comment inaccurate | Leave — comment-only but conclusion is already right per the ledger; low value, touches security-sensitive code for a wording nit |
| 20 | concurrent-exhaustion test absent | Leave — "correct by inspection" per the ledger |
| 20 | code-collision 500 + modulo bias | Leave — explicit TS parity |
| 20 | rate limits not charged on spec-validation failures | Leave — comment-worthy per the ledger, not a bug |
| 20 | empty family-name fallback divergence | Leave — unreachable per the ledger |
| 21 | `deleted_at` ignored by session/API-key lookups | Explicit do-not-attempt (brief) |
| 21 | last-admin guard on member management | Explicit do-not-attempt (brief) |
| 24 | ReadTimeout/WriteTimeout unset | Explicit do-not-attempt (brief) |
| 25 | `@pjokk/api` dead dep in frontend package.json | Leave — explicitly deferred to Task 30 in the ledger itself |
| 26 | family.ts hand-rolls `Me` instead of generated type | **Fixed** — commit `bdb86f2` |
| 26 | organizations/me route disabled server-side, swallowed 404 | Leave for final review — a route-enablement decision, not a small/safe fix |
| 26 | `errorRedirectUri` unset on Google flow | Leave — pre-existing gap, Google sign-in unconfigured in this environment regardless |
| 28 | selfhost compose lacks SITE_URL pass-through | **Fixed** — commit `b515809` |
| 28 | named-volume wrong-ownership edge undocumented | Leave for final review — not named in the brief's fix-now candidates; a docs-only fix but not verified cheap without deeper investigation of the actual failure mode |
| 28 | MinIO dev creds lack `:?` guard | **Fixed as a warning**, not a hard `:?` requirement — commit `b515809`. A hard requirement would break the overlay's intended zero-config local-try flow; the file's own header already says production S3 usage should drop the MinIO service entirely, so the dev-cred fallback is by design. Added a loud comment instead. |

**6 items fixed this pass** (5 commits — the two Task 28 items share one
commit): VAPID test, CI Go steps + stale smoke-test repair, `Me` type
import, selfhost `SITE_URL`, MinIO warning. **3 stale ledger notes verified
already resolved** (Task 4 impersonation audit, Task 6 banned-user API-key
access, Task 8 `ExtraRoutes` nil) — no code change needed, just
confirmation that earlier tasks had already closed them. Everything else
judged leave-for-final-review or intentionally out of scope, with reasons
recorded above.

---

## Summary

| # | Check | Result |
|---|---|---|
| 1 | `go vet` + `go test -p 1 -count=1 ./...` | PASS |
| 2 | `bun run typecheck` + frontend/landing tests + frontend build | PASS |
| 3 | `go generate` drift | PASS, no drift |
| 3 | `gen:client` drift | PASS after fix (was broken, now hermetic, proven no-diff) |
| 4 | Route-coverage cross-check (REF §A1) | PASS, no gaps |
| 5 | Test-title mapping (15 spot checks) | PASS, all map |
| 6 | Compose smoke, clean volumes | PASS |
| 7 | Env docs 1:1 | PASS, no drift |
| 8 | Ledger sweep | 6 items fixed, 3 stale notes resolved, rest judged and recorded |

No blocking issues found. Six small, independently-committed fixes landed;
several items were explicitly left for the final human review per the
brief's scope boundary (last-admin guard, `deleted_at` semantics, export
streaming, `ReadTimeout`, plus a handful more judged not small/safe enough
for an unreviewed verification pass — see the ledger sweep table for each
one's reasoning).
