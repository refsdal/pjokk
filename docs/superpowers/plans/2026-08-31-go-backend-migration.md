# Go Backend Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Bun/Hono backend with a Go backend (stdlib net/http, Limen auth, pgx+sqlc, embedded Vite SPA, scratch multi-arch image) at full feature parity minus billing, ending in a PR.

**Architecture:** Spec-first: `openapi/pjokk.yaml` drives oapi-codegen (Go strict-server) and openapi-typescript/openapi-fetch (frontend). `cmd/pjokk` is the sole composition root building a `Deps` struct of interfaces; `internal/api` handlers never read env or construct collaborators. Dispatch modes, tenancy middleware, advisory-lock migration, and cron semantics are ported verbatim from the TS backend.

**Tech Stack:** Go 1.27, `github.com/thecodearcher/limen` v0.2.1 (+ plugins), pgx/v5, sqlc, goose, oapi-codegen v2, kin-openapi validation middleware, aws-sdk-go-v2 (S3), SherClockHolmes/webpush-go, robfig/cron/v3, openapi-typescript + openapi-fetch, npm `limen-auth`.

**Spec:** `docs/superpowers/specs/2026-08-31-go-backend-migration-design.md`
**Parity contract:** `docs/superpowers/plans/2026-08-31-go-migration-reference.md` (cited below as REF §…). The TS sources under `apps/api` and `apps/server` are ground truth when REF is ambiguous.

## Global Constraints

- Toolchain: `export PATH=$HOME/.local/go/bin:$HOME/go/bin:$PATH` in EVERY shell that runs go/sqlc/oapi-codegen/goose.
- Go module path: `github.com/refsdal/pjokk/server` rooted at `apps/server-go/`.
- Tests run against real Postgres: `docker compose -f docker-compose.test.yml up -d` → `TEST_DATABASE_URL` default `postgres://pjokk:pjokk@127.0.0.1:55432/pjokk_test`. Run Go tests with `-p 1` (packages share one database).
- Error envelope on every API error: `{"error": string, "code": string}` with the exact codes in REF §A1/§A5.
- Every domain query is family-scoped (REF §A5). No handler touches a domain table without familyId.
- Postgres rules: timestamptz everywhere; double precision for measured values; unique violations by SQLSTATE 23505 (`pgconn.PgError.Code`); `"users"` etc. quoted in hand-written SQL; interval arithmetic as `col - (n * interval '1 minute')`.
- Only `internal/auth` imports Limen packages. Pin Limen modules to exact versions in go.mod.
- Billing is GONE: no Stripe imports anywhere; `plan` column persists (always `free`) and `/api/family` still returns it.
- Conventional Commits; every commit compiles and its tests pass.
- Codegen is committed: after editing `openapi/pjokk.yaml` or `queries/*.sql`, run `go generate ./...` (wired to oapi-codegen + sqlc) and commit the output.
- The TS backend stays untouched and green until Task 30 removes it.

---

### Task 1: Go module scaffold + config loader

**Files:**
- Create: `apps/server-go/go.mod`, `apps/server-go/cmd/pjokk/main.go` (stub printing usage), `apps/server-go/internal/config/config.go`
- Test: `apps/server-go/internal/config/config_test.go`

**Interfaces:**
- Produces: `config.Load(env map[string]string) (*Config, error)` — `Config` struct with fields per REF §A3 (`DatabaseURL, AppURL, SiteURL, AuthSecret, StorageDriver, S3Bucket, S3Endpoint, S3AccessKeyID, S3SecretAccessKey, S3Region, StorageFSPath, GoogleClientID, GoogleClientSecret, VAPIDPublicKey, VAPIDPrivateKey, OpenSignup bool, Port int, TrustedProxyHops int`). `Load` collects ALL problems into one error (`errors.Join` or a joined message listing each bad field). Also `func (c *Config) DisabledSubsystems() []string` returning "Google sign-in" / "web push" per REF §A3.
- Produces: `config.FromOS() (*Config, error)` wrapping `os.Environ()`.

- [ ] **Step 1:** `mkdir -p apps/server-go/cmd/pjokk apps/server-go/internal/config && cd apps/server-go && go mod init github.com/refsdal/pjokk/server` (Go 1.27 in go.mod).
- [ ] **Step 2:** Write failing tests porting `apps/server/test/config.test.ts` behavior: minimal valid config loads; missing DATABASE_URL/APP_URL/AUTH_SECRET each reported; ALL problems reported at once (assert one error mentions every bad field); SITE_URL defaults `https://pjokk.no`; PORT coerces "8080"→8080 and rejects "abc"/0; TRUSTED_PROXY_HOPS defaults 0, rejects -1; AUTH_SECRET < 32 bytes rejected; `STORAGE_DRIVER=fs` requires STORAGE_FS_PATH; `STORAGE_DRIVER=s3` requires the four S3 vars; invalid driver rejected; DisabledSubsystems cases (unconfigured names both, fully configured empty, half-configured Google counts as disabled).
- [ ] **Step 3:** `go test ./internal/config/` — expect compile failure/FAIL.
- [ ] **Step 4:** Implement `config.go`. Plain stdlib: read map, validate, accumulate `[]string` of problems, `fmt.Errorf("invalid configuration:\n  %s", strings.Join(problems, "\n  "))`.
- [ ] **Step 5:** `go test ./internal/config/` — PASS. `go vet ./...` clean.
- [ ] **Step 6:** Commit `feat(go): scaffold module and config loader`.

---

### Task 2: Database schema (goose) + advisory-lock migrator

**Files:**
- Create: `apps/server-go/internal/db/migrations/00001_init.sql` (goose format, full schema), `apps/server-go/internal/db/migrate.go`, `apps/server-go/internal/db/migrations.go` (`//go:embed migrations/*.sql`)
- Test: `apps/server-go/internal/db/migrate_test.go`

**Interfaces:**
- Produces: `db.ApplyMigrations(ctx context.Context, databaseURL string) error` — opens a DEDICATED single `pgx.Conn`, `select pg_advisory_lock(72450001)`, runs goose (embedded FS, `goose.SetBaseFS`, provider API on that single conn via stdlib shim), `defer pg_advisory_unlock + close`. `db.MigrationLockKey = 72450001` (const, comment: MUST NEVER CHANGE).
- Produces: the complete schema of REF §A2. Limen auth tables: bootstrap by writing the DDL directly in `00001_init.sql` (users/sessions/accounts/verifications/rate_limits/organizations/organization_members/organization_member_roles/organization_roles/organization_invitations with the columns listed in REF §B4 + our additional columns from REF §A2). Task 4 verifies Limen accepts this schema at runtime and adjusts by ADDING a migration if Limen's actual column expectations differ (use `limen generate migrations` diff output to find mismatches; keep 00001 authoritative once green).

- [ ] **Step 1:** Write `00001_init.sql`: `-- +goose Up` section with ALL tables, checks, and indexes from REF §A2 — including the two partial unique indexes, `vaccine_dismissal(baby_id, slot_key)` unique, composite PKs, and `rate_limit` (ours). `-- +goose Down`: `DROP TABLE` in reverse dependency order.
- [ ] **Step 2:** Write failing test porting `apps/server/test/migrate.test.ts`: (a) ApplyMigrations against TEST_DATABASE_URL creates `baby` (`to_regclass`); (b) idempotent — second call no error; (c) advisory lock genuinely blocks: hold `pg_advisory_lock(72450001)` on one conn, start ApplyMigrations in a goroutine, poll `pg_stat_activity` for `wait_event_type='Lock' or wait_event='advisory'` on our lock, then release and assert completion. Drop schema (`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`) at test start.
- [ ] **Step 3:** Run — FAIL. **Step 4:** Implement `migrate.go` + embed. **Step 5:** Run — PASS.
- [ ] **Step 6:** Commit `feat(go): full schema migration under the advisory lock`.

---

### Task 3: sqlc + test rig

**Files:**
- Create: `apps/server-go/sqlc.yaml`, `apps/server-go/internal/db/queries/core.sql` (babies, families, members-join for tenancy, tombstone upsert), `apps/server-go/internal/db/db.go` (pgx pool constructor + `EnsureTombstone`), `apps/server-go/internal/testrig/rig.go`
- Test: `apps/server-go/internal/db/db_test.go`

**Interfaces:**
- Produces: `db.New(ctx, url string) (*pgxpool.Pool, error)`; generated package `internal/db/gen` with `gen.New(pool)` Querier; `testrig.Setup(t *testing.T) *Rig` where `Rig{Pool *pgxpool.Pool, Q *gen.Queries}` — applies migrations once per process (sync.Once), truncates ALL public tables (dynamic `pg_tables` query, `TRUNCATE … RESTART IDENTITY CASCADE`, excluding `goose_db_version`) per test, registers cleanup. `db.TombstoneID = "user_tombstone"`, `db.EnsureTombstone(ctx, pool)` (`INSERT … ON CONFLICT DO NOTHING`, per REF §A2).
- Produces: `db.IsUniqueViolation(err error) bool` — `errors.As` → `*pgconn.PgError`, code `23505`.

sqlc.yaml:
```yaml
version: "2"
sql:
  - engine: "postgresql"
    queries: "internal/db/queries"
    schema: "internal/db/migrations"
    gen:
      go:
        package: "gen"
        out: "internal/db/gen"
        sql_package: "pgx/v5"
        emit_pointers_for_null_types: true
```

- [ ] **Step 1:** Write sqlc.yaml + first queries (CreateBaby, ListBabies, GetBaby, UpdateBaby, DeleteBaby — all `WHERE family_id = $1`; GetFamilyBySlugless `SELECT id,name,slug,plan FROM organizations WHERE id=$1`; GetMembership `SELECT om.*, o.plan FROM organization_members om JOIN organizations o ON o.id=om.organization_id WHERE om.organization_id=$1 AND om.user_id=$2` — adjust to actual role storage: role lives in `organization_member_roles`; write the join accordingly and note it in the query comment).
- [ ] **Step 2:** `sqlc generate` — commit generated code. Write failing db_test: rig truncation isolates two tests; IsUniqueViolation true for duplicate org slug, false for FK violation; EnsureTombstone idempotent.
- [ ] **Step 3:** FAIL → implement rig + db.go → PASS (`go test -p 1 ./...`).
- [ ] **Step 4:** Commit `feat(go): sqlc pipeline and real-Postgres test rig`.

---

### Task 4: Limen wiring + auth isolation layer

**Files:**
- Create: `apps/server-go/internal/auth/auth.go` (Service interface + Limen impl), `apps/server-go/internal/auth/core_plugin.go`, `apps/server-go/internal/auth/session.go`
- Test: `apps/server-go/internal/auth/auth_test.go`

**Interfaces:**
- Produces:
```go
type Session struct {
    UserID, Name, Email, Role string // Role "" or "admin"
    Banned          bool
    ActiveFamilyID  string // "" when none
    Token           string
    ImpersonatedBy  string // "" when not impersonating
}
type Service interface {
    Handler() http.Handler                          // mount at /api/auth/
    SessionFromRequest(r *http.Request) (*Session, error) // nil,nil when no session
    CreateUser(ctx, name, email, password string) (userID string, err error) // password "" ⇒ OAuth-less user, unusable password
    CreateFamily(ctx, userID, name string) (familyID string, err error)
    AddMember(ctx, familyID, userID, role string) error
    RemoveMember(ctx, familyID, memberID string) error
    SetMemberRole(ctx, familyID, memberID, role string) error
    SetActiveFamily(ctx, sessionToken, familyID string) error
    SetPassword(ctx, userID, newPassword string) error
    RevokeAllSessions(ctx, userID string) error
    Impersonate(ctx context.Context, w http.ResponseWriter, r *http.Request, adminSession *Session, targetUserID string) error
    StopImpersonating(ctx context.Context, w http.ResponseWriter, r *http.Request, s *Session) error
}
func New(cfg Config) (Service, error) // Config{AppURL, Secret, GoogleClientID/Secret, OpenSignup bool, Pool *pgxpool.Pool}
```
- Construction per REF §B2 (base path `/api/auth`, `WithHTTPDisabledPaths("signup")` unless OpenSignup, additional user fields `name/image/role/banned/ban_reason`, org additional field `plan`). `SessionFromRequest` reads Limen session then loads name/role/banned/active-org via one sqlc query on `users`+`sessions` (our columns — do NOT depend on Limen exposing them). Banned users: return nil session (treat as signed out).
- `core_plugin.go`: minimal `limen.Plugin` whose `Initialize(core *limen.LimenCore) error` stores the pointer; `Impersonate` uses `core.CreateSession` with metadata `{"impersonated_by": adminID, "admin_token": adminToken}`; `StopImpersonating` restores admin cookie from metadata + revokes current token (REF §B3).

- [ ] **Step 1:** `go get` the Limen modules (pinned). Write failing tests: construct Service against the rig DB (Google creds fake, OpenSignup false); assert (a) `POST /api/auth/signup/credential` through Handler returns 404/405 (disabled); (b) CreateUser + `POST /api/auth/signin/credential` (httptest) yields a cookie whose SessionFromRequest returns the user; (c) CreateFamily+AddMember+SetActiveFamily reflected in Session.ActiveFamilyID; (d) Impersonate switches SessionFromRequest to target with ImpersonatedBy set; StopImpersonating restores admin.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. If Limen rejects the Task-2 schema (missing/renamed columns), add migration `00002_limen_align.sql` with the diff and note it in the commit body. Inspect what Limen writes into its `rate_limits.key` — if a raw IP appears, disable its HTTP limiter via `WithHTTPRateLimiter` no-op and rely on ours (record finding in DECISIONS.md).
- [ ] **Step 4:** PASS → commit `feat(go): limen auth behind the isolation interface`.

---

### Task 5: OpenAPI skeleton, server shell, embedded SPA

**Files:**
- Create: `openapi/pjokk.yaml` (info + error schema + /healthz,/readyz), `apps/server-go/internal/api/gen/cfg-server.yaml` + `cfg-types.yaml` (oapi-codegen configs, `std-http-server`, strict), `apps/server-go/internal/api/api.go` (Server struct + Deps), `apps/server-go/internal/api/respond.go` (JSON + error envelope helpers), `apps/server-go/internal/web/web.go` (embed + SPA fallback + headers per REF §A9), `apps/server-go/internal/web/dist/index.html` (placeholder committed; real build overwrites in Docker), `apps/server-go/internal/web/scalar.html`, `apps/server-go/generate.go` (`//go:generate` lines)
- Test: `apps/server-go/internal/web/web_test.go`, `apps/server-go/internal/api/api_test.go`

**Interfaces:**
- Produces: `api.Deps{Pool *pgxpool.Pool; Q *gen.Queries; Auth auth.Service; Storage storage.Storage; RateLimit ratelimit.Store; Push push.Sender; Now func() time.Time; AppURL string; VAPIDPublicKey string; TrustedProxyHops int}` (storage/ratelimit/push interfaces land in Tasks 6–7; declare them in their packages now as interfaces only if needed — otherwise reorder imports when those tasks land).
- Produces: `api.NewHandler(d Deps) http.Handler` — mounts auth handler, spec-validation middleware (kin-openapi `nethttp-middleware` on `/api/` except `/api/auth/`, `/api/files/`, `/api/export.csv`, `/api/vaccines/{id}/documents`), generated strict server routes, JSON 404 for unmatched `/api/*`; `web.Handler(apiHandler http.Handler) http.Handler` — headers, robots.txt, embedded assets, SPA fallback.
- Validation failure → `400 {"error":"Invalid request","code":"VALIDATION"}` (custom ErrorHandler on the middleware; `issues` array optional — frontend only reads error/code).

- [ ] **Step 1:** Author the yaml skeleton with `Error` schema (`{error, code}` required), `/healthz` + `/readyz`, and shared parameter components (`babyIdQuery`, `limitQuery`). Wire `go generate` (oapi-codegen server+types from `../../openapi/pjokk.yaml`). Generate, commit generated code.
- [ ] **Step 2:** Failing tests: /healthz 200 `{"ok":true}` without DB; /readyz 503 envelope when pool closed, 200 otherwise; unmatched `/api/nope` → 404 NOT_FOUND JSON; `/` serves index.html with ALL REF §A9 headers incl. exact CSP; `/robots.txt` disallow; unknown non-API path → index.html 200.
- [ ] **Step 3:** FAIL → implement → PASS.
- [ ] **Step 4:** Add `/api/docs` (session-gated, serves scalar.html referencing `/api/openapi.json`, which serves the embedded yaml as JSON via kin-openapi load→MarshalJSON) — test 401-without-session behavior returns envelope.
- [ ] **Step 5:** Commit `feat(go): http shell, spec pipeline, embedded SPA serving`.

---

### Task 6: Rate limiting + middleware chain

**Files:**
- Create: `apps/server-go/internal/ratelimit/ratelimit.go` (Store iface + Postgres impl + `ClientIP`), `apps/server-go/internal/api/middleware/middleware.go` (context keys, sessionMiddleware, RequireFamily, RequireAdmin, RequireSysadmin, APIKeyAuth, RejectAPIKey, RateLimit)
- Create: `apps/server-go/internal/db/queries/middleware.sql` (rate-limit upsert, api-key join, audit insert, membership+plan join)
- Test: `apps/server-go/internal/ratelimit/ratelimit_test.go`, `apps/server-go/internal/api/middleware/middleware_test.go`

**Interfaces:**
- Produces (exact semantics REF §A5): `ratelimit.Store{Hit(ctx,key,windowSeconds)(int,error); Sweep(ctx,now)(int,error)}`, `ratelimit.NewPostgres(q *gen.Queries)`; `ratelimit.ClientIP(xff string, socketAddr string, trustedHops int) string`; `middleware.RateLimit(store, name string, limit, windowSeconds int, global bool, hops int) func(http.Handler) http.Handler`.
- Produces: `middleware.FamilyCtx{UserID, UserName, FamilyID, MemberRole, Plan string; IsAPIKey bool; ImpersonatedBy string}`, `middleware.Family(r *http.Request) FamilyCtx`, and the chain constructors taking `Deps`.
- SQL upsert: `INSERT INTO rate_limit (key,count,expires_at) VALUES ($1,1,$2) ON CONFLICT (key) DO UPDATE SET count = rate_limit.count + 1 RETURNING count`.
- APIKeyAuth per REF §A5 item 5 (SHA-256 hex, join through organizations, last_used_at throttle 5 min, READ_ONLY_KEY on non-GET/HEAD).

- [ ] **Step 1:** Failing tests: ClientIP table-driven (hops 0 ignores XFF; hops 1 picks rightmost; hops > chain length floors to leftmost; empty → socket → "unknown"); Hit increments within window and resets across windows; Sweep deletes expired; RequireFamily 401/403-NO_FAMILY/403-NOT_MEMBER/success paths (build users/orgs via auth.Service from Task 4); APIKeyAuth full matrix (valid, unknown → INVALID_KEY, expired → KEY_EXPIRED, revoked → INVALID_KEY, read-only PATCH → READ_ONLY_KEY, sets IsAPIKey); RejectAPIKey 403; RequireSysadmin role gate; impersonated non-GET writes `impersonated.write` audit row.
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3:** Commit `feat(go): tenancy middleware, api-key auth, hashed-ip rate limiting`.

---

### Task 7: Storage drivers (s3/fs/memory) + push sender

**Files:**
- Create: `apps/server-go/internal/storage/storage.go` (interface REF §A6), `s3.go`, `fs.go`, `memory.go`, `apps/server-go/internal/push/push.go` (webpush impl + interface)
- Test: `apps/server-go/internal/storage/storage_test.go` (one conformance suite run against fs + memory; s3 impl covered by compose smoke later), `apps/server-go/internal/push/push_test.go`

**Interfaces:**
- Produces: `storage.Storage` (REF §A6), `storage.NewS3(cfg)`, `storage.NewFS(root string) (Storage, error)` (fails if root unwritable; Put = temp file in root + `os.Rename`; keys may contain `/` → subdirs; List walks with prefix filter, UploadedAt = ModTime), `storage.NewMemory()`.
- Produces: `push.Sender{ToUser(ctx,userID,payload)(int,error)}`; `push.New(q *gen.Queries, vapidPublic, vapidPrivate, appURL string)` using `github.com/SherClockHolmes/webpush-go`; deletes subscription rows on 404/410 responses; TTL 3600; subject falls back to `https://pjokk.no` when appURL isn't https. `push.NewNoop()` for tests/unconfigured.
- Test push delivery against an `httptest.Server` standing in for the push service (assert prune on 410).

- [ ] **Step 1:** Failing conformance tests (Put/GetStream found+not-found/Delete multi/List prefix+dates; fs: crash-safety = no partial file visible mid-Put, nested keys, unwritable root errors at construction). Push: 201 counts, 410 prunes row, missing VAPID → 0 sends.
- [ ] **Step 2:** FAIL → implement → PASS. **Step 3:** Commit `feat(go): s3/fs/memory storage drivers and web push sender`.

---

### Task 8: API test harness (rig-level HTTP helpers)

**Files:**
- Create: `apps/server-go/internal/testrig/http.go`
- Test: `apps/server-go/internal/testrig/http_test.go`

**Interfaces:**
- Produces (port of `apps/api/test/helpers.ts`): `testrig.App(t) *AppRig` — full `api.NewHandler` wired with rig pool, memory storage, noop-or-recording push (`AppRig.Push *RecordingPush`), fixed VAPID test keys, `Now` overridable. Methods: `SignUp(name,email) userID`, `SignIn(email) cookie` (drives real `/api/auth/signin/credential`; fixed password constant), `NewFamily(name, adminEmail) (familyID, cookie)` (user+family+member+active via auth.Service), `NewBaby(familyID, name) babyID`, `Do(method, path, cookie string, body any) *Result` where `Result{Status int, JSON map[string]any, Raw []byte, Header http.Header}`, `DoArray` for list responses.

- [ ] **Step 1:** Write + a self-test (sign up, sign in, create family+baby, GET /api/babies → the baby, no-cookie → 401 UNAUTHENTICATED). FAIL until glue works (this is also the first end-to-end proof of Tasks 4–6 composed).
- [ ] **Step 2:** PASS → commit `test(go): http test rig`.

---

### Task 9: Babies, family, members, /api/me

**Files:**
- Modify: `openapi/pjokk.yaml` (paths from REF §A1 babies.ts + `/api/me` + `/api/family/members/{memberId}`[+`/role`]), `apps/server-go/internal/db/queries/*.sql`
- Create: `apps/server-go/internal/api/babies.go`, `me.go`
- Test: `apps/server-go/internal/api/babies_test.go`

Behavior: REF §A1 babies.ts exactly (minus 402); DELETE baby requires admin/owner role → 403; member management endpoints call auth.Service; `/api/me` shape per REF §A1. Port relevant assertions from `household.test.ts` (multi-baby now free, member list shape, role change, remove member) and `api-keys.test.ts` baby-sex cases.

- [ ] Steps: spec → generate → failing ported tests → implement (sqlc queries + handlers) → pass → commit `feat(go): babies, family and member management routes`.

---

### Task 10: Feeds + diapers

**Files:** spec paths; `queries/feeds.sql`, `queries/diapers.sql`; `internal/api/feeds.go`, `diapers.go`; tests porting `feedback-batch.test.ts` per-side-minutes cases + basic CRUD/tenancy assertions from `tenancy.test.ts` for these tables.

Behavior: REF §A1. Response includes `caretakerName` (JOIN users). PATCH with empty body is a no-op returning current row (defects.test.ts). Nullable-clears semantics: PATCH body fields explicitly null clear the column — model in spec with `nullable: true` and in Go with `*T` + presence map (decode into `map[string]json.RawMessage` first; the generated strict types are used for responses, requests for these PATCHes are hand-decoded — document this pattern in feeds.go and reuse it for all PATCH handlers).

- [ ] Steps: spec → generate → failing tests → implement → pass → commit `feat(go): feed and diaper logs`.

---

### Task 11: Sleep, summary, sleep-locations

**Files:** spec; `queries/sleep.sql`, `queries/summary.sql`, `queries/sleep_locations.sql`; `internal/api/sleep.go`, `summary.go`, `sleep_locations.go`; tests porting `sleep.test.ts` (active-session lifecycle, 409 ALREADY_ACTIVE incl. the DB-race path from defects.test.ts — insert bypassing the pre-check must land on the partial index → 409), `feedback-batch.test.ts` summary-today + custom-locations blocks.

Behavior: REF §A1 sleep.ts/sleep-locations.ts. Summary `tz` window math ported from `apps/api/src/routes/sleep.ts` (read it; the day boundary is `floor((now - tzMs)/DAY)*DAY + tzMs`).

- [ ] Steps: spec → generate → failing tests → implement → pass → commit `feat(go): sleep sessions, summary and sleep locations`.

---

### Task 12: Other-logs factory (medicine/baths/notes/milestones/measurements/pumps)

**Files:** spec (24 paths — write them out; components reuse a `LogBase` schema); `queries/other_logs.sql` (six table quartets — sqlc has no generics: write the 24 queries, they are mechanical); `internal/api/other_logs.go` (ONE generic Go helper `logCrud[T]` parameterized by table-specific sqlc funcs, mirroring `scoped.ts logCrud`); tests porting `other-logs.test.ts` (medicine deep, others via a table-driven loop) + `entitlement-rework.test.ts` inverted (previously-gated creates now 201 on free plan).

- [ ] Steps: spec → generate → failing tests → implement → pass → commit `feat(go): six other-log kinds via one crud helper`.

---

### Task 13: Play

**Files:** spec; `queries/play.sql`; `internal/api/play.go`; tests porting `play.test.ts` (minus premium gate; active/stop/one-per-baby).

- [ ] Steps: spec → generate → failing tests → implement → pass → commit `feat(go): play sessions`.

---

### Task 14: Vaccines, dismissals, documents, files

**Files:** spec (JSON routes; documents-upload and files stay hand-routed outside the generated interface, registered on the same mux before the spec-validated subtree); `queries/vaccines.sql`; `internal/api/vaccines.go`, `files.go`; tests porting `vaccines.test.ts` (uploads disabled → 403 FEATURE_DISABLED via multipart; dismissal idempotency; document URL shape; file streaming headers byte-exact per REF §A1; missing object → 404 — memory storage lets you delete the object behind the row).

Behavior: `DocumentUploadsEnabled = false` const. GET /api/files/{id}: family-scoped row lookup → `GetStream` (found flag BEFORE writing status) → copy.

- [ ] Steps: spec → generate → failing tests → implement → pass → commit `feat(go): vaccines, dismissals and file streaming`.

---

### Task 15: Timeline

**Files:** spec; `queries/timeline.sql` (per-source page queries `WHERE family_id=$1 AND baby_id=$2 AND (time, id) < ($3,$4) ORDER BY time DESC, id DESC LIMIT $5` — row comparison gives the same-timestamp pagination defects.test.ts requires); `internal/api/timeline.go` (merge 11 sources in Go, sort, cut page, cursor `fmt.Sprintf("%d|%s", t.UnixMilli(), id)`); tests porting `timeline.test.ts` + defects same-timestamp case + filter chips incl. `other`.

- [ ] Steps: spec → generate → failing tests → implement → pass → commit `feat(go): merged timeline with keyset pagination`.

---

### Task 16: Calendar + contacts

**Files:** spec; `queries/calendar.sql`, `queries/contacts.sql`; `internal/api/calendar.go`, `contacts.go`; tests porting `calendar.test.ts` + `contacts.test.ts` (range validation, INVALID_REFERENCE, link-set replacement, allDay/durationMin invariant, remindedAt reset on time change).

- [ ] Steps: spec → generate → failing tests → implement (both use a shared `refsValid` helper verifying baby/user family membership; transaction around event+links) → pass → commit `feat(go): calendar events and contacts`.

---

### Task 17: Stats + CSV export

**Files:** spec (stats only); `queries/stats.sql`, `queries/export.sql`; `internal/api/stats.go`, `export.go` (export outside generated interface — streams CSV); tests porting `stats.test.ts` (midnight-splitting of sleep spans, weight trend, days>7 now allowed; CSV columns, ascending order, formula-injection escaping).

- [ ] Steps: spec → generate → failing tests → implement → pass → commit `feat(go): stats and csv export`.

---

### Task 18: Push routes

**Files:** spec; `queries/push.sql`; `internal/api/push.go`; tests porting `push.test.ts` (endpoint allowlist incl. rejection of `https://evil.example`, upsert-on-endpoint, prefs enum 0/3/4/6, unsubscribe scoped to own rows, test-send counts via RecordingPush).

- [ ] Steps: spec → generate → failing tests → implement → pass → commit `feat(go): push subscription lifecycle`.

---

### Task 19: API keys routes

**Files:** spec; `queries/api_keys.sql`; `internal/api/keys.go` (`pjk_` + 40 hex chars from crypto/rand; prefix = first 12 chars of full key; SHA-256 hex stored); tests porting `api-keys.test.ts` (create shows key once, list hides it, revoked/expired auth behavior — middleware paths already tested in Task 6, here assert end-to-end through real routes, read-only key can GET timeline but not POST feeds).

- [ ] Steps: spec → generate → failing tests → implement → pass → commit `feat(go): api key management`.

---

### Task 20: Invites (admin + public + redeem)

**Files:** spec; `queries/invites.sql`; `internal/api/invites.go`; tests porting `invites.test.ts` + defects case-insensitivity + rate-limit assertions (drive >limit requests, expect 429 envelope).

Behavior: REF §A1 invites.ts. Redeem inside `pgx.BeginFunc`: `SELECT … FOR UPDATE`, classify (revoked/expired/exhausted/not_found), check existing membership, insert member row directly (SQL, not auth.Service — must be inside OUR transaction), `UPDATE … SET used_count = used_count + 1`, then best-effort `SetActiveFamily` after commit. Code generation: 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (crypto/rand) — read `apps/api/src/routes/invites.ts` for the exact alphabet/length and match it.

- [ ] Steps: spec → generate → failing tests → implement → pass → commit `feat(go): invite codes with transactional redeem`.

---

### Task 21: Admin console routes

**Files:** spec; `queries/admin.sql`; `internal/api/admin.go`; tests porting `admin.test.ts` + `security.test.ts` safe-user-deletion block, plus new coverage: users list/ban/unban/password/sessions-revoke/impersonate round-trip (impersonated /api/me shows impersonatedBy; non-GET while impersonating writes audit; stop restores admin).

Behavior: REF §A1 admin.ts incl. the NEW endpoints table. User delete: single transaction reassigning caretaker_id on the 9 log tables + family_invite.created_by + api_key.created_by (revoke) + admin_audit.admin_id + calendar_event.created_by to tombstone, delete calendar_assignee rows, then delete user. Ban: set banned + reason, RevokeAllSessions.

- [ ] Steps: spec → generate → failing tests → implement → pass → commit `feat(go): sysadmin console with impersonation and audit`.

---

### Task 22: Cross-cutting suites (tenancy, security, defects)

**Files:** Test: `apps/server-go/internal/api/tenancy_test.go`, `security_test.go`

Port `tenancy.test.ts` in full: two families, every route class probed cross-family (read by id, patch, delete, timeline babyId of other family, files, invites, keys) — all must 404/403, never leak. Port remaining `security.test.ts` and `defects.test.ts` assertions not covered in Tasks 9–21 (grep those files for `test(` titles and check off each).

- [ ] Steps: write → run → fix any handler found leaking → pass → commit `test(go): tenancy and security hardening suites`.

---

### Task 23: Jobs (backup, reminders, purge)

**Files:**
- Create: `apps/server-go/internal/jobs/backup.go`, `reminders.go`, `calendar_reminders.go`, `purge.go`
- Test: `apps/server-go/internal/jobs/*_test.go` porting `backup.test.ts`, `backup-tables.test.ts` (dynamic pg_tables vs BACKUP_TABLES + DELIBERATELY_EXCLUDED incl. `goose_db_version`, `rate_limits`), `calendar-reminders.test.ts` (grace latch, assignee vs family fan-out, Oslo HH:mm formatting via `time.LoadLocation("Europe/Oslo")` — works via embedded tzdata), reminder gap/latch logic from `reminders` coverage in `push.test.ts`/jobs tests.

Behavior: REF §A7 exactly (password nulling, key format `backups/2026-08-31.json`, retention 30, prune regex + fallback).

- [ ] Steps: failing tests → implement → pass → commit `feat(go): nightly backup, reminders and orphan purge`.

---

### Task 24: Cron scheduler + dispatch + composition root

**Files:**
- Create: `apps/server-go/internal/cron/cron.go` (`Jobs = []string{"nightly","frequent"}`, `RunJob(ctx, name, d) error`, `StartScheduler(d) (stop func())` using robfig/cron `cron.New(cron.WithLocation(time.UTC))`, schedules REF §A4, per-job recover+log)
- Modify: `apps/server-go/cmd/pjokk/main.go` — full dispatch table REF §A4, deps construction (config → pool → auth → storage driver switch → push (noop when unconfigured) → EnsureTombstone → api.NewHandler → web.Handler), `http.Server` with graceful shutdown (`signal.NotifyContext`, `srv.Shutdown`), worker mode (healthz-only mux + scheduler), healthcheck mode (plain `http.Get`, exit code).
- Test: `apps/server-go/internal/cron/cron_test.go` (RunJob dispatches, unknown job error); `cmd` smoke via `go run . healthcheck` against a started test server in CI is covered by the compose smoke in Task 28.

- [ ] Steps: failing tests → implement → `go build ./...` + manual `go run ./cmd/pjokk` against compose Postgres+MinIO boots and serves /healthz → commit `feat(go): dispatch modes, scheduler and composition root`.

---

### Task 25: Frontend — generated API client swap

**Files:**
- Create: `apps/frontend/src/lib/api-schema.d.ts` (openapi-typescript output, committed), regenerate script in root `package.json` (`"gen:client": "openapi-typescript openapi/pjokk.yaml -o apps/frontend/src/lib/api-schema.d.ts"`)
- Modify: `apps/frontend/src/lib/api.ts` — `createClient<paths>({baseUrl: API_BASE, credentials: "include"})` from `openapi-fetch`; keep `ApiError` + `unwrap` semantics (unwrap now takes the openapi-fetch `{data, error, response}` result).
- Modify: every file in REF §A8 data-layer list — mechanical call-shape conversion (`api.feeds.$get({query})` → `client.GET("/api/feeds", {params:{query}})`), leaving TanStack Query keys and component props untouched.

- [ ] Steps: install deps (`bun add -d openapi-typescript`, `bun add openapi-fetch`) → generate → convert `lib/api.ts` + `lib/data/*` first, run `bun run typecheck` iterating until the data layer compiles → convert remaining screens/sheets → frontend tests (`bun test apps/frontend`) green → commit `feat(frontend): openapi-fetch client generated from the spec`.

---

### Task 26: Frontend — Limen auth swap + admin/member rewiring

**Files:**
- Modify: `apps/frontend/src/lib/auth-client.ts` (limen-auth per REF §B5; export `useSession`-compatible wrapper, `signIn`, `signOut`, `isSysadmin` now reading `/api/me` via a `useMe()` TanStack query in `lib/data/family.ts`)
- Modify: `Login.tsx`, `Join.tsx`, `Welcome.tsx`, `shell.tsx`, `admin/shell.tsx`, `settings/index.tsx`, `settings/FamilySection.tsx` (new member endpoints), `admin/Users.tsx` (new `/api/admin/users*` endpoints), `Home.tsx` — per REF §A8 call-site table. Impersonation banner driven by `useMe().impersonatedBy`.

- [ ] Steps: `bun add limen-auth` → verify actual client API shape against the package types (REF §B5 caveat) → convert file-by-file with `bun run typecheck` after each → frontend tests green → commit `feat(frontend): limen auth client and admin rewiring`.

---

### Task 27: Frontend — billing removal

**Files:** per REF §A8 billing list — delete `BillingSection.tsx` + `WelcomePlan.tsx`, strip imports/renders, `usePremium()` → `() => true` (keep the hook), remove 402 special-cases, simplify plan-conditioned rendering, fix `lib/i18n.ts` keys, landing copy lines, remove `@better-auth/*` and `stripe` from package.json (all workspaces), remove the Welcome plan step from the router/flow.

- [ ] Steps: delete/strip → `bun run typecheck` + frontend tests + `bun run build` (Vite) green → grep repo for `stripe|premium|PLAN_REQUIRED|usePremium` and resolve every hit deliberately → commit `feat(frontend)!: remove billing — self-hosted pjokk is all-features-free`.

---

### Task 28: Dockerfile (scratch, multi-arch) + compose

**Files:**
- Rewrite: `Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1
FROM oven/bun:1.4 AS frontend
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/shared/package.json ./packages/shared/
RUN bun install --frozen-lockfile
COPY packages/shared ./packages/shared
COPY apps/frontend ./apps/frontend
COPY openapi ./openapi
RUN cd apps/frontend && bun run build   # → /app/dist/client

FROM --platform=$BUILDPLATFORM golang:1.27 AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY apps/server-go/go.mod apps/server-go/go.sum ./
RUN go mod download
COPY apps/server-go/ ./
COPY openapi /openapi
COPY --from=frontend /app/dist/client ./internal/web/dist
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /pjokk ./cmd/pjokk

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /pjokk /app/pjokk
COPY <<EOF /etc/passwd
pjokk:x:65532:65532:pjokk:/:/sbin/nologin
EOF
USER pjokk
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["/app/pjokk","healthcheck"]
ENTRYPOINT ["/app/pjokk"]
```
(`import _ "time/tzdata"` must be in main.go — verify Europe/Oslo loads in the jobs test inside the container smoke. The embedded SPA means the image build overwrites `internal/web/dist` placeholder.)
- Rewrite: `docker-compose.yml` — app (fs driver, volume `pjokk-data:/data`, `STORAGE_DRIVER=fs`, `STORAGE_FS_PATH=/data`) + postgres; `docker-compose.s3.yml` overlay adding MinIO + s3 env; keep one-off `migrate` service (`command: ["migrate"]`). `docker-compose.test.yml` unchanged.
- Create: `scripts/build-image.sh` — `docker buildx build --platform linux/amd64,linux/arm64 -t pjokk:dev .`

- [ ] Steps: `docker build` single-arch → `docker compose up` → smoke: /healthz, sign-in page loads, create family via UI-less curl flow (signin → invite bootstrap SQL as compose init or documented bootstrap), file upload path with fs driver, `docker compose run migrate` idempotent → buildx both platforms build → commit `feat(docker): scratch multi-arch image with embedded SPA`.

---

### Task 29: Full verification pass

- [ ] `cd apps/server-go && go vet ./... && go test -p 1 ./...` — all green.
- [ ] `bun run typecheck && bun test apps/frontend && cd apps/frontend && bun run build` — green.
- [ ] Spec drift: `go generate ./...` + `bun run gen:client` produce no diff (`git status --porcelain` empty).
- [ ] Compose smoke (Task 28 flow) re-run from clean volumes.
- [ ] Cross-check REF §A1 route tables against `openapi/pjokk.yaml` path-by-path; grep TS test files for `test(`/`it(` titles and confirm each is represented in a Go test or listed as deliberately dropped (billing, app-type, passkey) in the commit body.
- [ ] Commit any fixes; `docs: record go-migration verification results` with the checklist output.

---

### Task 30: Remove the TS backend, rename, docs, PR

- [ ] Delete `apps/api` and `apps/server`; `git mv apps/server-go apps/server`; fix module path references (module path stays `github.com/refsdal/pjokk/server`; update Dockerfile COPY paths, root package.json scripts — `start`/`migrate`/`cron` become docs pointing at the binary; remove backend-only deps from root package.json; remove `bunfig.toml` preload entries for deleted tests).
- [ ] Update `CLAUDE.md` (stack section: Go/stdlib/Limen/sqlc; dispatch unchanged; billing removed; storage drivers), `README.md` (self-hosting: fs-driver compose is the minimal path), `DECISIONS.md` (Limen isolation rationale, api-key plugin rejected, billing dropped, fresh-DB cutover).
- [ ] Full suite once more (Go + frontend + build + compose smoke).
- [ ] Push branch `go-backend-migration`, open PR to `main` titled `feat!: Go backend — single static binary, embedded SPA, scratch multi-arch image` with a body summarizing: parity statement (test-suite port map), dropped features (billing, passkeys), new capabilities (fs storage driver, multi-arch), cutover notes (fresh DB, bootstrap steps), and the two reference docs linked. `🤖 Generated with [Claude Code](https://claude.com/claude-code)` footer.
