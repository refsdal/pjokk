# Help request ("Ask for help") — Design

**Date:** 2026-09-06
**Status:** Approved design, pending implementation plan

## Problem

One caretaker in the nursery sometimes needs the other one — a bottle, a
hand with a nappy explosion, someone to take over. Today the app has no way
to say so; it means shouting through a wall or reaching for the phone's
messaging app with one hand while holding the baby with the other. The push
subsystem (VAPID web push, per-device subscriptions, Settings →
Notifications) already exists for feed and calendar reminders, and every
member of a family is already known. What is missing is a signal from one
person to another, with the same one-handed, two-tap ergonomics as logging
a feed.

## What it is

A **help request** is a piece of family state, not a fire-and-forget push —
the same idea as an active sleep session ("active sessions are state, not
screens"). One member asks a specific other member for help, optionally
with a short message. The target gets a push notification naming the
sender. Everyone in the family sees the request as a card on Home with a
pulsing red border until someone acknowledges it ("On my way"), at which
point the sender gets a push back and the card goes calm. The sender (or
an admin) dismisses it when it is over, and anything older than two hours
disappears on its own.

## Design

### 1. Data & lifecycle

New domain table (goose migration `00005_help_request.sql`):

```
help_request(
  id               text primary key,
  family_id        text not null references organizations(id) on delete cascade,
  from_user_id     text not null references users(id) on delete cascade,
  to_user_id       text not null references users(id) on delete cascade,
  message          text not null default '',      -- ≤ 200 chars, enforced by the spec
  created_at       timestamptz not null default now(),
  acknowledged_at  timestamptz null,
  acknowledged_by  text null references users(id) on delete set null
)
index on (family_id, created_at desc)
```

States, derived from the columns (no status enum):

| State        | Condition                                   | Card                                                         |
|--------------|---------------------------------------------|--------------------------------------------------------------|
| Open         | `acknowledged_at IS NULL`, < 2 h old         | Red pulsing border. "Anders needs a hand from Kari · 3 min ago · *Bring a bottle*" |
| Acknowledged | `acknowledged_at IS NOT NULL`, < 2 h old     | Calm border. "Kari is on the way · 1 min ago"                |
| Stale        | `created_at` more than 2 h ago               | Not shown, not returned. Row stays until a later cleanup — the nightly cron's existing purge step gains a `DELETE … WHERE created_at < now() - interval '7 days'` so the table cannot grow forever. |
| Done         | Row deleted by the sender or an admin        | Gone                                                         |

Rules:

- **Any family member may acknowledge**, not only the target. The target is
  who gets pinged; whoever is actually closer can answer. `acknowledged_by`
  records who, and the sender's push and the card name that person.
- Acknowledging is idempotent: a second acknowledge returns the row
  unchanged (the first acknowledger wins, no push is re-sent).
- **Only the sender or a family `admin` may delete.** Anyone else gets 403.
- Home shows **only the newest** request in the two-hour window. Sending a
  new request while one is open does not close the old one; the newer row
  simply takes over the card. No partial unique index, no "one open per
  family" invariant to enforce.
- The two-hour window is a **read-side filter** in the summary query, not a
  cron job. Nothing has to fire for a request to expire.
- Not on the timeline. A help request is about the caretakers, not the
  baby; it is not baby data and is not exported in the CSV.

### 2. API (`openapi/pjokk.yaml` → `go generate` → `bun run gen:client`)

New tag `help`. All three operations are **`tierFamilyNoAPIKey`**: the push
is attributed to a person, and a `pjk_` bearer key has no person behind it.

- `POST /api/help` — body `{ memberId: string, message?: string (maxLength 200) }`
  → `201 HelpRequest`.
  - `404 MEMBER_NOT_FOUND` if `memberId` is not a membership of the active
    family (the lookup is family-scoped in SQL, so a foreign membership id
    is indistinguishable from a nonexistent one).
  - `400 SELF_HELP` if the membership is the caller's own.
  - `429` when the caller exceeds **5 requests per 5 minutes**. The existing
    `middleware.RateLimit` keys on the client-IP digest and runs *before*
    the session is resolved, which is wrong here (a household shares one
    IP; the abuse is per person). The handler therefore hits
    `d.RateLimit` (the `ratelimit.Store`) directly with key
    `help:<userId>`, window 300 s, limit 5, and returns 429 itself. This is
    the first per-user limiter in the app; keep it a small helper in
    `internal/api` so a second one can reuse it.
  - On success the handler pushes to the target with
    `d.Push.ToUser(ctx, toUserID, PushPayload{Title: "<sender name> needs a hand", Body: message or "Can you come?", URL: "/home"})`.
    A push failure or zero deliveries does **not** fail the request — the
    row is committed first, then the push is attempted, and the response
    carries `delivered` so the sender can be told.
- `POST /api/help/{id}/acknowledge` → `200 HelpRequest`. `404` if the id
  is not in the active family. Idempotent as above. On the first
  acknowledge, pushes to the *sender* with
  `{Title: "<acknowledger name> is on the way", Body: "Answered your request", URL: "/home"}`.
  If the acknowledger *is* the sender (they can — nothing stops it), no
  push is sent.
- `DELETE /api/help/{id}` → `204`. `404` outside the family, `403
  NOT_SENDER` if the caller is neither the sender nor an admin.

Schema:

```yaml
HelpRequest:
  required: [id, fromUserId, fromName, toUserId, toName, message, createdAt, acknowledgedAt, acknowledgedByName, delivered]
  properties:
    id, fromUserId, toUserId: string
    fromName, toName: string          # display name, '' if the user has none
    message: string                   # '' when omitted
    createdAt: date-time
    acknowledgedAt: date-time, nullable
    acknowledgedByName: string, nullable
    delivered: integer                # devices the *creation* push reached; 0 after
                                      # a reload (only meaningful in the POST response)
```

`delivered` is only populated on the `POST /api/help` response; every other
place that returns a `HelpRequest` sets it to 0. Simpler than a second
response type, and documented in the schema description.

Names are denormalised into the response (joined from `users` in the
query) so the card never needs a second lookup and still reads correctly
if the member later leaves the family.

Existing operations that change:

- `GET /api/summary` gains **`openHelp: HelpRequest | null`** — the family's
  newest request in the 2 h window, regardless of state. Summary is
  per-baby but already carries family-level `activePlay`, and it is what
  Home polls (60 s + on focus + on notification tap), so the card updates
  through the existing query. Required field, nullable.
- `GET /api/family/members` gains **`hasPush: boolean`** — an `EXISTS
  (SELECT 1 FROM push_subscription WHERE user_id = om.user_id)` in
  `ListFamilyMembers`. Lets the picker dim people who never enabled
  notifications *before* the sender commits.

### 3. Server (`apps/server`)

- `internal/db/queries/help.sql`: `CreateHelpRequest`, `GetHelpRequest`
  (family-scoped, joined to both users' names + acknowledger name),
  `AcknowledgeHelpRequest` (`… SET acknowledged_at = $now, acknowledged_by = $user WHERE id = $1 AND family_id = $2 AND acknowledged_at IS NULL`),
  `DeleteHelpRequest`, `GetNewestHelpRequest` (`WHERE family_id = $1 AND created_at > $since ORDER BY created_at DESC LIMIT 1`),
  `PurgeOldHelpRequests`. Every query carries `family_id`.
- `internal/api/help.go`: the three handlers plus the per-user limiter
  helper and a `toHelpRequest(row, delivered)` mapper. Follows
  `play.go`/`sleep.go` for shape and comments.
- `internal/api/summary.go`: one more query, one more field.
- `internal/api/api.go`: the three operation IDs added to
  `operationAuthTiers` as `tierFamilyNoAPIKey`.
- `internal/jobs`: the nightly job's purge step also calls
  `PurgeOldHelpRequests(7 days)`. `backup_tables_test.go` will pick the new
  table up automatically (it is a normal domain table and IS backed up).
- Push payload strings are built server-side in English, like the feed and
  calendar reminders today. Localising push text is a separate, existing
  gap and is not widened here.

### 4. Frontend (`apps/frontend`)

**More sheet** (`components/sheets/OtherLogSheet.tsx`, `MoreSheet`): a new
tile **"Ask for help"** (`IconHandStop`, tint `text-danger` on the icon
only) opening `HelpSheet`. Listed last, after Vaccines.

**`HelpSheet`** (`components/sheets/HelpSheet.tsx`), a vaul sheet:

1. Member chips — every other member of the family, from
   `GET /api/family/members` (already fetched for Settings; reuse the
   query). The **last-picked member is prefilled** (localStorage key
   `pjokk.help.lastMember`, per family), so the common case is open → Send.
   Members with `hasPush === false` are still pickable but rendered dimmed
   with a small "No notifications" line — the card will still reach them
   next time they open the app.
2. Preset chips **Come here · Bring a bottle · Take over** — tapping one
   fills the message field (replacing its contents); the field stays
   editable. Optional free-text field beneath, `maxLength 200`, empty by
   default so the keyboard only appears if you reach for it.
3. Full-width **Send** at the very bottom, disabled until a member is
   picked. 44 px targets throughout.

After a successful send: sheet closes, the summary query is invalidated so
the card appears immediately, and a toast says **"Sent to Kari"** — or, if
`delivered === 0`, **"Kari hasn't turned on notifications"** so the sender
knows to text instead. On 429: toast "Too many requests — wait a few
minutes". Errors leave the sheet open.

**Home card** (`components/HelpCard.tsx`, rendered in `screens/Home.tsx`)
— placed **directly below the baby header and above the active-session
banners and status cards**, so it is the first card the eye lands on
without displacing the baby's name. Styled like `StatusCard` (icon, label,
relative time, detail line), danger tint on the icon only:

- Open: **border-2 border-danger**, plus two animations that share one
  2.4 s cycle (chosen from mock-ups, see
  `.superpowers/brainstorm/…/help-card-animation-v2.html`):
  - `help-ping` on the card — a `box-shadow` ring in the danger colour
    expanding from 0 to 14 px and fading to transparent, `cubic-bezier(0,
    0, .2, 1)`, infinite. The border itself stays solid; nothing in the
    layout moves.
  - `help-wave` on the hand icon (`IconHandStop`) — a short rotate wave
    (+14° → −12° → +10° → −6° → 0) in the first half of the cycle, then
    still; `transform-origin: 50% 90%` so it pivots at the wrist.
  Both keyframes live in `styles.css` next to the existing animations and
  read the ring colour from `--color-danger`, so night mode's amber-red
  variant is picked up automatically. Under `@media
  (prefers-reduced-motion: reduce)` both animations are removed and the
  solid red border alone carries the state — same prominence, no motion.
  Night mode keeps the animations: red/amber is not blue light, and this
  is exactly the case worth waking someone for.
- Acknowledged: animations stop, the border transitions (~350 ms) to the
  normal hairline `border-line`, and the icon tint goes from `text-danger`
  to `text-ok`. No further motion.
- Label/detail copy:
  - Open, viewer is target: "**Anders** needs a hand" / message / "3 min ago".
  - Open, viewer is anyone else: "**Anders** needs a hand from **Kari**" / message / time.
  - Acknowledged: "**Kari** is on the way" / message / time since ack.
- One action button, chosen by who is looking:
  - Open, viewer is not the sender → **On my way** (acknowledge).
  - Open, viewer is the sender → **Never mind** (delete).
  - Acknowledged, viewer is the sender or an admin → **Done** (delete).
  - Acknowledged, anyone else → no button.
- Mutations invalidate the summary query. Both are plain online mutations —
  a help request with no signal cannot reach anyone anyway, so they are
  **not** enqueued in the offline mutation queue; the UI shows the ordinary
  error toast.

**Strings** go through `t()` with `nb` entries in `lib/i18n.ts` (the i18n
coverage check in `bun run check` enforces this). Push text stays
server-side English (see §3).

**Not doing now**, deliberately: a night-mode entry point (night mode's
three actions stay three — the card still shows), a history/timeline entry,
a reply message on acknowledge, sound/vibration beyond what the OS does
for a push, a picker for *multiple* targets.

### 5. Testing

Go (`apps/server`, real Postgres, `go test -p 1 ./...`):

- `help_test.go` (in-process API against the test rig, in-memory push
  sender):
  - create → 201, row scoped to the family, push delivered to the target
    user with title `"<name> needs a hand"` and the message as body;
    default body when message omitted.
  - `memberId` from another family → 404; own membership → 400.
  - sixth create within 5 min → 429; a different user is unaffected.
  - acknowledge by the target and by a third member both succeed; second
    acknowledge is a no-op 200 with the original `acknowledgedBy`; exactly
    one push to the sender, none when the sender acknowledges their own.
  - acknowledge/delete on another family's id → 404.
  - delete by a non-sender member → 403; by admin → 204.
  - API-key auth on all three → 403 (extends `TestPushRoutesForbidAPIKeyAuth`'s pattern).
- `summary_test.go`: `openHelp` null when none, newest within window,
  null when the only request is > 2 h old (using `d.Now`).
- `babies_test.go` (members): `hasPush` false, then true after a
  subscription is inserted.
- `jobs`: purge removes rows older than 7 days and keeps newer ones.

Frontend (`bun test apps/frontend`):

- `HelpSheet`: Send disabled with no member; preset chip fills the field;
  last-picked member restored from localStorage.
- `HelpCard`: renders the right copy and button for target / sender /
  bystander in open and acknowledged states; open state carries the pulse
  class, acknowledged does not.
- i18n coverage check passes (`bun run check`).
