# Landing page + apex domain — design

Date: 2026-08-27

## Goal

Give pjokk.no a public front door, and move the app onto the apex.

Today `app.pjokk.no/` is the signed-in Home screen and a stranger who types
`pjokk.no` gets nothing. After this change:

- `pjokk.no/` is a marketing page anyone can read, signed in or not.
- `pjokk.no/home` is the Home screen (everything else keeps its path).
- `test.pjokk.no` is the test environment.
- `app.pjokk.no` and `app-test.pjokk.no` are gone.

Inspiration: whenweall.com — one short scrolling page, conversational copy, a
demonstration of the product rather than a description of it.

## Decisions

### The landing page is rendered by the Worker, not the SPA

`/` is served as a self-contained HTML document built in the Worker: inline
CSS, no JavaScript, no React, no app bundle. A stranger downloads one small
document and sees the page immediately.

This is only possible because the demo is **conceptual** — a CSS-animated
impression of the UI, not the real components (the same choice whenweall
makes: their hero poll is a mockup, not a live poll). Reusing the real
`StatusCard`/`LogButton` components would have forced the page into the SPA
and made a stranger download the whole app to read marketing copy.

The cost is a second, small stylesheet that duplicates the app's colour
tokens. It is a deliberate, bounded duplication: the tokens are copied from
`src/web/styles.css` and are unlikely to churn.

### `run_worker_first` must include `/`

`wrangler.jsonc` sets `run_worker_first: ["/api/*"]`, which means non-API
requests are served straight from the asset store and **the Worker never sees
them**. Serving `/` from the Worker requires adding `"/"` to that list. This
also rules out doing anything hostname-conditional for HTML in Worker code
(noindex, redirects) for paths the Worker does not own — those stay
build-time or zone-level.

### Language is chosen server-side

`?lang=` (explicit click) → `pjokk_lang` cookie (remembered choice) →
`Accept-Language` (device default) → English. Resolved before the HTML is
built, so a Norwegian visitor never sees English text flash and repaint. The
app's own `t()` dictionary is not involved: marketing prose belongs in whole
per-language blocks, the way the legal pages already do it, not in a
short-string dictionary that CI diffs.

### The CTA is derived from state the Worker already has

- Session cookie present → **Open app** → `/home`.
- Otherwise `OPEN_SIGNUP === "1"` → **Get started** → `/login`.
- Otherwise → **Sign in** → `/login`, with an "invited to a family?" line.

The cookie is only sniffed for presence, never validated — a stale cookie
costs one redirect through `/login` and saves a D1 query on every page view.
No `/api/config` endpoint and no client-side swap is needed, and opening
signup later is a single env var, not a code change.

**No waitlist.** Email capture was considered and dropped: it would mean a new
personal-data store, a public write endpoint, an admin surface, and a privacy
policy section, for an alpha that is not accepting sign-ups anyway.

### No `/` route in the SPA

The SPA route tree has no `/` any more. Links from inside the app back to the
landing page must be plain `<a href="/">` full navigations, not `<Link>`.

The service worker needs `/^\/$/` in `navigateFallbackDenylist`, or a
registered SW would answer `/` from the precached app shell and the landing
page would never be seen again after a first visit.

## Page structure

Header (wordmark · language toggle · CTA) → hero (headline, subhead, CTA, the
"free to start" line) → phone frame with the animated conceptual demo → three
short "what it does" points → an EU-privacy trust line → footer (Privacy ·
Terms · Refsdal Holding AS · contact).

The demo animates a status card and a logging interaction on a loop, honouring
`prefers-reduced-motion`.

## Routing changes

| Before | After |
|---|---|
| `/` → `HomeScreen` in `AppShell` | `/` → Worker landing page |
| — | `/home` → `HomeScreen` in `AppShell` |

Call sites to update: `TabBar.tsx`, `Join.tsx`, `Welcome.tsx`, `Vaccines.tsx`,
`admin/shell.tsx`, `admin/Users.tsx`, `Login.tsx` (default `redirectTo`),
`legal/layout.tsx` (to a plain anchor), `public/push-sw.js` (a notification
must open the app, not the marketing page), and the PWA `start_url`.

## Domain cutover

`APP_URL` and `routes` move to `pjokk.no` / `test.pjokk.no`. Production
`workers_dev` is turned off — with a canonical apex, a second origin serving
auth is a liability, not a fallback — and `trustedOrigins` drops to just
`APP_URL`.

Manual steps, which the code change alone does not accomplish:

1. Delete the `app.pjokk.no` and `app-test.pjokk.no` **custom domains** in
   Cloudflare. Removing the route from `wrangler.jsonc` leaves the DNS record
   and certificate attached.
2. Google OAuth: add the two new callback URLs, remove the old ones.
3. Stripe: repoint both webhook endpoints.
4. `www.pjokk.no` → 301 to the apex, as a zone-level Redirect Rule.

Two consequences, accepted:

- Every existing session signs out once, because the cookie host changes.
- Outstanding invite links and QR codes (which embed `APP_URL`) break. Invites
  expire after 72 h, so the cutover should follow any live invite.

## SEO

The landing document carries its own `<title>`, description and OpenGraph
tags. A Vite plugin keyed on `CLOUDFLARE_ENV` emits an allow-all `robots.txt`
for production and a disallow-all one for test, and the Worker adds
`X-Robots-Tag: noindex` to the landing response on any non-production host, so
the test environment cannot be indexed even if `robots.txt` is ignored.

## Testing

`test/landing.test.ts` covers what the Worker now owns: `/` returns HTML,
language negotiation (`Accept-Language`, `?lang=`, cookie precedence), the CTA
varying on session cookie and `OPEN_SIGNUP`, and the noindex header on
non-production hosts. Existing suites are unaffected — the SPA path change
touches no Worker route. The domain cutover is a `SMOKE-TEST.md` checklist,
not something a test can assert.
