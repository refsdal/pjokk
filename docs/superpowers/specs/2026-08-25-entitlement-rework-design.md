# Entitlement Rework (free-tier tightening) — Design

Date: 2026-08-25
Status: approved (decisions settled in conversation)

Re-split of the free/premium boundary, replacing Phase 9's generous free tier.

**Free:** 1 baby · feed/diaper/sleep + **medicine** logging · timeline · day +
week stats · reminders, night mode, PWA.
**Premium:** everything else — additional babies, the five other activity
types (bath, note, milestone, measurement, pump), growth charts, month
stats, CSV export, API keys.

Decisions:

1. **Medicine stays free** — safety-adjacent (dose tracking across tired
   caregivers); the one gate that would feel hostile.
2. **Soft lock, keep data** (consistent with Phase 9): existing entries of
   gated types remain visible in the timeline and can be edited/deleted;
   only CREATION is premium. The baby limit gates ADDING a baby (free with
   ≥1 existing baby → 402); existing babies are never locked. The Welcome
   flow's first baby is unaffected.
3. **Same rules for everyone** — no grandfathering; all free families get
   the new gates when this ships.
4. **Grayed, not hidden**: the More sheet shows all six tiles; the five
   locked ones render muted with a lock badge and tapping opens the premium
   notice + navigates to Settings → Billing. "Add baby" in Settings gets the
   same treatment when at the free limit. Server gates (402 `PLAN_REQUIRED`)
   back every client gate.
5. New `Feature` values: `otherActivities` (bath/note/milestone/measurement/
   pump) and `multipleBabies`. All plan reads via `canUse`.
6. Copy updated to tell the truth: Welcome plan-step checklist and the
   Billing section blurb reflect the new split (concise highlight-reel, not
   a contract).

Out of scope: pricing changes, grandfathering machinery, hiding historical
data, gating the Stats weight row (existing data stays visible).
