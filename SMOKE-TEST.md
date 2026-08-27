# Smoke test — Phase 1

Live URL: **https://pjokk.no** — `/` is the public landing page, `/home` is
the app. Test environment: **https://test.pjokk.no**. There is no workers.dev
fallback: it is switched off so exactly one origin can complete a sign-in.

## 0. One-time setup (before Google sign-in works)

Google OAuth secrets are placeholders. In Google Cloud Console create an
OAuth 2.0 Web client with redirect URI:

```
https://pjokk.no/api/auth/callback/google
```

Then:

```sh
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

## 1. Founder account (bootstrap)

1. Set `OPEN_SIGNUP` to `"1"` in wrangler.jsonc → `pnpm deploy`.
2. Open https://pjokk.no on your phone → Continue with Google (as
   yourself).
3. You land on **Welcome**: create family "Refsdal", then add the baby
   (name + birth date) → you land on Home.
4. Set `OPEN_SIGNUP` back to `"0"` → `pnpm deploy`. Signup is closed again.

## 2. Invite → second caretaker joins

5. Settings → **New invite link** → QR + code appear.
6. On a second device/browser (or incognito): scan the QR (or open the
   link). The join page shows "Join Refsdal as member".
7. Continue with Google (second account, e.g. Kristine's) → **Join family**
   → lands on Home showing the same baby. (This works with signup closed —
   the invite flow is the only signup door.)
8. Back on device 1: Settings shows both caretakers; the invite's used
   count ticked up. Revoke the invite; opening the link now says not valid.

## 3. Logging (both accounts)

9. Device 1: tap **Feed** → sheet opens prefilled → Save (two taps).
   Home's "Last feed" flips to "just now" with the amount.
10. Device 2: tap **Diaper** → pick type → Save. Device 1's home updates on
    next refetch (≤60 s or pull to refresh by reopening).
11. Tap **Sleep** → Start sleep. The purple banner appears with a live
    counter and Wake. Tap **Wake** — banner clears, "Last sleep" shows.
12. Retroactive path: Feed → "15 m ago" chip → Save; check the timestamp.

## 4. Attribution

13. In dev (`pnpm dev` + `pnpm seed:local`, sign in as
    anders@pjokk.local / pjokk-dev): `/api/feeds` rows carry
    `caretakerName` alternating Anders/Kristine. Live: log one entry from
    each account and GET `/api/summary?babyId=…` — `caretakerName` matches
    whoever logged it. (Timeline UI renders this in Phase 2.)

## 4b. Push notifications (phase 5)

18. Settings → Notifications → **Enable notifications** (on iPhone: install
    to Home Screen first, then enable from the installed app).
19. **Send test notification** → a "Push works on this device ✅" banner
    arrives, tapping it opens the app.
20. Set "Remind me when no feed for" to 3 h. If the family's last feed is
    older than 3 h, a reminder arrives within 15 min (cron). Logging a feed
    resets the gap; you get at most one nudge per gap.
21. Backups: after 03:15 UTC, `backups/YYYY-MM-DD.json` appears in the
    pjokk-files-eu R2 bucket.

## 5. PWA + polish

14. Add to Home Screen on iOS/Android → standalone app with the Pjokk icon.
15. Airplane mode → app still renders last-known home state; log a feed →
    "Saved offline — will sync" → disable airplane mode → it syncs.
16. Settings → Night mode → On: near-black warm screen, three big actions
    in the bottom half.
17. `/api/docs` serves the Scalar API reference.

## 6. Go-live checklist — Stripe billing (Phase 9)

The test-mode pass (item 25) runs on the **test environment**
(`test.pjokk.no`, worker `pjokk-test`, isolated D1/KV/R2) — see
section 7. Production only ever holds live keys.

22. `wrangler secret put` all five `STRIPE_*` values (live mode, NO
    `--env` flag → production): secret key, webhook secret, and the three
    price ids (`STRIPE_PRICE_PREMIUM_MONTHLY` / `_YEARLY` / `_LIFETIME`).
23. In the Stripe dashboard (live mode): add a webhook endpoint
    `https://pjokk.no/api/auth/stripe/webhook` subscribed to
    `checkout.session.completed`, `customer.subscription.created`,
    `customer.subscription.updated`, `customer.subscription.deleted`; copy
    the signing secret into `STRIPE_WEBHOOK_SECRET`.
24. Verify all three prices are NOK and tax behavior is **inclusive**;
    confirm Stripe Tax is enabled on the account.
25. Test-mode end-to-end pass on `test.pjokk.no` first (before flipping
    live keys into production):
    - Subscribe monthly with card `4242 4242 4242 4242` → plan flips to
      `premium`; open the Customer Portal from Settings → Billing → cancel →
      verify the downgrade lands at period end (not immediately).
    - Buy lifetime → plan flips to `lifetime`.
    - In `/admin`, comp a family (plan → `comp`) then revoke it (plan →
      `free`) → verify the audit trail records `billing.plan.set` both ways.

## 7. Test environment (test.pjokk.no) — one-time setup

Infrastructure already provisioned (D1 `pjokk-test-eu`, KV, R2
`pjokk-test-files-eu`, custom domain, crons, `BETTER_AUTH_SECRET` + fresh
VAPID pair). CI auto-deploys it on every green push to main once the
GitHub secret exists. Remaining manual steps:

26. GitHub repo → Settings → Secrets and variables → Actions: add
    `CLOUDFLARE_API_TOKEN` (Cloudflare dashboard → My Profile → API Tokens
    → Create Token → "Edit Cloudflare Workers" template, plus D1:Edit;
    scope to the Refsdal Holding AS account). Until it exists the
    `deploy-test` CI job skips gracefully.
27. Google Cloud Console → the Pjokk OAuth client → add authorized
    redirect URI `https://test.pjokk.no/api/auth/callback/google`,
    then replace the placeholder test-env secrets:
    `wrangler secret put GOOGLE_CLIENT_ID --env test` (and
    `GOOGLE_CLIENT_SECRET`).
28. Stripe dashboard → **test mode**: create/copy the three Premium prices
    (NOK, inclusive tax), add a webhook endpoint
    `https://test.pjokk.no/api/auth/stripe/webhook` (same four events
    as item 23), then replace the placeholders:
    `wrangler secret put STRIPE_SECRET_KEY --env test` (`sk_test_…`),
    `STRIPE_WEBHOOK_SECRET`, and the three `STRIPE_PRICE_PREMIUM_*` ids.
29. Bootstrap the founder account: temporarily set `OPEN_SIGNUP` to "1"
    for the test env (Cloudflare dashboard → pjokk-test → Settings →
    Variables, or edit wrangler.jsonc env.test and redeploy), sign in with
    Google at `https://test.pjokk.no`, then set it back to "0".
    Promote yourself to sysadmin by setting `role = 'admin'` on your user
    row: `wrangler d1 execute pjokk-test-eu --env test --remote --command
    "UPDATE user SET role='admin' WHERE email='<you>'"` — then create a
    family from `/admin`.
30. Manual deploys remain available: `pnpm deploy:test` (test) and
    `pnpm deploy` (production). Migrations: `pnpm db:migrate:test`.

## 8. Apex cutover — pjokk.no / test.pjokk.no (one-time, ordered)

Moving off `app.pjokk.no` signs **everyone** out once (the session cookie is
bound to the host) and breaks any invite link or QR code already handed out,
because those embed `APP_URL`. Invites expire after 72 h, so run this when no
invite is live, and warn anyone holding one.

31. Deploy the test environment first (`pnpm deploy:test`) and add the
    `test.pjokk.no` custom domain. Confirm `/` renders the landing page and
    `/home` the app, then do the same for production.
32. Cloudflare dashboard → Workers → **delete the `app.pjokk.no` custom
    domain** (worker `pjokk`) and **`app-test.pjokk.no`** (worker
    `pjokk-test`). Removing the route from `wrangler.jsonc` is not enough on
    its own — the DNS record and certificate stay attached until deleted here.
33. Cloudflare dashboard → the pjokk.no zone → Rules → **Redirect Rules**: add
    `www.pjokk.no/*` → `https://pjokk.no/$1`, 301, preserve query string. The
    Worker cannot do this: `run_worker_first` only routes `/api/*` and `/`.
34. Google Cloud Console → the Pjokk OAuth client → add
    `https://pjokk.no/api/auth/callback/google` and
    `https://test.pjokk.no/api/auth/callback/google`; remove both `app.`
    URIs once sign-in is confirmed working on the new hosts.
35. Stripe → repoint the webhook endpoints (live mode → `https://pjokk.no/…`,
    test mode → `https://test.pjokk.no/…`). The signing secret changes if you
    create a new endpoint rather than editing the existing one — re-run
    `wrangler secret put STRIPE_WEBHOOK_SECRET` if so.
36. Sign in again on every device, and re-install the PWA: an app installed
    from `app.pjokk.no` still points there and will simply stop resolving.

### Landing page checks

37. `https://pjokk.no/` shows the landing page with **Sign in**; after signing
    in, reloading `/` shows **Open app** linking to `/home`.
38. A Norwegian device (or `curl -H "Accept-Language: nb-NO"`) gets Norwegian;
    the header toggle flips it and the choice survives a reload.
39. `https://pjokk.no/robots.txt` allows crawling and `/sitemap.xml` resolves.
    On test, check the HEADER rather than robots.txt — Cloudflare's Managed
    robots.txt prepends its own `Allow: /` group, which wins over ours:

    ```sh
    curl -sI https://test.pjokk.no/         | grep -i x-robots-tag  # Worker
    curl -sI https://test.pjokk.no/privacy  | grep -i x-robots-tag  # assets
    ```

    Both must report `noindex, nofollow`, and production must report neither.
40. With the PWA installed, opening `https://pjokk.no/` in the browser still
    shows the landing page rather than the cached app shell, and a push
    notification opens `/home`.
41. Paste `https://pjokk.no` into a chat (Messenger, Slack, iMessage) — the
    preview shows the title, the description and the brand card. Regenerate
    that card with `node scripts/gen-og.mjs` if the icon ever changes.

## Verified automatically (already done)

- 185 workers-runtime tests across 24 files: the landing page (language
  negotiation, CTA state, CSP, indexability), tenancy isolation
  (cross-family reads/writes impossible, stale session claims re-verified),
  invite lifecycle (atomic batch redeem, expiry/revoke/exhaustion, rate
  limiting), active-sleep state machine (single active session, idempotent
  wake), summary shape.
- Live checks: SPA 200, /api/docs 200, manifest + service worker 200, SPA
  fallback on /join/CODE, auth gates on domain routes and redeem, public
  invite-info endpoint.
