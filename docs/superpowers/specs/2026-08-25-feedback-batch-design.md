# Feedback Batch (first real-user pass) — Design

Date: 2026-08-25
Status: approved (decisions settled in conversation with the user)

Thirteen items of tester feedback, triaged and decided:

1. **Light-mode contrast**: `--color-muted` (#938d80, ~3:1 on bg — below
   WCAG AA for small text) darkens to ≥4.5:1; `--color-ink-soft` gets a
   small nudge. Light block only; dark/night palettes untouched.
2. **Date/time picker**: replace the native `datetime-local` in `TimeField`'s
   "Pick time" panel with day chips **Today / Yesterday / Other** (Other
   reveals a date input) plus a clean `type="time"` field. Chips over
   keyboards, per product principles.
3. **Measurements lose the time field**: measurement entries are once-a-day;
   timestamp is simply "now". The TimeField is not rendered for the
   measurement kind.
4. **Feed ml steps**: 5 ml steps up to 50 ml, 10 ml above; minimum 5 ml.
5. **Breastfeeding**: per-side minute steppers (step 1 min) replacing the
   single total + side chip (side is derived: left / right / both from which
   sides have minutes), PLUS a per-side start/stop timer (mm:ss, 1 s tick)
   that fills the steppers on stop and survives sheet close via
   localStorage. New nullable `feed_log.left_min` / `right_min` columns
   preserve the split; `durationMin` remains the total for compatibility.
6. **Solids in grams**: the solids stepper and every display (home detail,
   timeline, CSV `unit` column) use **g**; the value is stored in the
   existing `amountMl` column (unit derived from `type` — documented
   pragmatism, no migration). Consequence handled everywhere sums exist:
   **intake ml sums bottle feeds only** (stats + summary); solids grams are
   a separate count/sum where shown.
7. **Steppers accept typed values**: the number in every Stepper is a real
   input (numeric keypad, select-on-focus, clamp + round on commit).
8. **Night mode at 20:54 is not a timezone bug** (comparison uses local
   `getHours()`); the "On" chip is a manual override that activates night
   mode immediately and reads like "enable schedule". Fix is labeling:
   "On" → "Always on", plus a status line under the chips stating what will
   happen ("Turns on at 22:00 · off at 07:00" / "Stays on until switched
   off"). No schedule-code change.
9. **Stats weight card** opens the measurement sheet directly on tap.
10. **Stats gets a Day option**: chip row becomes Day / Week / Month
    (days = 1 / 7 / 30). Day and Week are free; Month stays Premium (server
    gate `days > 7` already permits days=1). Card layout otherwise
    unchanged (user's explicit choice — the "x feeds · y diapers" sub-line
    stays).
11. **Home status cards get a third line with today's totals**, tz-aware,
    from an extended `GET /api/summary` (`today` block computed server-side
    with the same local-midnight bucketing as stats):
    - Last feed → "N feeds · M ml today" (+ " · K g" when solids logged)
    - Last diaper → "W wet · D dirty · B both"
    - Last sleep → total sleep today ("2 h 10 m today")
12. **Sleep location "Arms" renamed to "Contact nap"** (label/i18n only;
    stored value `arms` unchanged).
13. **Custom sleep locations**: new family-scoped `sleep_location` table +
    CRUD (`GET/POST/DELETE /api/sleep-locations`; writes admin-only, ≤20
    locations, name ≤40 chars), a Settings management section, and the
    sleep sheet showing defaults + custom locations. Custom values are
    stored by name (the column is already free text). The current
    `asLocation` coercion that silently rewrites unknown values to "crib"
    on edit is removed — a genuine data-loss bug once custom values exist.

Out of scope: server-side night-mode schedule storage (stays device-local),
per-side breast data in CSV export (total only, noted), stats card redesign.
