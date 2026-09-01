# Go Backend Migration — Design

**Date:** 2026-08-31
**Status:** Approved design, pending implementation plan

## Goal

Replace the Bun/Hono/TypeScript backend with a Go backend that embeds the
Vite-built frontend, ships as a single static binary in a multi-arch
scratch image, and uses only the standard library `net/http` for routing.
The motivation is a maximally robust self-hosting story: one ~20–30 MB
image, no JS runtime, no node_modules, trivially multi-arch.

The React SPA survives essentially unchanged; the landing site
(pjokk.no apex, static) is unaffected.

## Decisions made during brainstorming

| Decision | Choice |
|---|---|
| Auth library | Limen (github.com/thecodearcher/limen) behind our own interface |
| Billing | **Dropped.** No Stripe. `plan` column and `canUse()` kept as a seam; every family effectively unlimited; 402 gates removed from routes and billing UI removed from the frontend |
| Data migration | **None.** Fresh database; prod re-bootstrapped by hand (one founder account exists today) |
| API contract | Spec-first: hand-written OpenAPI YAML → oapi-codegen (Go, strict server, stdlib net/http) + openapi-typescript/openapi-fetch (frontend) |
| DB layer | pgx/v5 + sqlc (hand-written SQL, generated typed Go); goose migrations embedded |
| Strategy | Big-bang parity rewrite on one branch; cutover when the ported test suite is green and a smoke pass on test.pjokk.no succeeds |
| Storage | Driver-selectable: S3-compatible **or** local filesystem, via env |

## Non-goals

- Passkeys/WebAuthn (better-auth had it server-side only, no UI; Limen
  lacks it; dropped until it matters).
- Stripe billing, subscriptions, customer portal, comp/lifetime plans.
- Migrating any existing database contents.
- Changing the frontend's screens, offline behavior, PWA setup, or i18n.
- A Capacitor shell (Limen's session-jwt/api-key plugins are the future
  path when it materializes).

## Layout

Single Go module at `apps/server-go/` during migration; renamed to
`apps/server/` after the TS backend is deleted.

```
apps/server-go/
  cmd/pjokk/main.go        dispatch: default | server | worker | migrate | cron <job> | healthcheck
  internal/api/            handlers implementing the oapi-codegen server interface
  internal/api/middleware/ session → family tenancy middleware
  internal/auth/           Limen wiring + invite codes + hand-rolled admin
  internal/db/             sqlc output + queries/*.sql + migrations/*.sql (goose, embedded)
  internal/storage/        Storage interface + s3, fs, and in-memory implementations
  internal/push/           webpush-go behind a PushSender interface
  internal/cron/           nightly/frequent jobs + scheduler
  internal/config/         env parsing/validation at startup (env.ts equivalent)
  internal/web/            go:embed Vite dist, SPA fallback, runtime headers (robots, noindex, security)
openapi/pjokk.yaml         single source of truth for the API
```

**Composition-root discipline is preserved verbatim.** `internal/api`
receives a plain struct of interfaces (the Go `Deps`), never reads env,
never constructs collaborators. `cmd/pjokk` is the sole composition root.

**Dispatch parity.** Default mode migrates at startup under the same
Postgres advisory lock key, then serves and schedules. `server` mode never
migrates and never schedules (what replicas run). `worker` schedules only.
`migrate` is the explicit one-off. `cron <job>` is one-shot for Kubernetes
CronJobs. `healthcheck` is the shell-free HEALTHCHECK client.

## Auth

**From Limen:** sessions (cookies), Google OAuth, email/password sign-in,
the organization plugin (organization = family; roles admin/member; active
organization on the session), and the api-key plugin for `pjk_` bearer
keys. Postgres via Limen's `database/sql` adapter over pgx's stdlib shim.

**Hand-rolled on top (in `internal/auth`):**

- **Invite codes** — the existing custom flow, unchanged in shape:
  `family_invite(code, familyId, role, expiresAt, maxUses, usedCount)`,
  72 h default expiry, revocable, role baked in, rate-limited redeem
  (codes are credentials), `/join/CODE` → sign-in → validate → addMember.
  Redemption is one real `db.transaction` (no compensating deletes).
- **Signup lockdown** — accounts are created only through invite redeem.
- **Admin console** (Phase 8 parity) — impersonation (with in-app banner),
  ban, session revocation, password support, cascade family delete, and
  the append-only `admin_audit` trail. All of this is ordinary session and
  table manipulation once we own the schema; `user.role === "admin"`
  remains distinct from family roles.

**Isolation requirement:** handlers and the tenancy middleware never
import Limen types. `internal/auth` exposes a small interface (resolve
session, resolve active family + role, create user, add member) so that if
Limen stalls as a project the blast radius is one package.

**Tenancy discipline carries over unchanged:** every domain table has
`familyId`; middleware resolves it from the session's active organization;
all sqlc queries are family-scoped; no handler touches a domain table
without the scope.

## API contract

`openapi/pjokk.yaml` is authored by hand, transcribed endpoint-by-endpoint
from the existing zod schemas (they are the de-facto spec). From it:

- **Go:** `oapi-codegen` strict-server mode → typed request/response
  structs and a stdlib `net/http` server interface. kin-openapi validation
  middleware enforces the spec at runtime, so handlers receive validated
  input — the guarantee zod gave Hono. Generated code is committed;
  `go generate` regenerates.
- **Frontend:** `openapi-typescript` types + `openapi-fetch` client
  replace `hono/client`. Call-site churn is contained in the TanStack
  Query wrapper layer.
- **Docs:** Scalar as a static page rendering the same YAML at
  `/api/docs`.
- **Drift guard:** CI fails if regeneration produces a diff; the test
  suite exercises real requests through the validation middleware; a
  spec-conformance test class validates every handler response against
  the spec.

## Frontend changes (the only ones)

1. API client layer swapped for the generated `openapi-fetch` client.
2. Auth client swapped: Limen's TypeScript SDK for sign-in, session, org
   switching; plain generated-client calls for invite redeem and the
   admin console.
3. Billing UI removed (Settings → Billing, 402 handling, upgrade
   prompts); previously gated features become plain features.
4. `packages/shared` shrinks to what the frontend still genuinely shares.

## Storage

One `Storage` interface, three implementations:

- **s3** — aws-sdk-go-v2 against any S3-compatible store (MinIO, S3, R2,
  Ceph). Never a public bucket; streaming stays behind the authed
  `/api/files/:id` route with the same allowlist (images + PDF), 10 MB
  cap, 5 per entry.
- **fs** — local filesystem rooted at a configured directory (a mapped
  Docker volume in practice). Blobs stored under ID-based paths; writes
  are temp-file-then-rename so a crash never leaves a partial file;
  refuses to start if the root is not writable. Removes MinIO as a
  required service for the simplest self-hosted deployments.
- **memory** — tests.

Env selection, validated in `internal/config`: `STORAGE_DRIVER=s3|fs`;
`STORAGE_FS_PATH` required for fs; the S3 vars required for s3. One driver
serves both file attachments and the nightly backup (YAGNI: no split
backup target unless asked for). Docs must state that with `fs`, backups
live on the same host as the app.

**EU residency remains mandatory and deployment-time.** Compose files and
docs keep stating it: Postgres, object store or fs volume, and backups
must be in the EU. The `fs` driver makes this the host's region. The
privacy policy stays in step with actual deployment.

## Subsystem ports

Each a small interface with a real and a test implementation, matching
today's `ports.ts`:

- **Push:** `webpush-go` (VAPID). Same subscription lifecycle, 410
  pruning, per-caretaker feed reminders (off/3/4/6 h, one nudge per gap),
  calendar reminders with `remindedAt` latch + 60-min grace.
- **Rate limiting:** same `rate_limit` table, SHA-256-hashed client IPs
  (never raw addresses), peer-address resolution behind an interface so
  an ingress cannot collapse everything into one bucket.
- **Cron:** robfig/cron (or a hand-rolled ticker — it is two schedules)
  with explicit UTC. Nightly backup (row dump of every table including
  the subscription list, pruned after 30 days — a privacy-policy
  commitment stated in UTC) at 03:15; reminders at */15.
- **CSV export, WHO LMS data, barnevaksinasjonsprogrammet, sprout-track
  importer:** straight ports; bundled JSON via `go:embed`.

## Postgres notes that carry over

- Real transactions everywhere multi-row writes happen.
- `timestamptz` everywhere; sqlc maps to `time.Time`.
- `double precision` for measured values (weights, doses) — never `real`.
- Unique violations detected by SQLSTATE 23505 (pgx `PgError.Code`),
  never error text.
- `"user"` quoted in SQL (reserved word).
- `COUNT(*)::int` casting is moot with sqlc (int64 comes back typed), but
  interval arithmetic rules (`start_time - (n * interval '1 minute')`)
  still apply.

## Build & image

**Build:** two-stage Dockerfile. Stage 1 (bun image) builds the Vite SPA —
bun survives only as the frontend build tool. Stage 2 (golang image)
copies `dist/` in and compiles with `CGO_ENABLED=0`,
`-trimpath -ldflags="-s -w"`, `go:embed`-ing the SPA, migrations, bundled
JSON, and the Scalar page. `import _ "time/tzdata"` embeds zone data.

**Image:** `FROM scratch` + the binary + `ca-certificates.crt` (TLS to
S3/Google) + a one-line `/etc/passwd` for a nonroot UID. HEALTHCHECK via
the binary's own `healthcheck` dispatch. `/healthz` and `/readyz` kept.

**Multi-arch:** `docker buildx` manifest list for `linux/amd64` +
`linux/arm64`; Go cross-compiles both on one runner (no QEMU for the Go
stage; the bun stage is arch-independent output).

**Compose:** app + Postgres (+ MinIO only in the s3 variant; an fs-driver
variant uses a plain volume), with one-off `migrate` service preserved.
`docker-compose.test.yml` unchanged in role.

## Testing

The existing ~200-test suite is the parity specification. Port it to Go
table-driven tests against the same real Postgres
(`docker-compose.test.yml`), with the same discipline: empty database per
test file, rate-limit counters cleared between tests, in-memory storage
substitute. Priority order preserved: tenancy middleware, invite redeem,
active-session logic. New class: spec-conformance tests (responses
validate against `openapi/pjokk.yaml`).

## Cutover

1. Deploy the Go image to test.pjokk.no with a fresh database.
2. Run SMOKE-TEST.md flows: live Google OAuth, push subscription + test
   push, file upload/stream, importer, invite redeem end-to-end.
3. Prod cutover with a fresh database; re-bootstrap the founder account
   and family by hand.
4. Delete `apps/api` and `apps/server` (TS); rename `apps/server-go` →
   `apps/server`; drop backend-only deps from the workspace.
5. Rewrite CLAUDE.md's stack section; verify the privacy policy still
   matches actual processors (it should — same Postgres/S3 story).

## Risks

- **Limen maturity** — single-author, ~520 stars, born 2026. Mitigated by
  the isolation interface; worst case is rewriting one package, not the
  app. Accepted trade-off for not hand-rolling OAuth/session security.
- **Long-lived branch** — accepted: one stakeholder, closed signup, and
  the frontend + old test suite pin expected behavior precisely.
- **Spec transcription errors** — mitigated by the ported tests and
  spec-conformance checks; the frontend compiling against generated types
  catches shape drift at build time.
