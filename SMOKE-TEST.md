# Smoke test — Phase 1

Live URL: **https://app.pjokk.no**
(fallback: https://pjokk.refsdal-holding-as.workers.dev — same Worker;
pjokk.no apex is reserved for a separate landing page)

## 0. One-time setup (before Google sign-in works)

Google OAuth secrets are placeholders. In Google Cloud Console create an
OAuth 2.0 Web client with redirect URI:

```
https://app.pjokk.no/api/auth/callback/google
```

Then:

```sh
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

## 1. Founder account (bootstrap)

1. Set `OPEN_SIGNUP` to `"1"` in wrangler.jsonc → `pnpm deploy`.
2. Open https://app.pjokk.no on your phone → Continue with Google (as
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
    pjokk-files R2 bucket.

## 5. PWA + polish

14. Add to Home Screen on iOS/Android → standalone app with the Pjokk icon.
15. Airplane mode → app still renders last-known home state; log a feed →
    "Saved offline — will sync" → disable airplane mode → it syncs.
16. Settings → Night mode → On: near-black warm screen, three big actions
    in the bottom half.
17. `/api/docs` serves the Scalar API reference.

## 6. Go-live checklist — Stripe billing (Phase 9)

22. `wrangler secret put` all five `STRIPE_*` values (live mode): secret key,
    webhook secret, and the three price ids (premium monthly, premium
    yearly, lifetime).
23. In the Stripe dashboard: add a webhook endpoint
    `https://app.pjokk.no/api/auth/stripe/webhook` subscribed to
    `checkout.session.completed`, `customer.subscription.created`,
    `customer.subscription.updated`, `customer.subscription.deleted`; copy
    the signing secret into `STRIPE_WEBHOOK_SECRET`.
24. Verify all three prices are NOK and tax behavior is **inclusive**;
    confirm Stripe Tax is enabled on the account.
25. Test-mode end-to-end pass first (before flipping to live keys):
    - Subscribe monthly with card `4242 4242 4242 4242` → plan flips to
      `premium`; open the Customer Portal from Settings → Billing → cancel →
      verify the downgrade lands at period end (not immediately).
    - Buy lifetime → plan flips to `lifetime`.
    - In `/admin`, comp a family (plan → `comp`) then revoke it (plan →
      `free`) → verify the audit trail records `billing.plan.set` both ways.

## Verified automatically (already done)

- 16 workers-runtime tests: tenancy isolation (cross-family reads/writes
  impossible, stale session claims re-verified), invite lifecycle (atomic
  batch redeem, expiry/revoke/exhaustion, rate limiting), active-sleep
  state machine (single active session, idempotent wake), summary shape.
- Live checks: SPA 200, /api/docs 200, manifest + service worker 200, SPA
  fallback on /join/CODE, auth gates on domain routes and redeem, public
  invite-info endpoint.
