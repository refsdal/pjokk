# Composition Root (PR #16) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `apps/api` a library that receives its collaborators, with
`apps/server` as the single place that constructs them — no DI container, just
a plain `Deps` object passed to `createApi(deps)`.

**Architecture:** Ports (interfaces) and the domain live in `apps/api`;
adapters live in `apps/api/src/infrastructure/` behind a separate package
entry that only `apps/server` may import. `apps/server` parses the
environment, builds `Deps`, and hands it to `createApi`. Deps are captured in
a closure rather than re-resolved per request, which deletes the
`WeakMap<Env, Services>` memoization and the `inject` middleware.

**Tech Stack:** Bun 1.4, Hono + `@hono/zod-openapi`, Drizzle + Postgres,
better-auth, Biome 2, TypeScript 7.

**Spec:** `docs/superpowers/specs/2026-08-28-workspace-restructure-design.md`

## Global Constraints

- **No behaviour change.** Every one of the 200 tests must still pass. This is
  a wiring refactor: no route's request or response shape changes.
- **`apps/api` must never construct a dependency at module scope and never
  read `process.env`.** That invariant — not the location of any file — is
  what the PR buys. A single `process.env` read inside `apps/api/src` is a
  failed task.
- **`apps/api` MUST NOT depend on `apps/server`.**
- `bun run test` — never `bun test`. The root `bunfig.toml` has no `[test]`
  section; a bare `bun test` from the repo root runs every package with no
  preload and fails on missing tables.
- Do not remove `[install] linker = "hoisted"` from the root `bunfig.toml`.
- The three bundle output names (`main.js`, `cron-cli.js`, `migrate.js`) and
  the Dockerfile's `CMD ["bun", "main.js"]` must not change.
- Conventional Commits; reference `Phase: composition root (PR #16)` in bodies.
- The Postgres test database must be running:
  `docker compose -f docker-compose.test.yml up -d`.

## Two corrections to the spec, found by reading the current code

The spec was written before PR #15 executed. Two of its statements are wrong
and this plan overrides them:

1. **`Deps` must also carry `openSignup` and `indexable`.** The spec says both
   "leave with the landing page", but the landing page leaves in **PR #17**,
   not this one. `apps/api/src/index.ts` reads `c.env.INDEXABLE` three times
   (robots.txt, sitemap.xml) and `landing/index.ts` reads `OPEN_SIGNUP`. They
   stay in `Deps` for this PR and are deleted in #17.
2. **`push` needs its own port shape.** `pushToUser(db, env, userId, payload)`
   currently takes both a `Db` and the whole `Env` (for `APP_URL` and the VAPID
   pair). As a port it becomes `PushSender.toUser(userId, payload)` with the db
   and VAPID config closed over at construction, so no call site passes
   infrastructure around.

A third, smaller deviation: the spec's target tree names
`apps/server/src/index.ts`. **Keep it `main.ts`.** `bun build` names its output
after the entry file, so renaming it produces `index.js` and breaks the
Dockerfile's `CMD ["bun", "main.js"]` — a rename with no benefit and a
production failure mode.

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/src/ports.ts` | Interfaces only: `Storage`, `RateLimitStore`, `PushSender`, `PeerAddress`, `Clock`. No implementations, no imports from `infrastructure/`. |
| `apps/api/src/deps.ts` | The `Deps` type — the single contract between the two packages. |
| `apps/api/src/db/index.ts` | `type Db` and the `schema` re-export. **Type only, no construction.** |
| `apps/api/src/infrastructure/` | Every factory: db, storage, auth, stripe, rate-limit, push. Reachable only via `@pjokk/api/infrastructure`. |
| `apps/api/src/app.ts` | `createApi(deps): Hono` and `export type AppType`. Replaces `index.ts`. |
| `apps/api/src/jobs/` | Job bodies, each taking `Deps`. Was `scheduled.ts` (337 lines, four unrelated jobs). |
| `apps/server/src/env.ts` | The zod schema. Was `apps/api/src/config.ts`. |
| `apps/server/src/deps.ts` | `createDeps(env): Deps` — the composition root. |
| `apps/server/src/cron.ts` | `SCHEDULES`, `runJob(job, deps)`, `startScheduler(deps)` on `Bun.cron`. |

---

### Task 1: Ports, `Deps`, and a type-only `Db`

Define the contracts before anything moves. Nothing is deleted in this task —
it is purely additive, so the suite must stay green throughout.

**Files:**
- Create: `apps/api/src/ports.ts`
- Create: `apps/api/src/deps.ts`
- Modify: `apps/api/src/db/index.ts`

**Interfaces:**
- Produces: `Storage`, `RateLimitStore`, `PushSender`, `PeerAddress`, `Clock`
  from `apps/api/src/ports.ts`; `Deps` from `apps/api/src/deps.ts`;
  `type Db` from `apps/api/src/db/index.ts`.

- [ ] **Step 1: Confirm the suite is green before touching anything**

```bash
docker compose -f docker-compose.test.yml up -d
bun run test 2>&1 | tail -6
```

Expected: `179 pass` under `@pjokk/api` and `21 pass` under `@pjokk/frontend`.
If not, stop — you are not starting from a known-good state.

- [ ] **Step 2: Create `apps/api/src/ports.ts`**

`Storage` and `RateLimitStore` are moved verbatim from
`apps/api/src/storage.ts` and `apps/api/src/rate-limit-store.ts` — copy the
existing type declarations and their doc comments exactly, do not reword them.
The two new ports are `PushSender` and `PeerAddress`.

```ts
// The contracts apps/api depends on. Interfaces ONLY — no construction, and
// nothing here may import from ./infrastructure. apps/server picks the
// implementations; this file is what both sides agree on.

export type StoredObject = { key: string; uploadedAt: Date };

export type Storage = {
  /**
   * Stores an object.
   *
   * The body is Blob | string ON PURPOSE. Bun's S3 client does NOT accept a
   * ReadableStream: handed one it silently writes the string
   * "[object ReadableStream]" instead of the bytes, with no error. A File IS
   * a Blob, so upload call sites pass the File itself and lose nothing.
   */
  put(key: string, body: Blob | string, contentType?: string): Promise<void>;
  /** Streams an object back, or null when it does not exist. */
  getStream(key: string): Promise<ReadableStream | null>;
  /** Deletes one or many objects. Missing keys are not an error. */
  delete(keys: string | string[]): Promise<void>;
  /** Every object under a prefix, paginating internally. */
  list(prefix: string): Promise<StoredObject[]>;
};

export type RateLimitStore = {
  /** Increments the window's counter and returns its new value. */
  hit(key: string, windowSeconds: number): Promise<number>;
  /** Drops expired rows. KV expired them for us; nothing does here. */
  sweep(now?: Date): Promise<number>;
};

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
};

/**
 * Web push, with the database and the VAPID credentials closed over.
 *
 * Narrower than the function it replaces: `pushToUser(db, env, ...)` made
 * every caller carry a Db and the whole Env just to send a notification.
 * Dead subscriptions are still pruned inside the implementation.
 *
 * Returns the number of successful deliveries.
 */
export type PushSender = {
  toUser(userId: string, payload: PushPayload): Promise<number>;
};

/**
 * The peer address of a request, or null when it cannot be determined.
 *
 * A port rather than a value because only Bun's server handle knows it, and
 * that handle does not exist until Bun.serve() has returned — so apps/server
 * supplies a closure over its own mutable reference. Tests pass one that
 * returns null, which is why the rate limiter's "unknown" bucket exists.
 */
export type PeerAddress = (request: Request) => string | null;

/** Injected so reminder and backup tests are deterministic rather than
 *  dependent on the wall clock. */
export type Clock = () => Date;
```

- [ ] **Step 3: Create `apps/api/src/deps.ts`**

```ts
import type { Auth } from "./auth";
import type { Db } from "./db";
import type {
  Clock,
  PeerAddress,
  PushSender,
  RateLimitStore,
  Storage,
} from "./ports";

/**
 * Everything apps/api needs from the outside world.
 *
 * The ONE contract between the two packages: apps/server constructs these and
 * hands them to createApi(); apps/api never builds one itself and never reads
 * process.env. Configuration arrives as plain values, not as an Env object,
 * so a route cannot reach for a setting nobody declared here.
 */
export type Deps = {
  db: Db;
  auth: Auth;
  storage: Storage;
  rateLimit: RateLimitStore;
  push: PushSender;
  peerAddress: PeerAddress;
  now: Clock;

  /** Public origin. Used for OAuth callbacks, absolute links in push
   *  payloads, and the sitemap. */
  appUrl: string;
  /** Handed to the client so it can subscribe; the private half never
   *  leaves apps/server's process memory. */
  vapidPublicKey: string;
  /** Empty string when billing is not configured. */
  stripePriceLifetime: string;
  /** How many proxies sit in front. 0 means X-Forwarded-For is not read. */
  trustedProxyHops: number;
  /** Landing-page switches. Both leave in PR #17 with the landing page —
   *  they are here because that page still lives in this package. */
  openSignup: boolean;
  indexable: boolean;
};
```

- [ ] **Step 4: Give `apps/api/src/db/index.ts` an explicit `Db` type**

**Keep `createPool` and `createDb` exactly where they are.** They move to
`infrastructure/db.ts` in Task 2, together with the two call sites that would
otherwise break — `apps/api/src/services.ts:5,49` and
`apps/server/src/migrate.ts:3,17,26` import them at *runtime*, so removing them
here turns the whole `@pjokk/api` suite red (23 files, `SyntaxError: Export
named 'createDb' not found`). This task must stay green.

The only change is the `Db` type itself, from an inferred `ReturnType` to an
explicit annotation. That is worth doing on its own: an explicit type keeps the
emitted `.d.ts` stable across the package boundary instead of re-inferring a
large type at every consumer.

Change only this line:

```ts
export type Db = ReturnType<typeof createDb>;
```

to:

```ts
/**
 * `& { $client: SQL }` is required, not decorative: drizzle() is declared as
 * returning `BunSQLDatabase<TSchema> & { $client: TClient }`, so the bare
 * class annotation drops $client — and the test suite calls db.$client.end()
 * in afterAll, because Bun keeps the process alive while the pool holds
 * handles.
 */
export type Db = BunSQLDatabase<typeof schema> & { $client: SQL };
```

adding the two type imports it needs:

```ts
import type { SQL } from "bun";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
```

Note `SQL` is already imported as a value in this file for `createPool`; add
the type imports without duplicating that.

- [ ] **Step 4b: Stop biome tripping over agent worktrees**

`biome check .` fails with "Found a nested root configuration" whenever a git
worktree exists under `.claude/worktrees/` — which happens routinely, since
that is where isolated agent workspaces are created. It is not related to this
task's changes, but it breaks this task's own gate.

Add `"!.claude"` to `files.includes` in `biome.json`:

```json
      "!apps/api/migrations/meta",
      "!.claude",
      "!scripts/import-sprout-track.mjs"
```

- [ ] **Step 5: Verify the suite is untouched**

```bash
bun run test 2>&1 | tail -6
bun run check
```

Expected: `179 pass` / `21 pass` and check green — **both, unconditionally**.
This task is purely additive apart from one type annotation, so anything red is
a real problem: stop and report rather than continuing.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/ports.ts apps/api/src/deps.ts apps/api/src/db/index.ts biome.json
git commit -m "refactor(api): declare the ports and the Deps contract

ports.ts holds the interfaces apps/api depends on; deps.ts holds the one
object apps/server passes to it. db/index.ts's Db becomes an explicit
annotation rather than an inferred ReturnType, which keeps the emitted .d.ts
stable across the package boundary. Construction stays put until Task 2 has
somewhere to move it to.

biome also learns to ignore .claude, where agent worktrees live — a nested
biome.json there fails `biome check .` for reasons unrelated to the tree.

PushSender is narrower than the pushToUser() it replaces: the db and the
VAPID pair are closed over, so no call site carries infrastructure just to
send a notification.

Phase: composition root (PR #16)"
```

---

### Task 2: `infrastructure/` — the adapters behind their own entry

**Files:**
- Create: `apps/api/src/infrastructure/index.ts`
- Create: `apps/api/src/infrastructure/db.ts`
- Move: `apps/api/src/storage.ts` → `apps/api/src/infrastructure/storage.ts`
- Move: `apps/api/src/rate-limit-store.ts` → `apps/api/src/infrastructure/rate-limit.ts`
- Move: `apps/api/src/stripe.ts` → `apps/api/src/infrastructure/stripe.ts`
- Move: `apps/api/src/auth.ts` → `apps/api/src/infrastructure/auth.ts`
- Move: `apps/api/src/push.ts` → `apps/api/src/infrastructure/push.ts`
- Modify: `apps/api/package.json`, `biome.json`

**Interfaces:**
- Consumes: the ports from Task 1.
- Produces, all from `@pjokk/api/infrastructure`:
  `createDb(url: string): Db`,
  `createStorage(cfg: S3Config): Storage`,
  `createRateLimitStore(db: Db): RateLimitStore`,
  `createPushSender(db: Db, cfg: VapidConfig): PushSender`,
  `createStripe(secretKey: string): Stripe | null`,
  `createAuth(cfg: AuthConfig, db: Db, stripeClient: Stripe | null): Auth`.
  The config object types are defined in Step 4 below.

- [ ] **Step 1: Move the five existing adapter files**

```bash
mkdir -p apps/api/src/infrastructure
git mv apps/api/src/storage.ts          apps/api/src/infrastructure/storage.ts
git mv apps/api/src/rate-limit-store.ts apps/api/src/infrastructure/rate-limit.ts
git mv apps/api/src/stripe.ts           apps/api/src/infrastructure/stripe.ts
git mv apps/api/src/auth.ts             apps/api/src/infrastructure/auth.ts
git mv apps/api/src/push.ts             apps/api/src/infrastructure/push.ts
```

- [ ] **Step 2: Create `apps/api/src/infrastructure/db.ts`**

This is the construction half of what `db/index.ts` holds today. Task 1
deliberately left `createPool` and `createDb` there because two files import
them at runtime; **this task moves them and fixes those call sites in the same
step, so nothing is red in between.**

The old file had `createPool` and `createDb` separately, with a comment saying
the split existed so tests could share a pool across suites. Collapse them:
there is a composition root now, so exactly one caller builds the pool.

```ts
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import type { Db } from "../db";
import * as schema from "../db/schema";

// Postgres through Bun's native SQL client. Bun's SQL client is itself a
// connection pool, so one per process is right — and now that apps/server is
// the only caller, the old createPool/createDb split has nothing left to buy.
export const createDb = (url: string): Db =>
  drizzle({ client: new SQL(url), schema });
```

- [ ] **Step 3: Rewrite the moved adapters to take config, not `Env`**

Each adapter currently imports `Env` from `../config` (which moves to
`apps/server` in Task 4, so this import must go). Replace each with a narrow
config object declared in the adapter's own file.

`infrastructure/storage.ts` — change only the signature and the `Env` import;
the body of `createStorage` is unchanged. Delete its local `Storage` and
`StoredObject` type declarations (they live in `ports.ts` now) and import them
instead:

```ts
import { S3Client } from "bun";
import type { Storage } from "../ports";

export type S3Config = {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
};

export function createStorage(cfg: S3Config): Storage {
  const client = new S3Client({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    bucket: cfg.bucket,
    endpoint: cfg.endpoint,
    region: cfg.region,
  });
  // ... the rest of the existing implementation is UNCHANGED ...
```

`infrastructure/rate-limit.ts` — delete its local `RateLimitStore` type,
import it from `../ports`, and change the `Db` import to `../db`. The body is
unchanged.

`infrastructure/stripe.ts` — takes the key directly:

```ts
export function createStripe(secretKey: string): Stripe | null {
  if (!secretKey) return null;
  return new Stripe(secretKey, {
    apiVersion: "2026-07-29.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
  });
}
```

Keep the existing doc comment about why it is nullable and why the API version
is pinned — both are still true and both were hard-won.

`infrastructure/auth.ts` — the largest change. It currently calls
`createStripe(env)` itself; the composition root now builds the Stripe client
and passes it in, so `createAuth` stops constructing anything. Change the
signature to:

```ts
export type AuthConfig = {
  appUrl: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
  stripeWebhookSecret: string;
  stripePriceMonthly: string;
  stripePriceYearly: string;
};

export function createAuth(
  cfg: AuthConfig,
  db: Db,
  stripeClient: Stripe | null,
) {
```

Then replace every `env.X` inside the function body with the corresponding
`cfg.x`, and delete the `const stripeClient = createStripe(env);` line and its
`createStripe` import. Do not change any other logic — the plugin chain, the
`authorizeReference` callback and the webhook handlers stay exactly as they
are.

`infrastructure/push.ts` — becomes a factory returning the port:

```ts
import webpush from "web-push";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { schema } from "../db";
import type { PushPayload, PushSender } from "../ports";

export type VapidConfig = {
  appUrl: string;
  publicKey: string;
  privateKey: string;
};

export function createPushSender(db: Db, cfg: VapidConfig): PushSender {
  // ... sendOne() moves inside, reading cfg instead of env ...
  return {
    async toUser(userId, payload) {
      // ... the existing pushToUser body, with `db` from the closure ...
    },
  };
}
```

Keep the existing comments about why the HTTP call is hand-rolled (to act on
404/410 and prune dead subscriptions) and about the `https:`/`mailto:` VAPID
subject requirement — the `startsWith("https:")` fallback stays.

- [ ] **Step 4: Create the barrel `apps/api/src/infrastructure/index.ts`**

```ts
// The adapters. Imported ONLY by apps/server, through the
// "@pjokk/api/infrastructure" package entry.
//
// They live in this package because they are the implementations of this
// package's ports and are tested against a real Postgres alongside the
// queries they serve. What makes the boundary real is not their location but
// the rule that nothing under routes/ or middleware/ may import them — see
// the noRestrictedImports rule in biome.json.

export { createDb } from "./db";
export { createStorage, type S3Config } from "./storage";
export { createRateLimitStore } from "./rate-limit";
export { createStripe } from "./stripe";
export { createAuth, type AuthConfig } from "./auth";
export { createPushSender, type VapidConfig } from "./push";
```

- [ ] **Step 5: Add the package entry**

In `apps/api/package.json`, add `"./infrastructure"` **before** the wildcard
so it wins. **Leave `"."` pointing at `./src/index.ts`** — Task 3 repoints it
when `app.ts` actually exists. Repointing it here would break
`apps/frontend`'s `AppType` import and leave `bun run check` red for two whole
tasks:

```json
  "exports": {
    ".": "./src/index.ts",
    "./db": "./src/db/index.ts",
    "./infrastructure": "./src/infrastructure/index.ts",
    "./*": "./src/*.ts"
  },
```

- [ ] **Step 6: Add the import guard to `biome.json`**

Under `linter.rules`, add:

```json
      "style": {
        "noNonNullAssertion": "off",
        "noRestrictedImports": {
          "level": "error",
          "options": {
            "paths": {
              "../infrastructure": "Routes and middleware receive their collaborators through Deps. Importing an adapter directly bypasses injection — the same class of mistake as bypassing the family scope.",
              "../infrastructure/index": "Routes and middleware receive their collaborators through Deps. Importing an adapter directly bypasses injection.",
              "../../infrastructure": "Routes and middleware receive their collaborators through Deps. Importing an adapter directly bypasses injection."
            }
          }
        }
      },
```

Biome's `noRestrictedImports` matches import specifiers, not file paths, so
the entries above are the specifiers a file under `routes/` or `middleware/`
would actually write. Verify the rule bites before moving on:

```bash
printf 'import { createDb } from "../infrastructure";\n' >> apps/api/src/routes/feeds.ts
bun run check 2>&1 | grep -i 'restricted\|infrastructure' | head -3
git checkout apps/api/src/routes/feeds.ts
```

Expected: the check FAILS naming the restricted import. If it passes, the rule
is not matching — report that rather than moving on, because a guard that
does not fire is worse than none.

- [ ] **Step 7: Update the importers of the moved files**

**Delete `createPool` and `createDb` from `apps/api/src/db/index.ts` now** (it
becomes type-only: `export type Db` plus the `schema` re-export), and fix the
two runtime call sites in the same commit — these are the ones that made Task 1
red when it tried to remove them early:

- `apps/api/src/services.ts:5` — import `createDb` from `./infrastructure`
  instead of `./db`; line 49 becomes `overrides.db ?? createDb(env.DATABASE_URL)`
  (the `createPool` wrapper is gone).
- `apps/server/src/migrate.ts:3` — import `createDb` from
  `@pjokk/api/infrastructure`; delete the `const pool = createPool(...)` line
  at 17 and change line 26 to `await migrate(createDb(env.DATABASE_URL), { migrationsFolder })`.
  **Keep the `await pool.end()` calls working** — hold the db in a local
  (`const db = createDb(env.DATABASE_URL)`) and call `db.$client.end()` where
  `pool.end()` was, or the migration Job hangs after succeeding.

`index.ts`, `scheduled.ts`, `routes/push.ts`, `routes/vaccines.ts` and
`context.ts` import the other moved files. Point them at the new locations
(`./infrastructure/...`); Tasks 3-5 remove most of these imports entirely. Run
this to find them all:

```bash
grep -rn 'from "\./storage"\|from "\./rate-limit-store"\|from "\./stripe"\|from "\./auth"\|from "\./push"\|from "\.\./storage"\|from "\.\./auth"\|from "\.\./push"' apps/api/src apps/api/test
```

- [ ] **Step 8: Verify**

```bash
bun run test 2>&1 | tail -6
bun run check
```

Expected: `179 pass` / `21 pass`, and check green. Both must pass — this task
is additive plus moves, and nothing it does should break either gate. If check
fails on a missing export, an importer from Step 7 was missed.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(api): move the adapters behind an infrastructure entry

Every factory now takes a narrow config object instead of the whole Env,
and createAuth stops building its own Stripe client — the composition root
passes one in. createPushSender returns the PushSender port with the db and
VAPID pair closed over.

The boundary is enforced rather than documented: infrastructure is a
separate package entry, and a biome noRestrictedImports rule stops anything
under routes/ or middleware/ reaching into it.

Phase: composition root (PR #16)"
```

---

### Task 3: `createApi(deps)`

The riskiest task in the PR. `AppType` is derived from the accumulated
`.route()` chain, and moving that chain inside a function is the change most
likely to silently degrade it to `any` — taking the frontend's end-to-end type
safety with it and failing no test.

**Files:**
- Create: `apps/api/src/app.ts` (from `index.ts`)
- Create: `apps/api/test/app-type.test.ts`
- Delete: `apps/api/src/index.ts`, `apps/api/src/services.ts`
- Modify: `apps/api/src/context.ts`, `apps/api/test/rig.ts`, every `routes/*.ts`
  and `middleware/*.ts` that reads `c.env`

**Interfaces:**
- Consumes: `Deps` from Task 1; the adapters from Task 2.
- Produces: `createApi(deps: Deps)` and `export type AppType =
  ReturnType<typeof createApi>` from `apps/api/src/app.ts`.

- [ ] **Step 1: Write the failing type assertion**

Create `apps/api/test/app-type.test.ts`. This is the guard for the whole task:
it fails at **typecheck** time, not at runtime, if `AppType` widens.

```ts
import { describe, expect, it } from "bun:test";
import { hc } from "hono/client";
import type { AppType } from "../src/app";

// The RPC client's types come from the accumulated .route() chain. Moving
// that chain inside createApi() risks collapsing it to `any`, which no
// runtime test can see: every call still compiles, the frontend just stops
// being typed. These assertions fail `bun run typecheck` if that happens.

type IsAny<T> = 0 extends 1 & T ? true : false;
type Assert<T extends true> = T;

// If AppType is `any`, this line is an error.
type _AppTypeIsNotAny = Assert<IsAny<AppType> extends true ? false : true>;

type Client = ReturnType<typeof hc<AppType>>;

// A known route must still be reachable through the client's shape. If the
// chain collapsed, `api` or `feeds` would not exist as keys.
type _HasFeedsGet = Assert<
  "$get" extends keyof Client["api"]["feeds"] ? true : false
>;
type _HasSleepPost = Assert<
  "$post" extends keyof Client["api"]["sleep"] ? true : false
>;

describe("AppType", () => {
  it("survives being derived from createApi's return", () => {
    // The assertions above are compile-time; this keeps the file in the test
    // run so a future reader does not delete it as dead code.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && bun run typecheck 2>&1 | tail -5; cd ../..
```

Expected: FAIL — `Cannot find module '../src/app'`. `app.ts` does not exist
yet, which is the point.

- [ ] **Step 3: Create `app.ts` from `index.ts`**

```bash
git mv apps/api/src/index.ts apps/api/src/app.ts
```

Then wrap the module body in `createApi`. The structure:

```ts
import type { Deps } from "./deps";

export function createApi(deps: Deps) {
  const app = createApp<AppEnv>();

  // Hands each request the collaborators the process built once at startup.
  // This used to CONSTRUCT them per request, because D1 bindings only
  // existed inside the handler; then it read them from a WeakMap keyed on
  // Env. Now they are simply closed over.
  app.use("/*", async (c, next) => {
    c.set("deps", deps);
    c.set("db", deps.db);
    c.set("auth", deps.auth);
    c.set("storage", deps.storage);
    c.set("rateLimit", deps.rateLimit);
    await next();
  });

  // ... every existing route registration, unchanged except that
  // `c.env.X` becomes `deps.x` ...

  const routes = app
    .route("/", invitesPublicApp)
    .route("/", adminRoutes)
    .route("/", domainApp);

  return routes;
}

// The Hono RPC client derives its types from this.
export type AppType = ReturnType<typeof createApi>;
```

**Do not annotate `createApi`'s return type.** An explicit annotation such as
`: OpenAPIHono<AppEnv>` erases exactly the accumulated route information
`AppType` exists to carry. Let it infer.

Replace the six `c.env` reads with `deps` values:
- `c.env.INDEXABLE === "1"` → `deps.indexable` (robots.txt, sitemap.xml — three sites)
- `c.env.APP_URL` → `deps.appUrl`
- the rest per the `Deps` field names from Task 1.

- [ ] **Step 4: Collapse `Bindings` in `context.ts`**

`Bindings` carried config plus the Bun server handle. Deps are closed over
now, so it becomes empty, and `PeerAddressSource` is deleted — the
`PeerAddress` port replaces it.

```ts
export type AppEnv = {
  // Nothing arrives through Hono's env any more: the process hands
  // createApi() one Deps object at startup and it is captured in the
  // closure. Kept as an empty type rather than removed so the generic
  // parameter shape is unchanged.
  Bindings: Record<string, never>;
  Variables: {
    deps: Deps;
    auth: Auth;
    db: Db;
    storage: Storage;
    rateLimit: RateLimitStore;
    sessionData: SessionData | null;
    apiKeyAuth?: boolean;
  };
};
```

`FamEnv` keeps its existing shape with the same `Bindings` change.

- [ ] **Step 5: Update the middleware that read `c.env`**

`middleware/rate-limit.ts` reads `c.env.server?.requestIP(...)` and
`c.env.TRUSTED_PROXY_HOPS`. Both come from `deps` now:

```ts
            clientIp(
              c.req.header("x-forwarded-for") ?? null,
              c.var.deps.peerAddress(c.req.raw),
              c.var.deps.trustedProxyHops,
            ),
```

The `clientIp()` function itself is unchanged — it is pure, and its tests must
keep passing untouched.

- [ ] **Step 6: Delete `services.ts`, and rename its type in the two files that use it**

```bash
git rm apps/api/src/services.ts
```

`cron.ts:9` and `scheduled.ts:18` both `import type { Services }` from it, so
deleting it breaks them. Change both to `import type { Deps } from "./deps"`
and rename the parameter and every `services.x` to `deps.x`. **That is the
whole change to those two files in this task** — splitting `scheduled.ts` into
`jobs/`, moving `cron.ts` to `apps/server` and swapping the scheduler onto
`Bun.cron` are Task 5. `Deps` is structurally a superset of what `Services`
provided (it adds `push`, `peerAddress`, `now` and the config values), so the
rename is mechanical.

Also repoint the package's main entry now that `app.ts` exists — in
`apps/api/package.json`:

```json
    ".": "./src/app.ts",
```

`rig.ts` becomes shorter: it builds a `Deps` directly instead of calling
`servicesFor(env, { storage })`. It still needs `loadEnv` — which moves to
`apps/server` in Task 4 — so for THIS task it keeps importing
`../src/config`. Task 4 replaces that with a literal `Deps`.

```ts
export const deps: Deps = {
  db,
  auth: createAuth(authConfig, db, null),
  storage,                       // the in-memory one
  rateLimit: createRateLimitStore(db),
  push: createPushSender(db, vapidConfig),
  peerAddress: () => null,       // no listening server in tests
  now: () => new Date(),
  appUrl: "http://localhost",
  vapidPublicKey: vapid.publicKey,
  stripePriceLifetime: "price_test_lifetime",
  trustedProxyHops: 0,
  openSignup: false,
  indexable: false,
};

export const app = createApi(deps);

export const SELF = {
  async fetch(input: string | Request, init?: RequestInit): Promise<Response> {
    const request =
      typeof input === "string" ? new Request(input, init) : input;
    return await app.fetch(request);
  },
};
```

Note `app.fetch(request)` loses its second argument — there is no env to pass.
Every test calls `SELF.fetch`, so this is the only place that changes.

`landing.test.ts` flips `OPEN_SIGNUP`/`INDEXABLE` on the env object today; it
must now build an app with a different `Deps` instead. Read that file and
adapt it — if the change is more than mechanical, report it rather than
guessing.

- [ ] **Step 7: Run the type assertion, then the suite**

```bash
cd apps/api && bun run typecheck 2>&1 | tail -5; cd ../..
bun run test 2>&1 | tail -6
```

Expected: typecheck PASSES (the assertions in Step 1 are satisfied), and
`179 pass` / `21 pass`.

If typecheck fails on `_AppTypeIsNotAny` or `_HasFeedsGet`, the route chain
collapsed. The usual cause is an explicit return-type annotation on
`createApi`, or a `.use()` call in statement form between `.route()` calls
breaking the chain. **Do not delete the assertion to get green** — it is the
only thing standing between you and a silently untyped frontend.

- [ ] **Step 8: Verify the frontend still typechecks against it**

```bash
bun run typecheck 2>&1 | tail -5
```

Expected: green across all four packages. This is what proves `AppType` still
carries real route information — `apps/frontend/src/lib/api.ts` builds its
client from it.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(api): createApi(deps) replaces the module-scope app

The route tree is built inside a function that receives its collaborators,
so apps/api no longer resolves anything for itself: servicesFor() and its
WeakMap<Env, Services> are gone, the inject middleware with them, and
Bindings collapses to empty because nothing arrives through Hono's env.

AppType is now derived from createApi's inferred return. A compile-time
assertion guards it: moving the .route() chain inside a function can
silently collapse the accumulated route types to any, which no runtime
test can see and which would quietly untype the whole frontend.

Phase: composition root (PR #16)"
```

---

### Task 4: `apps/server` — the composition root

**Files:**
- Move: `apps/api/src/config.ts` → `apps/server/src/env.ts`
- Move: `apps/api/test/config.test.ts` → `apps/server/test/config.test.ts`
- Create: `apps/server/src/deps.ts`
- Modify: `apps/server/src/main.ts`, `cron-cli.ts`, `migrate.ts`,
  `apps/server/package.json`, `apps/api/test/rig.ts`

**Interfaces:**
- Consumes: `createApi` (Task 3), the adapters (Task 2).
- Produces: `createDeps(env: Env): Deps` and `loadEnv(source): Env` from
  `apps/server`.

- [ ] **Step 1: Move the config and its test**

```bash
git mv apps/api/src/config.ts apps/server/src/env.ts
mkdir -p apps/server/test
git mv apps/api/test/config.test.ts apps/server/test/config.test.ts
sed -i 's#"\.\./src/config"#"../src/env"#' apps/server/test/config.test.ts
```

**Keep every field in the schema, including `INDEXABLE`.** The spec deletes it,
but that happens in PR #17 when the landing page leaves; `main.ts` still reads
it for the static-asset `X-Robots-Tag` header.

- [ ] **Step 2: Give `apps/server` a test script**

Add to `apps/server/package.json` scripts:

```json
    "test": "bun test",
```

No `bunfig.toml` for this package: `config.test.ts` needs no database, so
there is no preload to declare and the file would be empty.

**The script is not optional, and forgetting it loses tests silently.**
`apps/server` has none today because it has no tests. `config.test.ts` is
currently running as part of `@pjokk/api`'s 179; it holds 13 cases. Moving the
file without adding the script means `bun run --filter` skips the package,
those 13 stop running, and the exit code is still 0. After this task the split
should be **166 `@pjokk/api` + 13 `@pjokk/server` + 21 `@pjokk/frontend` = 200**.
Check the per-package output lines, not the status.

- [ ] **Step 3: Write `apps/server/src/deps.ts`**

```ts
import {
  createAuth,
  createDb,
  createPushSender,
  createRateLimitStore,
  createStorage,
  createStripe,
} from "@pjokk/api/infrastructure";
import type { Deps } from "@pjokk/api/deps";
import type { Env } from "./env";

/**
 * Builds every collaborator the API needs. The ONLY place in the codebase
 * that constructs one.
 *
 * `peerAddress` is a closure over a mutable reference because Bun's server
 * handle does not exist until Bun.serve() has returned, and the rate limiter
 * needs it on the first request. main.ts fills the reference in immediately
 * after serve() resolves.
 */
export type PeerAddressSource = {
  requestIP(request: Request): { address: string } | null;
};

export function createDeps(
  env: Env,
  serverRef: { current: PeerAddressSource | undefined },
): Deps {
  const db = createDb(env.DATABASE_URL);
  const stripeClient = createStripe(env.STRIPE_SECRET_KEY);

  return {
    db,
    auth: createAuth(
      {
        appUrl: env.APP_URL,
        secret: env.BETTER_AUTH_SECRET,
        googleClientId: env.GOOGLE_CLIENT_ID,
        googleClientSecret: env.GOOGLE_CLIENT_SECRET,
        stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
        stripePriceMonthly: env.STRIPE_PRICE_PREMIUM_MONTHLY,
        stripePriceYearly: env.STRIPE_PRICE_PREMIUM_YEARLY,
      },
      db,
      stripeClient,
    ),
    storage: createStorage({
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      region: env.S3_REGION,
    }),
    rateLimit: createRateLimitStore(db),
    push: createPushSender(db, {
      appUrl: env.APP_URL,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    }),
    peerAddress: (request) =>
      serverRef.current?.requestIP(request)?.address ?? null,
    now: () => new Date(),
    appUrl: env.APP_URL,
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
    stripePriceLifetime: env.STRIPE_PRICE_PREMIUM_LIFETIME,
    trustedProxyHops: env.TRUSTED_PROXY_HOPS,
    openSignup: env.OPEN_SIGNUP === "1",
    indexable: env.INDEXABLE === "1",
  };
}
```

- [ ] **Step 4: Rewrite `main.ts`**

The security-header middleware, static-file serving, SPA fallback, listener
and SIGTERM drain all stay exactly as they are. What changes is that the app
comes from `createApi(deps)` and there is no `bindings` object.

```ts
import { serveStatic } from "hono/bun";
import { createApi } from "@pjokk/api";
import { startScheduler } from "@pjokk/api/cron";
import { disabledSubsystems, loadEnv } from "./env";
import { createDeps } from "./deps";

const env = loadEnv(process.env);

// Filled in immediately after Bun.serve returns; the rate limiter reads the
// peer address through it. A ref rather than a rebuilt Deps because Deps is
// captured in createApi's closure and cannot be swapped afterwards.
const serverRef: { current: undefined | { requestIP(r: Request): { address: string } | null } } = {
  current: undefined,
};

const deps = createDeps(env, serverRef);
const app = createApi(deps);

// ... the existing header middleware, serveStatic, SPA fallback, unchanged
//     except that `env.INDEXABLE` stays read here (static assets, not the
//     API) and app.fetch takes one argument ...

const server = Bun.serve({
  port: env.PORT,
  hostname: "0.0.0.0",
  fetch: (request) => app.fetch(request),
});

serverRef.current = server;
```

- [ ] **Step 5: Rewrite `cron-cli.ts` and `migrate.ts`**

`cron-cli.ts`: replace `servicesFor(loadEnv(process.env))` with
`createDeps(loadEnv(process.env), { current: undefined })` and pass `deps` to
`runJob`. **Keep `process.exit(0)`** — Bun stays alive while the SQL pool
holds handles, so without it a cron-only pod succeeds and then hangs.

`migrate.ts`: **already done in Task 2** — it had to move with `createPool`'s
deletion. Verify it still reads
`createDb(env.DATABASE_URL)` from `@pjokk/api/infrastructure`, that
`MIGRATIONS_DIR` handling is untouched, and that the pool is still closed on
both the success and failure paths (`db.$client.end()`); make no further change.

- [ ] **Step 6: Point `rig.ts` at nothing in `apps/server`**

`apps/api/test/rig.ts` imported `loadEnv` from `../src/config`, which no
longer exists — and it must NOT import from `apps/server`. Replace the env
object with the literal `Deps` from Task 3 Step 6, taking the values that used
to come from `loadEnv` as inline literals.

This is the payoff of the whole PR: the rig stops constructing a fake
environment and simply states what the API depends on.

- [ ] **Step 7: Verify**

```bash
bun install
bun run test 2>&1 | tail -8
bun run check
bun run build
```

Expected, now that `config.test.ts` has moved packages: **166 `@pjokk/api` +
13 `@pjokk/server` + 21 `@pjokk/frontend` = 200**, with all three package lines
present in the output. Check and build green. A total of 187 with a zero exit
code means you moved the test file but did not add the `test` script in Step 2.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(server): createDeps is the composition root

apps/server now owns every construction: the pool, better-auth, the Stripe
client, storage, the rate-limit store and the push sender. apps/api reads no
environment variable and builds no collaborator.

config.ts moves here as env.ts with its test. peerAddress is a closure over
a ref because Bun's server handle does not exist until serve() returns, and
Deps is captured in createApi's closure so it cannot be swapped afterwards.

Phase: composition root (PR #16)"
```

---

### Task 5: `jobs/` and `Bun.cron`

**Files:**
- Split: `apps/api/src/scheduled.ts` (337 lines) into `apps/api/src/jobs/backup.ts`,
  `reminders.ts`, `calendar-reminders.ts`, `plans.ts`
- Move: `apps/api/src/cron.ts` → `apps/server/src/cron.ts`
- Modify: `apps/api/test/backup.test.ts`, `push.test.ts`,
  `calendar-reminders.test.ts` (import paths only)

**Interfaces:**
- Consumes: `Deps` from Task 1.
- Produces: `runBackup(deps, now?)`, `pruneBackups(deps, now?)`,
  `purgeOrphanUsers(deps, now?)`, `reconcilePlans(deps)`, `runReminders(deps, now?)`,
  `runCalendarReminders(deps, now?)` — all taking `Deps` where they took
  `Services`; and `SCHEDULES`, `runJob(job, deps)`, `startScheduler(deps)`
  from `apps/server/src/cron.ts`.

- [ ] **Step 1: Split `scheduled.ts` by job**

Move each exported function into the file named for it, with the imports it
needs. Group them as: `backup.ts` (`runBackup`, `pruneBackups`),
`reminders.ts` (`runReminders`), `calendar-reminders.ts`
(`runCalendarReminders`), `plans.ts` (`reconcilePlans`, `purgeOrphanUsers`).
Change each signature from `services: Services` to `deps: Deps` and each
`services.x` to `deps.x`. `pushToUser(db, env, ...)` becomes
`deps.push.toUser(...)`.

Replace each function's `now = Date.now()` / `now = new Date()` default with
`deps.now()` so the clock is injected rather than read:

```ts
export async function runReminders(deps: Deps, now = deps.now().getTime()) {
```

Keep every comment. These functions carry hard-won notes about the reminder
latch and the 60-minute grace window.

- [ ] **Step 2: Move `cron.ts` to `apps/server` and put it on `Bun.cron`**

```bash
git mv apps/api/src/cron.ts apps/server/src/cron.ts
```

Then switch the two importers from the package entry to the local file:
`apps/server/src/main.ts` and `cron-cli.ts` currently say
`from "@pjokk/api/cron"` (correct while the file lived in `apps/api`); both
become `from "./cron"`.

`runJob` already takes `Deps` — Task 3 renamed it. Its body is unchanged except
that its `./scheduled` imports become `@pjokk/api/jobs/<name>` imports, since
the job bodies stay in `apps/api` while the scheduling moves here.
`startScheduler` is replaced:

```ts
export const SCHEDULES = {
  nightly: "15 3 * * *",
  frequent: "*/15 * * * *",
} as const;

/**
 * In-process scheduler for single-container deployments (SCHEDULER=1).
 *
 * Bun.cron is a builtin as of Bun 1.4, which retires this file's previous
 * hand-rolled 15-minute tick — and with it two real defects: the nightly job
 * fired at whichever tick first landed past 03:15 (so its actual time
 * depended on when the process started), and setInterval would start a
 * second nightly run if the first outlived the interval, which matters for a
 * job that reads every table and writes a snapshot to object storage.
 *
 * tz is UTC explicitly. The default is the system zone, and the image does
 * not set TZ — so it is UTC by accident, not by contract, while the 30-day
 * backup retention window is a privacy-policy commitment stated in UTC.
 * "15 3 * * *" resolves to 03:15Z under UTC and 01:15Z under Europe/Oslo.
 *
 * The try/catch is load-bearing. Bun.cron matches setTimeout's error
 * semantics: a rejected promise emits unhandledRejection and, with no
 * listener, exits the process with code 1. The job reschedules itself after
 * an error, so catching here turns a transient database blip into a logged
 * line instead of a pod restart loop.
 *
 * NOTE: this fires once per replica, exactly as setInterval did. With more
 * than one replica, drive the jobs from Kubernetes CronJobs and leave
 * SCHEDULER=0.
 */
export function startScheduler(deps: Deps): () => void {
  const jobs = (Object.keys(SCHEDULES) as Job[]).map((job) =>
    Bun.cron(
      SCHEDULES[job],
      async () => {
        try {
          await runJob(job, deps);
        } catch (error) {
          console.error(`cron: ${job} failed`, error);
        }
      },
      { tz: "UTC" },
    ),
  );
  return () => {
    for (const job of jobs) job.stop();
  };
}
```

- [ ] **Step 3: Update the three job tests' imports**

They import from `../src/scheduled`; point each at the new `../src/jobs/<name>`.
Their bodies do not change except that they pass `deps` where they passed
`services` — which is the same object under a new name, since `rig.ts` now
exports `deps`.

- [ ] **Step 4: Verify, including the schedule expressions**

```bash
bun run test 2>&1 | tail -8
bun -e 'const n=new Date("2026-08-28T02:00:00Z");
console.log("nightly  ->", Bun.cron.parse("15 3 * * *", n, {tz:"UTC"}));
console.log("frequent ->", Bun.cron.parse("*/15 * * * *", n, {tz:"UTC"}));'
```

Expected: **166 / 13 / 21 = 200**, all three package lines present, and the two
schedules resolving to `2026-08-28T03:15:00.000Z` and `2026-08-28T02:15:00.000Z`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(jobs): split scheduled.ts and schedule with Bun.cron

The four jobs each get their own file and take Deps, with the clock injected
via deps.now() so the reminder and backup tests stop depending on the wall
clock. Scheduling moves to apps/server: api owns what a job does, server
owns when it runs.

Bun.cron replaces the hand-rolled tick, fixing two defects — the nightly job
fired at whichever 15-minute tick first landed past 03:15, and setInterval
could stack a second nightly run over a slow one. tz is UTC explicitly
because the default is the system zone and the image does not set TZ.

Phase: composition root (PR #16)"
```

---

### Task 6: Verification, docs, and the container gate

**Files:**
- Modify: `CLAUDE.md`, `DECISIONS.md`
- No source changes unless a check fails.

- [ ] **Step 1: Prove the invariant the PR exists to buy**

```bash
grep -rn 'process\.env' apps/api/src/ || echo "clean: apps/api reads no environment"
grep -rn '@pjokk/server\|apps/server' apps/api/src/ apps/api/test/ || echo "clean: no dependency inversion"
```

Expected: both `clean`. A hit in the first is a failed PR — that is the
invariant, not a nicety.

- [ ] **Step 2: Prove the import guard fires**

```bash
printf 'import { createDb } from "../infrastructure";\n' >> apps/api/src/middleware/tenancy.ts
bun run check 2>&1 | grep -ci 'restricted' && echo "guard fires"
git checkout apps/api/src/middleware/tenancy.ts
```

Expected: `guard fires`.

- [ ] **Step 3: Full green from a clean install**

```bash
rm -rf node_modules && bun install --frozen-lockfile
bun run check && bun run test 2>&1 | tail -8 && bun run build 2>&1 | tail -3
```

Expected: check green; **166 `@pjokk/api` + 13 `@pjokk/server` + 21
`@pjokk/frontend` = 200**, all three lines present; build green.

- [ ] **Step 4: The container gate**

The only check that exercises the bundled entrypoints, the migrations copy and
the static assets together.

```bash
docker build -t pjokk:cr-test .
docker run --rm -d --name pjokk-cr -p 3999:3000 \
  -e DATABASE_URL=postgres://pjokk:pjokk@host.docker.internal:55432/pjokk_test \
  -e APP_URL=http://localhost:3999 \
  -e BETTER_AUTH_SECRET=test-secret-please-ignore \
  -e S3_BUCKET=t -e S3_ENDPOINT=http://127.0.0.1:1 \
  -e S3_ACCESS_KEY_ID=t -e S3_SECRET_ACCESS_KEY=t \
  --add-host=host.docker.internal:host-gateway \
  pjokk:cr-test
sleep 3
curl -fsS localhost:3999/healthz && echo " healthz OK"
curl -fsS localhost:3999/ | head -3
docker logs pjokk-cr | tail -5
docker rm -f pjokk-cr
```

Expected: `{"ok":true} healthz OK` and the landing page's opening HTML. If `/`
returns the SPA shell, route ordering regressed.

- [ ] **Step 5: Update `CLAUDE.md`**

Four statements are now false. Fix each:
- The better-auth paragraph says the instance is built once "in
  `src/server/services.ts`" — that file is gone. It is built in
  `apps/server/src/deps.ts`.
- The storage rule names `apps/api/src/storage.ts`; it is now
  `apps/api/src/infrastructure/storage.ts`.
- The configuration rule names `apps/api/src/config.ts`; it is now
  `apps/server/src/env.ts`.
- The scheduled-work paragraph describes the in-process scheduler; add that it
  is `Bun.cron` with `tz: "UTC"` and that `SCHEDULER=0` still applies per
  replica.

Add one paragraph to the Stack section stating the ports rule: `apps/api`
never constructs a dependency at module scope and never reads `process.env`;
`apps/server` builds `Deps` and passes it to `createApi`.

- [ ] **Step 6: Add a `DECISIONS.md` entry**

Follow the file's existing format. Record: no DI container (a plain `Deps`
object was chosen deliberately); adapters live in `apps/api` rather than
`apps/server` because the Drizzle query layer must stay covered by the
real-Postgres suite; the boundary is enforced by a package entry plus a lint
rule rather than by convention; and `AppType` is guarded by a compile-time
assertion because collapsing it to `any` fails no runtime test.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs: record the ports-and-adapters wiring

CLAUDE.md's references to services.ts, storage.ts and config.ts all moved,
and the scheduler is Bun.cron now. Adds the rule the PR exists to enforce:
apps/api constructs nothing and reads no environment.

Phase: composition root (PR #16)"
```

---

## Notes for the reviewer

- The invariant to check first is `grep -rn 'process\.env' apps/api/src/` —
  everything else in this PR is in service of that line returning nothing.
- `apps/api/test/app-type.test.ts` is the guard for the one failure mode no
  runtime test can catch. If it was weakened or deleted, that is the finding.
- `createApi` must have **no explicit return type annotation**. An annotation
  erases the accumulated route types and silently untypes the frontend.
- `rig.ts` getting shorter is the point: it should now read as a statement of
  what the API depends on, rather than a fake environment.
