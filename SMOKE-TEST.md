# Smoke test

Live URL: **https://pjokk.no** — `/` is the public landing page, `/home` is
the app. Test environment: **https://test.pjokk.no**.

Both are the **same container image**, differing only in environment
variables. `INDEXABLE`, `robots.txt`, `sitemap.xml` and the noindex headers
are runtime switches now, so an image verified on test is the image that goes
to production — no rebuild, no per-environment bundle.

## 0. One-time setup

Configuration is environment variables (see `.env.example`); there are no
`wrangler secret put` steps any more. Set them wherever the container runs —
compose `.env`, a Kubernetes Secret, your platform's config UI.

Required before anything works:

```
DATABASE_URL          postgres://…            (EU region — see below)
APP_URL               https://pjokk.no
BETTER_AUTH_SECRET    openssl rand -base64 32
S3_*                  bucket, endpoint, key, secret (EU region)
```

For Google sign-in, create an OAuth 2.0 Web client with redirect URI
`https://pjokk.no/api/auth/callback/google` (and the `test.` equivalent), then
set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. Without them the app still
runs — it logs `disabled: Google sign-in` at startup and offers only
email/password.

> **Data residency.** The database, the bucket AND the backup target must be
> in the EU. Cloudflare used to enforce this with jurisdiction pinning; now
> nothing does. The nightly snapshot contains every table, health data
> included, so a bucket in the wrong region undoes the whole arrangement.

Apply migrations as a one-off **before** the app serves traffic:

```sh
bun src/server/migrate.ts        # or the compose `migrate` service
```

## 1. Founder account (bootstrap)

1. Set `OPEN_SIGNUP=1` and restart the app.
2. Open https://pjokk.no → Continue with Google (as yourself).
3. You land on **Welcome**: create the family, then add the baby (name +
   birth date) → you land on Home.
4. Set `OPEN_SIGNUP=0` and restart. Signup is closed again.
5. Promote yourself to sysadmin, then `/admin` is available:

   ```sh
   psql "$DATABASE_URL" -c "UPDATE \"user\" SET role='admin' WHERE email='<you>'"
   ```

   `"user"` must be quoted — it is a reserved word in Postgres.

## 2. Invite → second caretaker joins

6. Settings → **New invite link** → QR + code appear.
7. On a second device/browser (or incognito): scan the QR (or open the link).
   The join page shows "Join <family> as member".
8. Continue with Google (second account) → **Join family** → lands on Home
   showing the same baby. (This works with signup closed — the invite flow is
   the only signup door.)
9. Back on device 1: Settings shows both caretakers; the invite's used count
   ticked up. Revoke the invite; opening the link now says not valid.

## 3. Logging (both accounts)

10. Device 1: tap **Feed** → sheet opens prefilled → Save (two taps). Home's
    "Last feed" flips to "just now" with the amount.
11. Device 2: tap **Diaper** → pick type → Save. Device 1's home updates on
    next refetch (≤60 s or pull to refresh by reopening).
12. Tap **Sleep** → Start sleep. The purple banner appears with a live counter
    and Wake. Tap **Wake** — banner clears, "Last sleep" shows.
13. Retroactive path: Feed → "15 m ago" chip → Save; check the timestamp.

## 4. Attribution

14. In dev (`bun run dev` + `bun run seed`, sign in as anders@pjokk.local /
    pjokk-dev): `/api/feeds` rows carry `caretakerName` alternating
    Anders/Kristine. Live: log one entry from each account and GET
    `/api/summary?babyId=…` — `caretakerName` matches whoever logged it.

## 5. Push notifications

15. Settings → Notifications → **Enable notifications** (on iPhone: install to
    Home Screen first, then enable from the installed app).
16. **Send test notification** → a "Push works on this device ✅" banner
    arrives; tapping it opens the app.
17. Set "Remind me when no feed for" to 3 h. If the family's last feed is
    older than 3 h, a reminder arrives within 15 min. Logging a feed resets
    the gap; you get at most one nudge per gap.

    Reminders need the scheduler to be running — either `SCHEDULER=1` on a
    single container, or a CronJob invoking `bun run cron frequent`. If
    nothing runs it, no reminder ever fires and the app looks broken in a way
    the logs will not explain.
18. Backups: after the nightly job, `backups/YYYY-MM-DD.json` appears in the
    bucket. Force one to check the wiring without waiting:

    ```sh
    bun run cron nightly
    ```

## 6. PWA + polish

19. Add to Home Screen on iOS/Android → standalone app with the Pjokk icon.
20. Airplane mode → app still renders last-known home state; log a feed →
    "Saved offline — will sync" → disable airplane mode → it syncs.
21. Settings → Night mode → On: near-black warm screen, three big actions in
    the bottom half.
22. `/api/docs` serves the Scalar API reference (signed-in only).

## 7. Health and rollout checks

23. `/healthz` returns 200 without touching the database; `/readyz` returns
    `{"ok":true}` and 503 when Postgres is unreachable. Wire `/readyz` to the
    readiness probe and `/healthz` to liveness — the other way round turns a
    slow query into a restart loop.
24. Rolling deploy: the app drains on SIGTERM, so requests in flight finish.
25. **Behind a reverse proxy, set `TRUSTED_PROXY_HOPS`** to the number of
    proxies in front. Left at 0, the rate limiter cannot tell clients apart
    and every caller shares one bucket — the brute-force brake on sign-in and
    invite redeem degrades to a shared-fate 429. Verify by signing in wrongly
    21 times from one IP and confirming a second IP is unaffected.
26. **Under Kubernetes, `SCHEDULER` must be 0** and the two jobs driven by
    CronJobs (`bun run cron nightly` at 03:15 UTC, `bun run cron frequent`
    every 15 min). With N replicas the in-process scheduler fires every
    reminder N times.

## 8. Stripe billing

Run the test-mode pass on the **test environment** first; production only
ever holds live keys.

27. Set all five `STRIPE_*` values (live mode in production): secret key,
    webhook secret, and the three price ids (`STRIPE_PRICE_PREMIUM_MONTHLY` /
    `_YEARLY` / `_LIFETIME`). With them absent the app logs
    `disabled: billing` and the billing routes are not registered at all.
28. In the Stripe dashboard: add a webhook endpoint
    `https://pjokk.no/api/auth/stripe/webhook` subscribed to
    `checkout.session.completed`, `customer.subscription.created`,
    `customer.subscription.updated`, `customer.subscription.deleted`; copy
    the signing secret into `STRIPE_WEBHOOK_SECRET`.
29. Verify all three prices are NOK and tax behaviour is **inclusive**;
    confirm Stripe Tax is enabled on the account.
30. Test-mode end-to-end pass:
    - Subscribe monthly with card `4242 4242 4242 4242` → plan flips to
      `premium`; open the Customer Portal from Settings → Billing → cancel →
      verify the downgrade lands at period end (not immediately).
    - Buy lifetime → plan flips to `lifetime`.
    - In `/admin`, comp a family (plan → `comp`) then revoke it (plan →
      `free`) → verify the audit trail records `billing.plan.set` both ways.

## 9. Landing page checks

31. `https://pjokk.no/` shows the landing page with **Sign in**; after signing
    in, reloading `/` shows **Open app** linking to `/home`.
32. A Norwegian device (or `curl -H "Accept-Language: nb-NO"`) gets Norwegian;
    the header toggle flips it and the choice survives a reload.
33. Indexability, driven entirely by `INDEXABLE`:

    ```sh
    curl -s  https://pjokk.no/robots.txt          # Allow: / + Sitemap
    curl -sI https://pjokk.no/ | grep -i x-robots # nothing
    curl -s  https://test.pjokk.no/robots.txt     # Disallow: /
    curl -sI https://test.pjokk.no/ | grep -i x-robots        # noindex
    curl -sI https://test.pjokk.no/privacy | grep -i x-robots # noindex
    ```

    Production must report neither header; test must report both. (The old
    caveat about Cloudflare's Managed robots.txt prepending its own `Allow: /`
    no longer applies — nothing rewrites the response now.)
34. With the PWA installed, opening `https://pjokk.no/` in the browser still
    shows the landing page rather than the cached app shell, and a push
    notification opens `/home`.
35. Paste `https://pjokk.no` into a chat (Messenger, Slack, iMessage) — the
    preview shows the title, the description and the brand card. Regenerate
    that card with `node scripts/gen-og.mjs` if the icon ever changes.

## 10. Moving off Cloudflare (one-time)

The container starts from an **empty database** — no data is carried over from
D1. Everyone signs in again, and any invite link already handed out stops
working, because those embed `APP_URL` and the family they point at no longer
exists. Invites expire after 72 h; run this when none is live.

36. Stand the stack up on the new host and verify with sections 1–7 against
    `test.pjokk.no` before touching production DNS.
37. Point `pjokk.no` and `test.pjokk.no` at the new host. Terminate TLS at
    your proxy/ingress; the app speaks plain HTTP on `PORT` and does not
    manage certificates.
38. `www.pjokk.no` → `https://pjokk.no` (301, preserve query string) has to be
    handled by whatever sits in front — the app does not serve `www`.
39. Google Cloud Console → the OAuth client → confirm the redirect URIs still
    match the hostnames. They are unchanged if the domains are.
40. Stripe → confirm the webhook endpoints still resolve. The signing secret
    changes if you create a new endpoint rather than editing the existing one.
41. Re-bootstrap the founder account (section 1) and re-issue invites.
42. Sign in again on every device. An installed PWA keeps working as long as
    the hostname is unchanged.

## Verified automatically

- **200 tests across 25 files** (`bun test`), run against a real Postgres:
  landing page (language negotiation, CTA state, CSP, indexability), tenancy
  isolation (cross-family reads/writes impossible, stale session claims
  re-verified), invite lifecycle (transactional redeem with `SELECT … FOR
  UPDATE`, expiry/revoke/exhaustion, rate limiting), active-sleep state
  machine (single active session enforced by a partial unique index,
  idempotent wake), summary shape, billing gates, admin console.
- **Image smoke test in CI**: migrations apply from the image, the container
  boots, `/readyz` reaches Postgres, `/` serves the landing page rather than
  the SPA shell, and `robots.txt` respects `INDEXABLE`.
