# Landing Split + Distroless Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the landing page and the legal pages out of the container into a
static site on the apex (`pjokk.no`), with the app returning to
`app.pjokk.no`; and replace the three-bundle Alpine image with a single
compiled binary on `gcr.io/distroless/base-debian12:nonroot`.

**Architecture:** `apps/landing` becomes a build-time static site emitting six
HTML documents (en/nb × landing/privacy/terms) plus `robots.txt`,
`sitemap.xml` and the OG image. The legal prose is **prerendered from the
existing React components** with `renderToStaticMarkup`, never retyped. The
container drops `/`, `/privacy`, `/terms` and `/sitemap.xml`, serves an
unconditional `Disallow: /`, and ships as one dispatcher binary.

**Tech Stack:** Bun 1.4, `react-dom/server`, Docker + distroless, Hono.

**Spec:** `docs/superpowers/specs/2026-08-28-workspace-restructure-design.md`
(pieces 3 and 4). This plan continues
`docs/superpowers/plans/2026-08-28-composition-root.md`, which must be
complete first.

## Global Constraints

- **No test may be lost.** The suite is **167 `@pjokk/api` + 13 `@pjokk/server`
  + 21 `@pjokk/frontend` = 201** at the start. Landing tests move packages;
  the total must not fall except where this plan explicitly accounts for it.
- **`bun run test`, never `bun test`.** The root `bunfig.toml` has no `[test]`
  section. `bun run --filter` silently skips a package with no matching script
  and still exits 0 — check the per-package lines, not the exit code.
- **A package with tests needs a `test` script**, or its cases stop running
  silently.
- Do not remove `[install] linker = "hoisted"` from the root `bunfig.toml`.
- **`apps/api` must never read `process.env` or construct a dependency.**
- **The legal prose must not be retyped.** It is a legal statement about GDPR
  Article 9 data. Prerender the existing components; if you find yourself
  copying paragraphs by hand, stop and report.
- **Line numbers are deliberately absent from this plan.** Every location is
  given as a search command instead, because the composition-root PR moved
  most of these files and cited line numbers would be stale. Run the search,
  then read what it finds.
- Conventional Commits; reference `Phase: landing split (PR #17)` or
  `Phase: distroless (PR #18)` in bodies.

## Out-of-repo prerequisites (piece 1 cannot merge without these)

The user is handling these in parallel; confirm before the final review:

- DNS: `app.pjokk.no` → the container; `pjokk.no` → the static host
- Google OAuth: **add** `https://app.pjokk.no/api/auth/callback/google` as an
  authorised redirect URI, keeping the existing entry until after cutover
- Stripe: webhook endpoint host → `app.pjokk.no`
- Stripe: Settings → Billing → Customer portal → default redirect link →
  `https://app.pjokk.no/settings`
- Deploy env: `APP_URL` → `https://app.pjokk.no`, add `SITE_URL` →
  `https://pjokk.no`

Checkout success/cancel URLs need **no** change — they are built from
`APP_URL` in code. Find them with:
`grep -rn 'success_url\|cancel_url' apps/api/src`

---

# Piece 1 — the landing split

### Task 1: `apps/landing` renders the marketing page

**Files:**
- Create: `apps/landing/package.json`, `tsconfig.json`, `build.ts`
- Move: `apps/api/src/landing/{copy,page,styles}.ts` → `apps/landing/src/`
- Create: `apps/landing/test/render.test.ts`

**Interfaces:**
- Produces: `renderLandingPage(opts)` from `apps/landing/src/page.ts`
  (unchanged signature — it already takes `{ lang, cta, origin, noindex }`
  explicitly), and a `build.ts` that writes `dist/`.

- [ ] **Step 1: Establish the baseline**

```bash
docker compose -f docker-compose.test.yml up -d
bun run test 2>&1 | tail -8
```

Expected: `167` / `13` / `21`, all three package lines present.

- [ ] **Step 2: Move the three renderable files**

`index.ts` stays behind for now — it is the Hono handler and is deleted in
Task 3.

```bash
mkdir -p apps/landing/src apps/landing/test
git mv apps/api/src/landing/copy.ts   apps/landing/src/copy.ts
git mv apps/api/src/landing/page.ts   apps/landing/src/page.ts
git mv apps/api/src/landing/styles.ts apps/landing/src/styles.ts
```

- [ ] **Step 3: Create `apps/landing/package.json`**

```json
{
  "name": "@pjokk/landing",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "bun run build.ts",
    "test": "bun test",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

- [ ] **Step 4: Create `apps/landing/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM"],
    "jsx": "react-jsx",
    "types": ["bun"]
  },
  "include": ["src", "test", "build.ts"]
}
```

`DOM` and `jsx` are here for Task 2, which prerenders React components in
this package.

- [ ] **Step 5: Write `apps/landing/build.ts` for the marketing page only**

Legal pages are added in Task 2; robots/sitemap in Task 4.

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { LANDING_COPY, type LandingLang } from "./src/copy";
import { renderLandingPage } from "./src/page";

// The landing site is BUILT, not served. Language is chosen per document at
// build time rather than negotiated per request: the old server-side
// ?lang= -> cookie -> Accept-Language chain died with the move off the
// container, and two prerendered documents with hreflang alternates are what
// a crawler wants anyway.

const SITE_URL = process.env.SITE_URL ?? "https://pjokk.no";
const APP_URL = process.env.APP_URL ?? "https://app.pjokk.no";
const OPEN_SIGNUP = process.env.OPEN_SIGNUP === "1";
const INDEXABLE = process.env.INDEXABLE !== "0";

const OUT = new URL("./dist/", import.meta.url);

async function write(path: string, body: string) {
  const target = new URL(path, OUT);
  await mkdir(new URL(".", target), { recursive: true });
  await writeFile(target, body);
}

for (const lang of ["en", "nb"] as LandingLang[]) {
  const copy = LANDING_COPY[lang];
  // No session to read on a static host, so the CTA is unconditional. It
  // points at the app's own origin now that the two are different hosts.
  const cta = {
    label: OPEN_SIGNUP ? copy.ctaGetStarted : copy.ctaSignIn,
    href: `${APP_URL}/login`,
  };
  const html = renderLandingPage({
    lang,
    cta,
    origin: SITE_URL,
    noindex: !INDEXABLE,
  });
  await write(lang === "en" ? "index.html" : `${lang}/index.html`, html);
}

console.log("landing: wrote dist/index.html, dist/nb/index.html");
```

- [ ] **Step 6: Check what `renderLandingPage` emits for links**

The page template was written when landing and app shared an origin, so
internal links like `/login` and `/home` were relative. They now point at a
different host. Find them:

```bash
grep -n 'href=' apps/landing/src/page.ts
grep -n '/login\|/home\|/privacy\|/terms' apps/landing/src/page.ts
```

Any link to an **app** route must become absolute against `APP_URL`; links to
**landing** routes (`/privacy`, `/terms`) stay relative. `renderLandingPage`
already receives `cta.href`, so the CTA is handled — check the footer and any
nav links. If the template needs a new parameter to do this, add one; do not
hardcode a host inside the template.

- [ ] **Step 7: Write the render test**

`apps/api/test/landing.test.ts` currently drives the Hono handler. Its
render-level assertions move here; its HTTP-level ones are deleted in Task 3
along with the route. Read it first:

```bash
grep -n 'it(\|describe(' apps/api/test/landing.test.ts
```

Then write `apps/landing/test/render.test.ts` covering, as pure function
calls: both languages render; the CTA label follows `OPEN_SIGNUP`; the CTA
href points at the app origin; `noindex` emits the meta tag; and the hreflang
alternates are present.

- [ ] **Step 8: Verify and commit**

```bash
bun install
bun run --filter @pjokk/landing build
ls apps/landing/dist apps/landing/dist/nb
bun run test 2>&1 | tail -10
```

Expected: two documents written; four package lines in the test output.

```bash
git add -A
git commit -m "feat(landing): render the marketing page as a static site

apps/landing builds the page instead of the container serving it. Language
is chosen per document at build time — the ?lang= -> cookie -> Accept-Language
negotiation cannot survive a static host — and the CTA is unconditional
because there is no session cookie to read across origins.

Phase: landing split (PR #17)"
```

---

### Task 2: prerender the legal pages

> **Tasks 2 and 3 must land together, as one dispatch with two commits.** The
> legal components live in `apps/frontend` and are consumed by the SPA's
> routes. Task 2 makes `apps/landing` render them and Task 3 deletes the SPA
> routes and moves the files — so stopping in between leaves either a
> cross-package import that Task 3 immediately rewrites, or a broken SPA. Do
> Task 2's steps, commit, then Task 3's, commit, and run the full suite once
> at the end of Task 3.
>
> **Because they land together, prefer moving over exporting.** Task 2's
> `exports`-field step below exists only to make the two tasks separable; since
> they are not, `git mv` the three legal files into `apps/landing/src/legal/`
> as part of this combined unit and import them relatively. That avoids adding
> an `exports` field to `apps/frontend` that Task 3 would remove one commit
> later. `LegalPage` (which needs hooks and the router) is dropped in the move;
> only the language bodies and the presentational helpers `H`, `List` and
> `ControllerCard` come across.

The legal prose must not be retyped: it is a statement about GDPR Article 9
data and the diff must prove the text is unchanged.

**Files:**
- Modify: `apps/frontend/src/screens/legal/privacy.tsx`, `terms.tsx` (export
  the language bodies)
- Create: `apps/landing/src/legal.tsx`
- Modify: `apps/landing/build.ts`

- [ ] **Step 1: Export the language bodies**

`PrivacyScreen` and `TermsScreen` wrap their content in `LegalPage`, which
uses `useState` and `useRouter` and therefore cannot be prerendered. The
language bodies below them are pure JSX. Confirm and export them:

```bash
grep -n 'function En\|function Nb\|export function' apps/frontend/src/screens/legal/privacy.tsx apps/frontend/src/screens/legal/terms.tsx
grep -n 'useState\|useRouter\|useEffect' apps/frontend/src/screens/legal/layout.tsx
```

The hooks should appear only inside `LegalPage`. `H`, `List` and
`ControllerCard` are presentational and safe to render.

Add `export` to each file's `En` and `Nb` functions. **Change nothing else in
these files** — every other line is legal text.

- [ ] **Step 2: Write `apps/landing/src/legal.tsx`**

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { En as PrivacyEn, Nb as PrivacyNb } from "@pjokk/frontend/legal/privacy";
import { En as TermsEn, Nb as TermsNb } from "@pjokk/frontend/legal/terms";
import type { LandingLang } from "./copy";

// The legal bodies are PRERENDERED from the SPA's own components rather than
// rewritten as templates. The prose is a legal statement about Article 9
// health data; re-typing it would put a transcription error between the
// policy and what we actually do. Rendering the same source guarantees the
// text is identical, and renderToStaticMarkup emits no React runtime, so the
// output is still a zero-JavaScript document.

const BODIES = {
  privacy: { en: PrivacyEn, nb: PrivacyNb },
  terms: { en: TermsEn, nb: TermsNb },
} as const;

export type LegalDoc = keyof typeof BODIES;

export function renderLegalBody(doc: LegalDoc, lang: LandingLang): string {
  const Body = BODIES[doc][lang];
  return renderToStaticMarkup(<Body />);
}
```

`apps/frontend` needs matching `exports` entries so these resolve. It has no
`exports` field today, and adding one is **restrictive** — once present, only
the declared entries are importable from that package. Verified that nothing
currently imports `@pjokk/frontend` by package name (the SPA imports its own
files relatively), so this is safe; re-check before adding, since that could
change:

```bash
grep -rn '@pjokk/frontend' apps/ packages/ scripts/ --include='*.ts' --include='*.tsx' --include='*.json' | grep -v 'apps/frontend/package.json'
```

Add to `apps/frontend/package.json`:

```json
  "exports": {
    "./legal/privacy": "./src/screens/legal/privacy.tsx",
    "./legal/terms": "./src/screens/legal/terms.tsx"
  },
```

and add `"@pjokk/frontend": "workspace:*"` plus `react` and `react-dom` usage
to `apps/landing`. Third-party deps stay in the root `package.json`; only the
workspace dependency is declared per package.

- [ ] **Step 3: Give the legal documents a shell**

They need the landing site's chrome and CSS. Add a `renderLegalPage` to
`apps/landing/src/page.ts` beside `renderLandingPage`, reusing the same
`<head>`, styles and footer, with the prerendered body injected. Read
`page.ts` first to match its existing structure rather than inventing a
second one.

The SPA's legal pages used Tailwind classes; the landing site has its own CSS
in `styles.ts`. Expect the prerendered markup to need a small block of styles
for `h2`, `ul`, `p` and the `ControllerCard`. Add them to `styles.ts` — do not
pull Tailwind into this package.

- [ ] **Step 4: Emit the four legal documents**

Extend `build.ts`'s loop to also write, per language:
`privacy/index.html` and `terms/index.html` for `en`, and
`nb/privacy/index.html` and `nb/terms/index.html` for `nb`.

- [ ] **Step 5: Verify the text survived**

This is the step that matters. Compare the rendered output against the source
prose:

```bash
bun run --filter @pjokk/landing build
# The policy's opening sentence must appear verbatim in the built document:
grep -c 'Pjokk is a baby tracker' apps/landing/dist/privacy/index.html
# And the Norwegian body must differ from the English one:
cmp -s apps/landing/dist/privacy/index.html apps/landing/dist/nb/privacy/index.html && echo "IDENTICAL - BUG" || echo "differ, as expected"
```

Expected: `1`, and `differ, as expected`. If the two languages render
identically, the language selection is not reaching the component.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(landing): prerender the legal pages from the SPA components

The privacy policy and terms are rendered with renderToStaticMarkup from the
same source the SPA used, not rewritten as templates: the prose is a legal
statement about Article 9 health data and a transcription error there would
put the policy out of step with what the service does. Output carries no
React runtime.

Phase: landing split (PR #17)"
```

---

### Task 3: the container stops serving public pages

**Files:**
- Delete: `apps/api/src/landing/` (only `index.ts` remains by now)
- Modify: `apps/api/src/app.ts`, `apps/api/src/deps.ts`, `apps/server/src/env.ts`,
  `apps/server/src/deps.ts`, `apps/server/src/main.ts`
- Delete: `apps/frontend/src/screens/legal/` and its routes
- Modify: `apps/api/test/landing.test.ts` (delete, or reduce to robots.txt)

- [ ] **Step 1: Drop the routes**

In `apps/api/src/app.ts`, remove the `/` handler and the `/sitemap.xml`
route, and make `robots.txt` unconditional:

```ts
// The app host is entirely behind auth and has nothing to index. The public
// site lives on the apex and owns its own robots.txt and sitemap.
app.get("/robots.txt", (c) => {
  c.header("Content-Type", "text/plain; charset=utf-8");
  return c.body("User-agent: *\nDisallow: /\n");
});
```

- [ ] **Step 2: Remove the now-dead config**

`openSignup` and `indexable` leave `Deps` — the landing page was their only
consumer. Confirm before deleting:

```bash
grep -rn 'deps\.openSignup\|deps\.indexable\|\.openSignup\|\.indexable' apps/api/src apps/server/src apps/api/test
```

Anything still referencing them must be dealt with first. Then remove the two
fields from `apps/api/src/deps.ts`, their assignments in
`apps/server/src/deps.ts`, and — **only if nothing else uses them** —
`INDEXABLE` from `apps/server/src/env.ts`. Note `main.ts` reads `INDEXABLE`
for the static-asset `X-Robots-Tag` header; that header should now be
unconditional too, so check that call site:

```bash
grep -n 'INDEXABLE\|X-Robots-Tag' apps/server/src/main.ts
```

`OPEN_SIGNUP` stays in `env.ts`: it is the landing build's flag now, and the
deploy still sets it.

- [ ] **Step 3: Add `SITE_URL`**

In `apps/server/src/env.ts`, beside `APP_URL`:

```ts
  /** The public site on the apex. The app links out to its legal pages, which
   *  live there now rather than behind auth. */
  SITE_URL: z.url().default("https://pjokk.no"),
```

- [ ] **Step 4: Delete the SPA's legal screens and routes**

```bash
grep -rn 'privacy\|terms' apps/frontend/src/router.tsx apps/frontend/src/screens/settings/index.tsx
```

Remove the two route definitions and their entries in the route tree, then
delete `apps/frontend/src/screens/legal/`. The two Settings rows become
external links to `https://pjokk.no/privacy` and `/terms` — read the
surrounding rows and match how they are built.

Note Task 2 exported `En`/`Nb` from these files and `apps/landing` imports
them. **Deleting the directory breaks that import.** Move the two files into
`apps/landing/src/legal/` instead of deleting them, and repoint
`apps/landing/src/legal.tsx`. `layout.tsx` moves too — the bodies use `H`,
`List` and `ControllerCard` from it — but `LegalPage` itself, which needs the
router, can be dropped in the move.

- [ ] **Step 5: Rework the landing test**

`apps/api/test/landing.test.ts` tests a route that no longer exists. Its
render assertions moved to `apps/landing/test/render.test.ts` in Task 1. What
survives here is the app host's `robots.txt`. Either reduce the file to that
one case or delete it and add the case to an existing app-level test file —
**say which you chose and why in your report**, and account for the change in
the test count.

- [ ] **Step 6: Verify and commit**

```bash
bun run test 2>&1 | tail -10
bun run check
bun run build
```

Report the new per-package counts explicitly; they will have changed and the
plan cannot predict the exact number, so state what they are and confirm each
delta is accounted for by a test that moved or a route that no longer exists.

```bash
git add -A
git commit -m "feat(server): the container stops serving the public site

/ and /sitemap.xml are gone and robots.txt is an unconditional Disallow: the
app host is entirely behind auth and has nothing to index. The legal screens
move to apps/landing, where they are prerendered, so they stay readable
without an account and without JavaScript.

APP_URL now names the app host; SITE_URL names the apex.

Phase: landing split (PR #17)"
```

---

### Task 4: robots, sitemap, OG image, and CI

**Files:**
- Modify: `apps/landing/build.ts`
- Move: `scripts/gen-og.mjs` → `apps/landing/scripts/gen-og.mjs`
- Copy: the shared static assets into the landing build
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Emit `robots.txt` and `sitemap.xml`**

Add to `build.ts`. The sitemap lists all six documents with hreflang
alternates between language pairs:

```ts
await write(
  "robots.txt",
  INDEXABLE
    ? `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
    : "User-agent: *\nDisallow: /\n",
);
```

For the sitemap, recover the version the container used to serve so the format
carries over. Do not use `HEAD~1` — by the time you run this, the route has
been gone for several commits. Find the last commit that still had it:

```bash
SITEMAP_REV=$(git log --format=%H -S'sitemap.xml' -1 -- apps/api/src/app.ts)
git show "$SITEMAP_REV:apps/api/src/app.ts" | grep -B2 -A20 'urlset'
```

It listed `/`, `/privacy` and `/terms` with `hreflang` alternates on the root.
The landing version lists all six documents.

- [ ] **Step 2: Move the OG generator and the shared assets**

**`gen-og.mjs` is already broken on `main` — this task fixes it.** It writes to
`new URL("../public/og.png", import.meta.url)`, which resolved to the repo-root
`public/` directory. PR #15 moved that directory to `apps/frontend/public/` and
nothing updated the script, so it now fails with `ENOENT`. Nothing caught it
because the script is not run by CI or by any gate. Verify for yourself before
and after:

```bash
node scripts/gen-og.mjs 2>&1 | tail -3   # fails today
mkdir -p apps/landing/scripts
git mv scripts/gen-og.mjs apps/landing/scripts/gen-og.mjs
```

Then repoint its output at the landing site's own asset directory
(`apps/landing/public/og.png`) and confirm it runs:

```bash
node apps/landing/scripts/gen-og.mjs && ls -l apps/landing/public/og.png
```

The landing site needs its own `og.png` and `icon.svg`; the SPA keeps its
copies, since the two are separate deploys. Decide whether to copy
`icon.svg` from `apps/frontend/public/` or regenerate it, and say which in
your report.

- [ ] **Step 3: Build the landing site in CI**

`apps/landing` is **not** copied into the container — it is a separate
artifact, but CI must still build it or a broken landing build reaches `main`
unnoticed.

The root `build` script is currently
`"bun run build:client && bun run build:server"`. Extend it rather than adding
a CI step, so that a local `bun run build` and CI agree:

```json
    "build": "bun run build:client && bun run build:server && bun run build:landing",
    "build:landing": "bun run --filter @pjokk/landing build",
```

CI's existing `Build` step then covers it with no workflow change. Verify that
is true rather than assuming:

```bash
grep -n 'run: bun run build' .github/workflows/ci.yml .github/workflows/release.yml
```

- [ ] **Step 4: Verify and commit**

```bash
bun run --filter @pjokk/landing build
ls -R apps/landing/dist | head -20
bun run test 2>&1 | tail -10
bun run check && bun run build
```

```bash
git add -A
git commit -m "feat(landing): robots, sitemap and the OG image

The apex owns its own indexability now. gen-og.mjs moves with the site it
serves. The landing build is a separate CI artifact and is deliberately not
copied into the container.

Phase: landing split (PR #17)"
```

---

# Piece 2 — the distroless image

The spike report at `.superpowers/sdd/2026-08-28-composition-root/compile-spike.md`
verified all of this end to end. **Read its Q4 and the follow-up section
before starting** — they contain the exact working dispatcher shape and the
measured layer breakdown.

Measured reality, so nobody expects a size win: the current image is **~118 MB
real uncompressed / 47.1 MB compressed**, and the distroless single-binary
version is **~113 MB / 46.8 MB**. `docker images` on the dev host reports both
~47 MB higher because its containerd-snapshotter backend double-books the
unpacked snapshot plus the compressed blob. **The reason to do this is the
absence of a shell, a package manager and `node_modules` in the runtime
image — not size.**

### Task 5: one dispatcher binary

**Files:**
- Create: `apps/server/src/dispatch.ts`
- Modify: `apps/server/src/main.ts`, `cron-cli.ts`, `migrate.ts`
- Modify: root `package.json` (`build:server`)

- [ ] **Step 1: Refactor each entrypoint into an exported function**

Each of the three currently runs its work at module top level. Wrap each body
in an exported async function, leaving the logic identical:
`main.ts` → `export async function runServer()`,
`migrate.ts` → `export async function runMigrate()`,
`cron-cli.ts` → `export async function runCron(job: string)`.

Keep every `process.exit` call exactly where it is — `migrate.ts`'s exits and
its `db.$client.end()` on both paths are load-bearing, and `cron-cli.ts`'s
exit codes are what a Kubernetes CronJob reads.

- [ ] **Step 2: Write the dispatcher with STATIC imports**

```ts
import { runCron } from "./cron-cli";
import { runMigrate } from "./migrate";
import { runServer } from "./main";

// One binary, four modes. The imports are STATIC on purpose: selecting a
// branch with `await import()` makes Bun's bundler split it into a lazily
// initialised chunk, which breaks module-initialisation ordering inside a
// compiled binary and crashes with "tsyringe requires a reflect polyfill" —
// tsyringe arrives via better-auth's passkey support through
// @peculiar/x509, and its decorators need reflect-metadata to have run
// first. Verified during the spike; do not "optimise" this into a dynamic
// import.

const mode = process.argv[2];

if (mode === "cron") {
  await runCron(process.argv[3] ?? "");
} else if (mode === "migrate") {
  await runMigrate();
} else if (mode === "healthcheck") {
  // distroless has no shell, so Docker's HEALTHCHECK runs this instead of
  // the old `bun -e "fetch(...)"` one-liner.
  const port = process.env.PORT ?? "3000";
  const res = await fetch(`http://127.0.0.1:${port}/healthz`).catch(
    () => null,
  );
  process.exit(res?.ok ? 0 : 1);
} else {
  await runServer();
}
```

- [ ] **Step 3: Replace `build:server`**

In the root `package.json`:

```json
    "build:server": "bun build apps/server/src/dispatch.ts --compile --sourcemap=linked --outfile dist/compiled/dispatch"
```

- [ ] **Step 4: Verify the binary works in all four modes**

```bash
bun run build:server
ls -l dist/compiled/dispatch
./dist/compiled/dispatch migrate 2>&1 | tail -3
```

Expected: a binary around 87 MB, and `migrate` reaching the database (an
"already exists" error is fine — it proves the code path runs and the
migrations were found).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(server): one dispatcher binary instead of three entrypoints

Each entrypoint becomes an exported function and dispatch.ts selects one by
argv. Static imports, deliberately: dynamic-import dispatch breaks module
init ordering in a compiled binary and crashes on tsyringe's reflect-metadata
requirement, which arrives via better-auth's passkey support.

Phase: distroless (PR #18)"
```

---

### Task 6: the distroless image

**Files:**
- Modify: `Dockerfile`, `docker-compose.yml`, `.github/workflows/*.yml`
- Modify: `CLAUDE.md`, `DECISIONS.md`

- [ ] **Step 1: Rewrite the runtime stage**

The binary must be compiled inside a **Debian**-based Bun image
(`oven/bun:1.4`, not `-alpine`) to link against glibc for distroless. The
deps stage keeps its four workspace-manifest COPY lines.

```dockerfile
FROM gcr.io/distroless/base-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/dist/compiled/dispatch ./dispatch
COPY --from=build /app/dist/compiled/dispatch.js.map ./dispatch.js.map
COPY --from=build /app/dist/client ./dist/client
COPY apps/api/migrations ./migrations

EXPOSE 3000

# distroless has no shell, so this is the dispatcher's own subcommand rather
# than the old `bun -e "fetch(...)"` one-liner.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/app/dispatch", "healthcheck"]

ENTRYPOINT ["/app/dispatch"]
```

`:nonroot` already runs as uid 65532, so there is no `USER` line and no
`adduser` — the base image provides it.

- [ ] **Step 2: Update every command that invoked the old entrypoints**

The three commands change shape. Find every caller:

```bash
grep -rn 'main\.js\|cron-cli\.js\|migrate\.js' . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
```

`bun main.js` → the default `ENTRYPOINT`; `bun cron-cli.js <job>` →
`["/app/dispatch", "cron", "<job>"]`; `bun migrate.js` →
`["/app/dispatch", "migrate"]`. Expect hits in `docker-compose.yml`, both CI
workflows, and the docs.

- [ ] **Step 3: Build and run it**

```bash
docker build -t pjokk:distroless .
docker run --rm -d --name pjokk-dl -p 3997:3000 \
  -e DATABASE_URL=postgres://pjokk:pjokk@host.docker.internal:55432/pjokk_test \
  -e APP_URL=http://localhost:3997 \
  -e BETTER_AUTH_SECRET=test-secret-please-ignore \
  -e S3_BUCKET=t -e S3_ENDPOINT=http://127.0.0.1:1 \
  -e S3_ACCESS_KEY_ID=t -e S3_SECRET_ACCESS_KEY=t \
  --add-host=host.docker.internal:host-gateway \
  pjokk:distroless
sleep 4
curl -fsS localhost:3997/healthz && echo " healthz OK"
curl -fsS -o /dev/null -w '%{http_code}\n' localhost:3997/
docker exec pjokk-dl /app/dispatch healthcheck; echo "healthcheck exit=$?"
docker inspect --format '{{.State.Health.Status}}' pjokk-dl
docker logs pjokk-dl | tail -5
docker rm -f pjokk-dl
```

Expected: `{"ok":true} healthz OK`; `/` returns **404** now (the landing page
has left the container — a 200 with HTML would mean Task 3 did not land);
`healthcheck exit=0`; health status `healthy`; no tsyringe error in the logs.

- [ ] **Step 4: Update the docs**

`CLAUDE.md` describes three entrypoints and the Alpine image; `DECISIONS.md`
needs an entry recording: distroless was chosen for attack surface and not
size (with the measured numbers), the dispatcher must use static imports and
why, and that `docker images` on a containerd-snapshotter host double-counts.
Also fix `apps/server/src/deps.ts`'s docstring, which says `createDeps` is
"the ONLY place in the codebase that constructs one" — `migrate.ts` also
calls `createDb`.

- [ ] **Step 5: Verify everything and commit**

```bash
rm -rf node_modules && bun install --frozen-lockfile
bun run check && bun run test 2>&1 | tail -10 && bun run build
```

```bash
git add -A
git commit -m "feat(docker): single binary on distroless:nonroot

The runtime image has no shell, no package manager and no node_modules. Size
is not the reason — measured 113 MB against the previous 118 MB — attack
surface is. HEALTHCHECK becomes a dispatcher subcommand because there is no
shell to run the old one-liner.

Phase: distroless (PR #18)"
```

---

## Notes for the reviewer

- The legal prose must be byte-identical to what shipped before. The diff
  should show `export` added to four functions and nothing else in those
  files — any changed prose line is a finding.
- `apps/api` must still read no environment and construct nothing.
- The container must now return 404 for `/`. A 200 means the landing route
  survived.
- Every reference to `main.js` / `cron-cli.js` / `migrate.js` must be gone,
  including in `docker-compose.yml` and both CI workflows — a stale one there
  fails only at deploy time.
