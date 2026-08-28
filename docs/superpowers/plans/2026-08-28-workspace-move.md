# Bun Workspace Move (PR #15) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the repository from a single `src/` tree into Bun workspaces —
`apps/api`, `apps/server`, `apps/frontend`, `packages/shared` — with no change
in behaviour.

**Architecture:** This is a *mechanical* move: `git mv` plus import rewrites
plus configuration path updates. The composition root, the ports, and the
landing split are PR #16 and #17 and are explicitly out of scope. The gate for
every task is that the existing suite still passes.

**Tech Stack:** Bun 1.4 workspaces, TypeScript 7, Vite 8, Biome 2, Hono,
Drizzle, Postgres.

**Spec:** `docs/superpowers/specs/2026-08-28-workspace-restructure-design.md`

## Global Constraints

- **No logic changes.** Exactly one deviation is authorised, in Task 5
  (`migrate.ts`'s `migrationsFolder`). Anything else that seems to need a logic
  change is a signal to stop and ask, not to improvise.
- **`git mv`, never delete-and-recreate.** `git log --follow` must keep working.
- **The root `bunfig.toml`'s `[install] linker = "hoisted"` must survive to the
  end of the PR.** Bun 1.4 defaults to the isolated linker when `workspaces`
  exists, which does not link an unreferenced workspace member. Removing that
  setting breaks `@pjokk/shared` resolution repo-wide. Only the `[test]`
  section moves into `apps/api/bunfig.toml`.
- Package names: `@pjokk/api`, `@pjokk/server`, `@pjokk/frontend`,
  `@pjokk/shared`.
- Third-party dependencies stay in the **root** `package.json` (Bun workspaces
  hoist them). Only *workspace* dependencies are declared per package. Splitting
  third-party deps is deliberately deferred.
- `apps/api` MUST NOT depend on `apps/server`. That is why `config.ts`,
  `cron.ts` and `services.ts` stay in `apps/api` for this PR.
- `apps/server` contains only `main.ts`, `cron-cli.ts`, `migrate.ts`.
- `apps/api` exports a wildcard `"./*": "./src/*.ts"` in this PR. Do not try to
  design a narrow public surface — that is PR #16.
- The Dockerfile's `CMD ["bun", "main.js"]` and the three bundle output names
  (`main.js`, `cron-cli.js`, `migrate.js`) must not change.
- `bunfig.toml` is cwd-local: it does not merge and does not walk up. Each
  package that needs a preload gets its own; the root fans out with
  `bun run --filter '*' <script>`.
- **From Task 2 onward, `bun test` is WRONG — always `bun run test`.** They are
  different commands: `bun test` invokes the test runner directly, and from the
  repo root (which no longer has a `bunfig.toml`) it discovers every package's
  test files with no preload, so the schema is never applied and the entire api
  suite fails. `bun run test` runs the root script, which fans out per package.
  This applies to CI and to anything you type by hand.
- `bun run --filter '*' <script>` **silently skips** packages that do not define
  that script, and still exits 0. Convenient here, but it means a package whose
  `test` script is accidentally dropped stops being tested without any error —
  check the per-package output lines, not just the exit code.
- Postgres must be running for the api suite:
  `docker compose -f docker-compose.test.yml up -d`.

## File Structure

| Path | Responsibility |
|---|---|
| `package.json` | Workspace list; all third-party deps; fan-out scripts |
| `tsconfig.base.json` | Shared compiler options, extended by each package |
| `packages/shared/` | `@pjokk/shared` — zod contracts (`src/schemas.ts`) |
| `apps/api/` | `@pjokk/api` — Hono app, db, routes, middleware, landing, jobs, tests |
| `apps/server/` | `@pjokk/server` — the three process entrypoints |
| `apps/frontend/` | `@pjokk/frontend` — SPA, `index.html`, `vite.config.ts`, frontend tests |

---

### Task 1: Workspace skeleton and `packages/shared`

**Files:**
- Modify: `package.json`
- Create: `tsconfig.base.json`
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Move: `src/shared/schemas.ts` → `packages/shared/src/schemas.ts`
- Modify: `tsconfig.json`, `vite.config.ts`, `biome.json`

**Interfaces:**
- Produces: package `@pjokk/shared`, whose single export `.` resolves to
  `packages/shared/src/schemas.ts`. Every consumer imports it as
  `import { … } from "@pjokk/shared"` (previously `@shared/schemas` or
  `../src/shared/schemas`).

- [ ] **Step 1: Confirm the suite is green before touching anything**

```bash
docker compose -f docker-compose.test.yml up -d
bun test 2>&1 | tail -5
```

Expected: `200 pass`, `0 fail`. If not, stop — you are not starting from a
known-good state and every later failure will be ambiguous.

- [ ] **Step 2: Move the shared schemas**

```bash
mkdir -p packages/shared/src
git mv src/shared/schemas.ts packages/shared/src/schemas.ts
rmdir src/shared
```

- [ ] **Step 3: Create `packages/shared/package.json`**

`exports` points straight at the `.ts` source — Bun and TypeScript
(`moduleResolution: "bundler"`) both follow it, so the package needs no build
step.

```json
{
  "name": "@pjokk/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/schemas.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

- [ ] **Step 4: Create `tsconfig.base.json`**

These are the options currently shared by `tsconfig.json` and
`tsconfig.server.json`. Nothing is added or removed.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true
  }
}
```

- [ ] **Step 5: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023"], "types": [] },
  "include": ["src"]
}
```

- [ ] **Step 6: Declare the workspaces in the root `package.json`**

Add these two keys alongside the existing `name`/`version`/`scripts`. Leave
`dependencies` and `devDependencies` exactly as they are.

```json
  "workspaces": ["apps/*", "packages/*"],
  "private": true,
```

- [ ] **Step 7: Rewrite every `@shared/schemas` and `../src/shared/schemas` import**

```bash
grep -rl '@shared/schemas\|src/shared/schemas' src test scripts \
  | xargs sed -i \
    -e 's#"@shared/schemas"#"@pjokk/shared"#g' \
    -e 's#"\.\./src/shared/schemas"#"@pjokk/shared"#g' \
    -e 's#"\.\./\.\./src/shared/schemas"#"@pjokk/shared"#g'
grep -rn '@shared/schemas\|src/shared/schemas' src test scripts || echo "clean"
```

Expected: `clean`.

- [ ] **Step 8: Point the two existing tsconfigs and Vite at the new package**

In `tsconfig.json` and `tsconfig.server.json`, delete the `@shared/*` entry
from `compilerOptions.paths` and remove `"src/shared"` from `include`.

In `vite.config.ts`, delete the `"@shared"` entry from `resolve.alias`.

In `biome.json`, no change yet — `src/**` still matches and
`packages/shared/**` must be added:

```json
    "includes": [
      "src/**",
      "packages/**",
      "test/**",
      "scripts/**",
      "*.ts",
      "!worker-configuration.d.ts",
      "!src/web/data",
      "!scripts/import-sprout-track.mjs"
    ]
```

- [ ] **Step 9: Install so Bun links the workspace, then verify**

```bash
bun install
bun run check
bun test 2>&1 | tail -5
```

Expected: `check` passes, `200 pass` / `0 fail`. A `Cannot find module
"@pjokk/shared"` here means `bun install` did not link the workspace — confirm
`node_modules/@pjokk/shared` is a symlink.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(workspace): extract @pjokk/shared

Declares bun workspaces and moves src/shared/schemas.ts into
packages/shared. Imports change from @shared/schemas to @pjokk/shared;
no other change.

Phase: workspace move (PR #15)"
```

---

### Task 2: `apps/api` and `apps/server`

The largest task, and the one that must stay strictly mechanical. `src/server`
splits by a single rule: **the three files that start a process go to
`apps/server`; everything else goes to `apps/api`.**

**Files:**
- Move: `src/server/{main,cron-cli,migrate}.ts` → `apps/server/src/`
- Move: all other `src/server/**` → `apps/api/src/`
- Move: `migrations/` → `apps/api/migrations/`
- Move: `test/**` → `apps/api/test/` (frontend tests leave in Task 4)
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/bunfig.toml`
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`
- Delete: `bunfig.toml` (root), `tsconfig.server.json`

**Interfaces:**
- Consumes: `@pjokk/shared` from Task 1.
- Produces: `@pjokk/api` with `"exports": { ".": "./src/index.ts", "./*": "./src/*.ts" }`.
  `apps/server` imports `app` from `@pjokk/api`, and `loadEnv`,
  `servicesFor`, `Bindings`, `startScheduler`, `runJob`, `isJob`, `JOBS`,
  `disabledSubsystems`, `createDb`, `createPool` from `@pjokk/api/<module>`.

- [ ] **Step 1: Move the files**

```bash
mkdir -p apps/api/src apps/server/src
git mv src/server/main.ts      apps/server/src/main.ts
git mv src/server/cron-cli.ts  apps/server/src/cron-cli.ts
git mv src/server/migrate.ts   apps/server/src/migrate.ts
for p in src/server/*; do git mv "$p" apps/api/src/; done
rmdir src/server
git mv migrations apps/api/migrations
mkdir -p apps/api/test
for p in test/*; do git mv "$p" apps/api/test/; done
rmdir test
```

- [ ] **Step 2: Rewrite the test imports**

Tests move one level deeper in the same package, so `../src/server/x` becomes
`../src/x`.

```bash
sed -i 's#"\.\./src/server/#"../src/#g' apps/api/test/*.ts
grep -rn '\.\./src/server/' apps/api/test/ || echo "clean"
```

Expected: `clean`.

- [ ] **Step 3: Rewrite the three entrypoints' imports**

These are the only files whose imports cross a package boundary. Edit each by
hand — there are three, and a blind `sed` would be less safe than reading them.

`apps/server/src/main.ts`:

```ts
import { serveStatic } from "hono/bun";
import { disabledSubsystems, loadEnv } from "@pjokk/api/config";
import type { Bindings } from "@pjokk/api/context";
import { startScheduler } from "@pjokk/api/cron";
import { app } from "@pjokk/api";
import { servicesFor } from "@pjokk/api/services";
```

`apps/server/src/cron-cli.ts`:

```ts
import { loadEnv } from "@pjokk/api/config";
import { isJob, JOBS, runJob } from "@pjokk/api/cron";
import { servicesFor } from "@pjokk/api/services";
```

`apps/server/src/migrate.ts`:

```ts
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { loadEnv } from "@pjokk/api/config";
import { createDb, createPool } from "@pjokk/api/db";
```

- [ ] **Step 4: Create `apps/api/package.json`**

The wildcard export is deliberate and temporary — PR #16 replaces it with a
two-entry public/infrastructure split.

`"./db"` needs its own entry because `src/db` is a **directory**: the wildcard
`"./*": "./src/*.ts"` maps `@pjokk/api/db` to `./src/db.ts`, which does not
exist, and the failure is invisible to `bun run test` (nothing in `apps/server`
has tests) — it surfaces only at `bun run build:server`. `db` is the only
directory `apps/server` imports across the package boundary; `landing`,
`middleware` and `routes` are reached by relative paths from inside `apps/api`,
so they need no entry.

```json
{
  "name": "@pjokk/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./db": "./src/db/index.ts",
    "./*": "./src/*.ts"
  },
  "dependencies": {
    "@pjokk/shared": "workspace:*"
  },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

- [ ] **Step 5: Create `apps/server/package.json`**

```json
{
  "name": "@pjokk/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@pjokk/api": "workspace:*",
    "@pjokk/shared": "workspace:*"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

- [ ] **Step 6: Create the two tsconfigs**

`apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023"], "types": ["bun"] },
  "include": ["src", "test"]
}
```

`apps/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023"], "types": ["bun"] },
  "include": ["src"]
}
```

- [ ] **Step 7: Move the test preload config into the package**

**Do NOT delete the root `bunfig.toml`.** Task 1 added an `[install]` section
to it that the workspace depends on: Bun 1.4 defaults to the *isolated* linker
once a `workspaces` field exists, and the isolated linker only symlinks a
workspace member that some `package.json` actually declares as a dependency.
`linker = "hoisted"` restores the flat `node_modules` layout this repo used
before workspaces, which links every member by name. Deleting the file
un-links `@pjokk/shared` and every import of it fails.

Instead, remove ONLY the `[test]` section from the root `bunfig.toml`, leaving
`[install]` and its comment intact, and create `apps/api/bunfig.toml` with the
preload — the path is already package-relative, so it needs no edit.

```bash
cat > apps/api/bunfig.toml <<'EOF'
[test]
# Applies the schema once and empties the database before each test. Lives in
# this package rather than the repo root because bunfig.toml is resolved from
# the working directory only: it does not merge with a parent and does not walk
# up, so a root-level preload would either be ignored or would impose this
# package's Postgres setup on packages that have no database.
preload = ["./test/setup.ts"]
EOF
git add apps/api/bunfig.toml
git rm tsconfig.server.json
```

Verify the linker survived the edit before moving on — this is the failure this
step exists to avoid:

```bash
bun install
ls -l node_modules/@pjokk/
```

Expected: `shared -> ../../packages/shared` and `api -> ../../apps/api`.

- [ ] **Step 8: Point the root scripts at the workspaces**

Replace these entries in the root `package.json` `scripts`. `--filter '*'` runs
each package with its own working directory, which is what makes the per-package
`bunfig.toml` apply.

```json
    "dev:server": "bun --watch apps/server/src/main.ts",
    "start": "bun apps/server/src/main.ts",
    "cron": "bun apps/server/src/cron-cli.ts",
    "migrate": "MIGRATIONS_DIR=apps/api/migrations bun apps/server/src/migrate.ts",
```

`MIGRATIONS_DIR` is inert until Task 5 Step 1 makes `migrate.ts` read it.
Nothing between here and there runs `bun run migrate`, so setting it now keeps
the script edits in one place.

```json
    "test": "bun run --filter '*' test",
    "typecheck": "bun run --filter '*' typecheck",
    "build:server": "bun build apps/server/src/main.ts apps/server/src/cron-cli.ts apps/server/src/migrate.ts --target=bun --outdir=dist/server --sourcemap=linked"
```

- [ ] **Step 9: Point drizzle-kit at the moved schema**

In `drizzle.config.ts`:

```ts
  schema: "./apps/api/src/db/schema.ts",
  out: "./apps/api/migrations",
```

- [ ] **Step 10: Install and run the api suite**

`MIGRATIONS_DIR` is wired in Task 5; the suite does not use it (`test/setup.ts`
resolves the migration file from `import.meta.url`, which already points inside
`apps/api`).

```bash
bun install
bun run test 2>&1 | tail -8
bun run build:server 2>&1 | tail -6
```

Expected: `200 pass`, `0 fail`, reported under `@pjokk/api test:`; then three
bundles written to `dist/server`. Note the test command is `bun run test`, not
`bun test` — see Global Constraints. If you typed `bun test` you will see a wall
of failures about missing tables; that is the missing preload, not a broken move.

**`build:server` is not optional here.** `apps/server` has no tests, so the
suite cannot see whether its cross-package imports resolve at all. The bundler
is the only gate in this task that exercises the `@pjokk/api` export map.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor(workspace): split src/server into @pjokk/api and @pjokk/server

apps/server keeps only the three files that start a process (main,
cron-cli, migrate); everything else becomes the @pjokk/api library.
Migrations and the test suite move with the schema they exercise.

bunfig.toml moves into apps/api because bun resolves it from the working
directory only — it neither merges with a parent nor walks up — so a
root-level preload would impose this package's Postgres setup on every
other package.

config.ts, cron.ts and services.ts deliberately stay in apps/api: rig.ts
needs loadEnv, and apps/api must not depend on apps/server. They relocate
in PR #16 when Deps gives them somewhere to go.

Phase: workspace move (PR #15)"
```

---

### Task 3: `apps/frontend`

> **Tasks 3 and 4 must land together, as one reviewable unit with two commits.**
> Three test files in `apps/api/test` import `src/web` (`growth.test.ts:2`,
> `vaccine-programme.test.ts:9`, `defects.test.ts:4`). Task 3 moves `src/web`
> out from under them and Task 4 is what repairs them, so stopping between the
> two leaves the suite red. Do Task 3's steps, commit, then Task 4's steps,
> commit, and run `bun run test` once at the end of Task 4 — that is the gate
> for both. Task 3's own gate is `bun run build:client` only.

**Files:**
- Move: `src/web/**` → `apps/frontend/src/`
- Move: `index.html`, `vite.config.ts` → `apps/frontend/`
- Move: `public/` → `apps/frontend/public/`
- Create: `apps/frontend/package.json`, `apps/frontend/tsconfig.json`
- Modify: `apps/frontend/src/lib/api.ts:2`
- Delete: `tsconfig.json` (root, replaced by the per-package one)

**Interfaces:**
- Consumes: `@pjokk/shared`; the type `AppType` from `@pjokk/api`.
- Produces: `@pjokk/frontend`, whose `build` script emits to the repo-root
  `dist/client` that `STATIC_DIR` already points at.

- [ ] **Step 1: Move the files**

```bash
mkdir -p apps/frontend
git mv src/web apps/frontend/src
git mv index.html apps/frontend/index.html
git mv vite.config.ts apps/frontend/vite.config.ts
git mv public apps/frontend/public
rmdir src
```

- [ ] **Step 2: Fix the SPA entry path in `index.html`**

`index.html` now sits beside `src/`, so the script src loses the `/src/web`
prefix. Change the one line:

```html
    <script type="module" src="/src/main.tsx"></script>
```

- [ ] **Step 3: Repoint the `AppType` import**

`apps/frontend/src/lib/api.ts:2` currently reads
`import type { AppType } from "../../server/index";`. Replace it with:

```ts
import type { AppType } from "@pjokk/api";
```

- [ ] **Step 4: Update `vite.config.ts`**

The `@shared` alias is already gone (Task 1). Update `@` to the new source
root and make the build output path explicit relative to the repo root, since
Vite's root is now `apps/frontend`:

```ts
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
```

and

```ts
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
```

- [ ] **Step 5: Create `apps/frontend/package.json`**

```json
{
  "name": "@pjokk/frontend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@pjokk/api": "workspace:*",
    "@pjokk/shared": "workspace:*"
  },
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "test": "bun test",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

- [ ] **Step 6: Create `apps/frontend/tsconfig.json`**

This replaces the root `tsconfig.json`, carrying over its DOM lib, JSX setting,
`types`, and the `@/*` path.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client", "node", "vite-plugin-pwa/client"],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

Then delete the root one:

```bash
git rm tsconfig.json
```

- [ ] **Step 7: Update the root `build:client` script and i18n checker**

In the root `package.json`:

```json
    "build:client": "bun run --filter @pjokk/frontend build",
    "dev": "bun run --filter @pjokk/frontend dev",
```

In `scripts/check-i18n.mjs`, lines 8-9:

```js
const ROOT = "apps/frontend/src";
const DICT_FILE = "apps/frontend/src/lib/i18n.ts";
```

- [ ] **Step 8: Verify the client builds**

```bash
bun install
bun run build:client 2>&1 | tail -5
ls dist/client/index.html
```

Expected: a successful Vite build and the file present. A `Failed to resolve
import "/src/main.tsx"` means Step 2 was missed.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(workspace): move the SPA into @pjokk/frontend

src/web, index.html, vite.config.ts and public/ move into apps/frontend.
The AppType import crosses a package boundary now (@pjokk/api) instead of
reaching up two directories. Vite's outDir is repo-root relative so
STATIC_DIR is unchanged.

Phase: workspace move (PR #15)"
```

---

### Task 4: Relocate the frontend tests

> **Continues Task 3 in the same dispatch — see the note there.** The suite is
> expected to be RED when you start this task: Task 3 moved `src/web` out from
> under three test files that import it. Repairing that is this task's job.

Three test files exercise frontend code and cannot stay in `apps/api` — that
package must not depend on `@pjokk/frontend`.

Note that Task 2 left those imports as `../../../src/web/lib/...` (a transient
bridge to the repo root). After Task 3 the correct target is
`apps/frontend/src/lib/...`, which for a test file inside `apps/frontend/test/`
is simply `../src/lib/...`.

**Files:**
- Move: `apps/api/test/growth.test.ts` → `apps/frontend/test/growth.test.ts`
- Move: `apps/api/test/vaccine-programme.test.ts` → `apps/frontend/test/`
- Create: `apps/frontend/test/time-helpers.test.ts`
- Modify: `apps/api/test/defects.test.ts` (remove lines 155-174 and the now-unused import)

**Interfaces:**
- Consumes: `@pjokk/shared`, and `@/lib/growth`, `@/lib/time`,
  `@/lib/vaccine-programme` within `apps/frontend`.

- [ ] **Step 1: Move the two pure-frontend test files**

```bash
mkdir -p apps/frontend/test
git mv apps/api/test/growth.test.ts apps/frontend/test/growth.test.ts
git mv apps/api/test/vaccine-programme.test.ts apps/frontend/test/vaccine-programme.test.ts
sed -i 's#"\.\./\.\./\.\./src/web/lib/#"../src/lib/#g' apps/frontend/test/*.ts
grep -rn 'src/web' apps/frontend/test/ || echo "clean"
```

Expected: `clean`.

- [ ] **Step 2: Extract the time-helper block into the frontend package**

Create `apps/frontend/test/time-helpers.test.ts` with the block currently at
`apps/api/test/defects.test.ts:155-174`:

```ts
import { describe, expect, it } from "bun:test";
import { formatRelative, toLocalDateInput } from "../src/lib/time";

describe("time helpers", () => {
  it("stays relative across midnight", () => {
    const now = new Date("2026-08-25T01:00:00");
    expect(formatRelative(new Date("2026-08-24T22:30:00"), now)).toBe(
      "2 h ago",
    );
    expect(
      formatRelative(
        new Date("2026-08-24T23:59:00"),
        new Date("2026-08-25T00:01:00"),
      ),
    ).toBe("2 m ago");
  });

  it("formats date inputs in local time", () => {
    const d = new Date("2026-08-25T00:30:00");
    expect(toLocalDateInput(d)).toBe("2026-08-25");
  });
});
```

Before running it, open `apps/api/test/defects.test.ts:155-174` and confirm
the assertions above match it exactly. If they differ, the file on disk wins —
copy from it verbatim rather than trusting this plan.

- [ ] **Step 3: Remove that block from the api test**

Delete lines 155-174 of `apps/api/test/defects.test.ts` (the whole
`describe("time helpers", …)` block) and delete its now-unused import on line 4:

```ts
import { formatRelative, toLocalDateInput } from "../../../src/web/lib/time";
```

(Task 2 rewrote this import to reach the repo root; that is the form on disk.
Confirm against the file rather than trusting either spelling.)

- [ ] **Step 4: Run both suites**

```bash
bun run test 2>&1 | tail -12
```

Expected: both `@pjokk/api test:` and `@pjokk/frontend test:` report, with the
same total pass count as Step 1 of Task 1 (`200`). A count that dropped means a
test file was orphaned rather than moved.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(workspace): move frontend tests into @pjokk/frontend

growth, vaccine-programme and the time-helper block from defects.test.ts
exercise src/web, so they belong with the frontend package — apps/api must
not depend on @pjokk/frontend.

Phase: workspace move (PR #15)"
```

---

### Task 5: Root tooling, Docker and CI

**Files:**
- Modify: `apps/server/src/migrate.ts` (the one authorised logic change)
- Modify: `biome.json`, `.dockerignore`, `Dockerfile`, `.github/workflows/ci.yml`
- Modify: `package.json` (`check` script)

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: a green `bun run check`, a building image, and a CI workflow that
  exercises the same commands.

- [ ] **Step 1: Make the migrations folder overridable**

This is the single authorised deviation from "no logic changes".
`migrationsFolder` is resolved against the *working directory*: `./migrations`
is right inside the image (`WORKDIR /app`) but wrong from the repo root now
that the folder lives under `apps/api`. In `apps/server/src/migrate.ts`:

```ts
// Resolved against the working directory. Inside the image that is /app, where
// the Dockerfile copies the SQL to ./migrations, so the default is correct
// there and the variable is left unset. From a source checkout the folder is
// under apps/api, which is what the root `migrate` script passes.
const migrationsFolder = process.env.MIGRATIONS_DIR ?? "./migrations";

try {
  await migrate(createDb(pool), { migrationsFolder });
```

- [ ] **Step 2: Update `biome.json` includes**

`src/**` and `test/**` no longer exist.

```json
    "includes": [
      "apps/**",
      "packages/**",
      "scripts/**",
      "*.ts",
      "!apps/frontend/src/data",
      "!apps/api/migrations/meta",
      "!scripts/import-sprout-track.mjs"
    ]
```

The `worker-configuration.d.ts` exclusion goes — that file is gone with
Cloudflare.

`!apps/api/migrations/meta` is **required**, not optional. Broadening the
include from `src/**` to `apps/**` pulls drizzle-kit's generated snapshot and
journal into lint scope for the first time. Formatting them is actively wrong:
drizzle-kit owns those files and writes `_journal.json` with no trailing
newline, so biome's reformat is reverted by the next `drizzle-kit generate` and
`bun run check` starts failing in CI on an unrelated change. This follows the
existing `!apps/frontend/src/data` precedent for bundled data that no human
edits.

Broadening the include also reaches `apps/frontend/public/` for the first time.
Formatting `push-sw.js` and adding the `<title>` element biome's a11y rule
requires to the two PWA icon SVGs is correct and in scope — those are hand-
written source, unlike the generated migration metadata.

- [ ] **Step 3: Update the `check` script**

```json
    "check": "biome check . && node scripts/check-i18n.mjs && bun run typecheck",
```

- [ ] **Step 4: Update `.dockerignore`**

`test` no longer matches now that tests live inside packages, and the spec
requires `**/node_modules`.

```
**/node_modules
dist

.git
.github
docs
**/test
*.md

.dev.vars
.env
.env.*
!.env.example

.vscode
.idea
```

- [ ] **Step 5: Update the Dockerfile**

Two changes. First, the **deps stage must copy every workspace manifest**
before installing. It currently copies only the root `package.json`, which
worked when there was one package; with `workspaces` declared, `bun install
--frozen-lockfile` needs each member's `package.json` present to resolve the
`workspace:*` links. Replace the two COPY/RUN lines in the `deps` stage with:

```dockerfile
COPY package.json bun.lock ./
# Every workspace manifest, and ONLY the manifests: this stage exists so that
# editing source never reinstalls, and copying whole packages here would
# reintroduce exactly the cache busting it avoids.
COPY apps/api/package.json ./apps/api/
COPY apps/server/package.json ./apps/server/
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/shared/package.json ./packages/shared/
RUN bun install --frozen-lockfile
```

Second, the runtime stage's migrations path:

```dockerfile
COPY apps/api/migrations ./migrations
```

The build and runtime stages are otherwise unaffected, because `bun run build`
still emits `dist/server` and `dist/client`.

- [ ] **Step 6: Verify check, tests and build together**

```bash
bun run check
bun run test 2>&1 | tail -6
bun run build 2>&1 | tail -5
```

Expected: all three succeed; `200 pass` / `0 fail`.

- [ ] **Step 7: Verify the image builds and serves**

The image is the real gate: it is the only check that the bundled entrypoints,
the migrations copy and the static assets all still line up.

```bash
docker build -t pjokk:ws-test .
docker run --rm -d --name pjokk-ws -p 3999:3000 \
  -e DATABASE_URL=postgres://pjokk:pjokk@host.docker.internal:55432/pjokk_test \
  -e APP_URL=http://localhost:3999 \
  -e BETTER_AUTH_SECRET=test-secret-please-ignore \
  -e S3_BUCKET=t -e S3_ENDPOINT=http://127.0.0.1:1 \
  -e S3_ACCESS_KEY_ID=t -e S3_SECRET_ACCESS_KEY=t \
  --add-host=host.docker.internal:host-gateway \
  pjokk:ws-test
sleep 3
curl -fsS localhost:3999/healthz && echo " healthz OK"
curl -fsS localhost:3999/ | head -3
docker logs pjokk-ws | tail -5
docker rm -f pjokk-ws
```

Expected: `{"ok":true} healthz OK`, and the landing page's opening HTML. If
`/` returns the SPA shell instead of the landing markup, route ordering was
disturbed — that is a real regression, not a cosmetic one.

- [ ] **Step 8: Fix the CI test command**

`.github/workflows/ci.yml:49` runs `bun test`, which is now the broken
invocation — it would run every package's tests from the repo root with no
preload. Change that one line:

```yaml
      - name: Tests
        run: bun run test
```

The `Install` (`bun install --frozen-lockfile`), `Lint + typecheck`
(`bun run check`) and `Build` (`bun run build`) steps need no change, because
the root scripts fan out. `release.yml` references only `bun run check` and
in-image commands (`bun migrate.js`, `bun cron-cli.js frequent`), none of which
are affected.

Also update the stale comment at `ci.yml:157`, which says `bun test`, to
`bun run test`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore(workspace): update tooling, Docker and CI for the workspace layout

biome includes, .dockerignore, the drizzle schema path and the Dockerfile's
migrations COPY all follow the move. The root check/test/build scripts fan
out across workspaces, so CI needs no change.

migrate.ts gains MIGRATIONS_DIR: migrationsFolder resolves against the
working directory, which is correct inside the image but not from a source
checkout now that migrations live under apps/api. The image leaves it unset.

Phase: workspace move (PR #15)"
```

---

### Task 6: Final verification and PR

**Files:** none — this task only verifies.

- [ ] **Step 1: Confirm nothing is left behind**

```bash
test ! -d src && test ! -d test && echo "old trees gone"
ls apps packages
git status --porcelain | head
```

Expected: `old trees gone`, the four packages listed, a clean working tree.

- [ ] **Step 2: Confirm history survived the move**

```bash
git log --follow --oneline apps/api/src/db/scoped.ts | tail -3
```

Expected: commits predating this PR. If the log stops at this PR, a file was
recreated rather than `git mv`d, and the move must be redone for that file.

- [ ] **Step 3: Confirm no stale path references remain**

```bash
grep -rn '"src/\|/src/web/\|src/server/\|@shared/' \
  --include='*.json' --include='*.ts' --include='*.mjs' --include='*.yml' \
  --include='Dockerfile' --include='*.toml' . \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=docs \
  || echo "no stale references"
```

Expected: `no stale references`. Matches inside `apps/*/src/...` relative
imports are fine; matches in configuration are not.

- [ ] **Step 4: Full green run from a clean install**

```bash
rm -rf node_modules
bun install --frozen-lockfile
bun run check && bun run test 2>&1 | tail -6 && bun run build 2>&1 | tail -3
```

Expected: all green, `200 pass`. The clean install matters — it is what CI
does, and it is the only way to catch a workspace link that only worked because
of a stale `node_modules`.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin workspace-move
gh pr create --title "Bun workspaces: apps/{api,server,frontend} + packages/shared" --body "$(cat <<'EOF'
Mechanical move of the tree into Bun workspaces. No behaviour change.

- `packages/shared` — the zod contracts, imported as `@pjokk/shared`
- `apps/api` — the Hono app, db, routes, middleware, landing, migrations, tests
- `apps/server` — only the three files that start a process
- `apps/frontend` — the SPA, plus the three test files that exercise it

`bunfig.toml` moves into `apps/api`: bun resolves it from the working
directory only, so a root-level preload would either be ignored or would
impose the api's Postgres setup on packages with no database. The root
`test`/`typecheck` scripts fan out with `bun run --filter '*'`.

One deviation from "no logic changes": `migrate.ts` gains `MIGRATIONS_DIR`,
because `migrationsFolder` resolves against the working directory and the
folder moved under `apps/api`. The image leaves it unset and is unaffected.

`config.ts`, `cron.ts` and `services.ts` stay in `apps/api` for now — `rig.ts`
needs `loadEnv` and `apps/api` must not depend on `apps/server`. They relocate
in the composition-root PR, which also replaces the temporary wildcard
`exports` with the public/infrastructure split.

Spec: `docs/superpowers/specs/2026-08-28-workspace-restructure-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Notes for the reviewer

- The diff is large but should be almost entirely renames. `git show --stat -M`
  makes that legible; anything reported as a modification rather than a rename
  deserves a look.
- The three files with genuinely changed content are `apps/server/src/main.ts`,
  `cron-cli.ts` and `migrate.ts` (import rewrites, plus `MIGRATIONS_DIR`), plus
  `apps/frontend/src/lib/api.ts` (one import) and `index.html` (one line).
- If the combined run reports fewer than 200 passing tests, a file was orphaned
  by the move rather than a test genuinely failing. `ls apps/*/test/*.test.ts |
  wc -l` should be **26**: the 25 that existed before, plus
  `time-helpers.test.ts` split out of `defects.test.ts` in Task 4.
- `bun run --filter` skips packages with no matching script and still exits 0,
  so confirm both `@pjokk/api test:` and `@pjokk/frontend test:` appear in the
  output. An exit code of 0 alone does not mean both suites ran.
