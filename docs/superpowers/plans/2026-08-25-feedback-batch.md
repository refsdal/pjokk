# Feedback Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the 13-item tester-feedback batch: contrast, elegant time picker, typed + variable steppers, solids in grams, per-side nursing timer, tz-aware today totals on Home, custom sleep locations, night-mode labeling, Stats day view.

**Architecture:** Almost entirely client work on existing components, plus one migration (0008: `feed_log.left_min`/`right_min`, new `sleep_location` table), an extended `/api/summary` (tz-aware `today` block), and a small family-scoped CRUD for sleep locations. Grams ride in the existing `amountMl` column with unit derived from feed type; every ml-summing path switches to bottle-only.

**Tech Stack:** React 19 + TanStack Query, Tailwind tokens in `src/web/styles.css`, Hono + @hono/zod-openapi, Drizzle/D1, vitest-pool-workers.

**Spec:** `docs/superpowers/specs/2026-08-25-feedback-batch-design.md` — read it first; it records the user's decisions verbatim.

## Global Constraints

- Every new user-facing string goes through `t()` with an `nb` entry in `src/web/lib/i18n.ts` (CI guard fails otherwise). Check for existing keys before adding.
- Product principles bind: chips/steppers over keyboards, 44px+ touch targets on log flows, calm palette (category colors on icons only), status in relative time.
- Error/code conventions: 402/403/404 with UPPER_SNAKE `code` fields, as elsewhere.
- Conventional Commits; trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- pnpm's shim is broken in this environment — run pnpm ONLY via the wrapper the controller provides in the dispatch (a `bin/pnpm` under the SDD workspace).
- Verification: `pnpm check` (biome + i18n guard + tsc x2), `pnpm test` (workers runtime), `pnpm build` where client bundles change.
- `sleep_log.location` is free text (max 100) server-side already — custom locations need no change to sleep routes.
- Solids values are stored in `feed_log.amount_ml` and interpreted as grams when `type === "solids"` — never add a parallel amount column.

---

### Task 1: Light-mode contrast + "Contact nap" label

**Files:**
- Modify: `src/web/styles.css:13-15` (light `@theme` block only)
- Modify: `src/web/components/sheets/SleepSheet.tsx:107` (label only)
- Modify: `src/web/lib/i18n.ts`

**Interfaces:** none downstream.

- [ ] **Step 1: Darken the light-mode grays**

In `src/web/styles.css` light block change:

```css
--color-ink-soft: #524d43;
--color-muted: #6e6759;
```

(`#6e6759` on `#faf9f7` ≈ 5.4:1 and on `#ffffff` ≈ 5.7:1 — comfortably past AA for small text; verify with any contrast calculator if in doubt, e.g. `npx wcag-contrast` is NOT installed — compute manually: relative luminance formula, or trust these precomputed values.) Do NOT touch the `.dark` or `.night` blocks.

- [ ] **Step 2: Rename the chip label**

`SleepSheet.tsx`: `{ value: "arms", label: t("Arms") }` → `{ value: "arms", label: t("Contact nap") }`. The stored value stays `"arms"`.

In `i18n.ts`: remove the now-unused `"Arms"` entry, add `"Contact nap": "Kontaktlur"`.

- [ ] **Step 3: Verify + commit**

Run: `pnpm check && pnpm test`
Expected: PASS (styles/labels don't affect worker tests).

```bash
git add src/web/styles.css src/web/components/sheets/SleepSheet.tsx src/web/lib/i18n.ts
git commit -m "fix(a11y): AA contrast for light-mode muted text; rename Arms to Contact nap" -m "Feedback batch items 1, 12." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Stepper — typed input + function steps

**Files:**
- Modify: `src/web/components/Stepper.tsx` (full rewrite of the value display; +/- logic extended)
- Modify: `src/web/lib/i18n.ts` (if any new strings — likely none)

**Interfaces:**
- Produces: `Stepper` props gain `step?: number | ((value: number, direction: 1 | -1) => number)` (default `10` unchanged). The displayed number becomes an `<input>` committing on blur/Enter with clamp-to-min/max and rounding to `decimals`. All existing call sites keep working unchanged (number `step` still accepted).

- [ ] **Step 1: Extend the component**

Rewrite `src/web/components/Stepper.tsx`:

```tsx
import { IconMinus, IconPlus } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// Number stepper: amounts change by taps — but the number itself is a real
// input, so a big jump can be typed directly (numeric keypad, clamped).
export function Stepper({
  value,
  onChange,
  step = 10,
  min = 0,
  max = 500,
  unit,
  decimals = 0,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  /** Fixed step, or a function of (current value, direction) — e.g. feeds
   *  step 5 ml below 50 and 10 ml above. */
  step?: number | ((value: number, direction: 1 | -1) => number);
  min?: number;
  max?: number;
  unit: string;
  decimals?: number;
  className?: string;
}) {
  const factor = 10 ** decimals;
  const clamp = (v: number) =>
    Math.min(max, Math.max(min, Math.round(v * factor) / factor));
  const stepFor = (dir: 1 | -1) =>
    typeof step === "function" ? step(value, dir) : step;
  const adjust = (dir: 1 | -1) => onChange(clamp(value + dir * stepFor(dir)));

  // Draft mirrors the value while typing; commit on blur/Enter.
  const [draft, setDraft] = useState<string | null>(null);
  const shown =
    draft ?? (decimals > 0 ? value.toFixed(decimals) : String(value));
  useEffect(() => {
    setDraft(null);
  }, [value]);
  const commit = () => {
    if (draft !== null) {
      const parsed = Number(draft.replace(",", "."));
      if (!Number.isNaN(parsed)) onChange(clamp(parsed));
    }
    setDraft(null);
  };

  return (
    <div
      className={cn(
        "flex items-center justify-between rounded-xl2 border border-line bg-surface p-1.5",
        className,
      )}
    >
      <button
        type="button"
        aria-label={`${t("decrease")} ${unit}`}
        onClick={() => adjust(-1)}
        className="flex h-12 w-14 items-center justify-center rounded-xl bg-surface-2 text-ink active:scale-95"
      >
        <IconMinus className="h-5 w-5" />
      </button>
      <div className="flex items-baseline justify-center tabular-nums">
        <input
          inputMode="decimal"
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          aria-label={unit}
          size={Math.max(shown.length, 1)}
          className="w-auto min-w-8 border-none bg-transparent p-0 text-center text-2xl font-bold text-ink outline-none"
          style={{ width: `${Math.max(shown.length, 1)}ch` }}
        />
        <span className="ml-1 text-sm text-muted">{unit}</span>
      </div>
      <button
        type="button"
        aria-label={`${t("increase")} ${unit}`}
        onClick={() => adjust(1)}
        className="flex h-12 w-14 items-center justify-center rounded-xl bg-surface-2 text-ink active:scale-95"
      >
        <IconPlus className="h-5 w-5" />
      </button>
    </div>
  );
}
```

Notes: `aria-live` is dropped deliberately (an input announces itself); the `useEffect` reset keeps external prefill changes (type switches re-seed values) winning over stale drafts. Accept comma as decimal separator (`nb` keyboards).

- [ ] **Step 2: Verify**

Run: `pnpm check && pnpm build`
Expected: PASS; no call-site changes needed (`step` widened, not changed).

- [ ] **Step 3: Commit**

```bash
git add src/web/components/Stepper.tsx
git commit -m "feat(ui): stepper accepts typed values and per-direction step functions" -m "Feedback batch item 7." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Feed units — ml steps 5/10, solids in grams, bottle-only intake sums

**Files:**
- Modify: `src/web/components/sheets/FeedSheet.tsx:145-154` (amount stepper)
- Modify: `src/web/screens/Home.tsx:36-48` (`feedDetail` — solids show grams)
- Modify: `src/web/screens/Timeline.tsx` (feed row detail — find the ml rendering and add g for solids)
- Modify: `src/worker/routes/export.ts` (unit column: `g` for solids)
- Modify: `src/worker/routes/stats.ts:59-65` (intake sums bottle only)
- Test: `test/stats.test.ts` (append)

**Interfaces:**
- Consumes: Task 2's function `step`.
- Produces: the convention "`amountMl` holds grams when `type === 'solids'`"; helper `feedAmount(f): string` is NOT introduced — each display site formats locally (three sites, different contexts).

- [ ] **Step 1: Write the failing server test (intake excludes solids)**

Append to `test/stats.test.ts` (reuse its existing helpers/rig conventions — read the file first):

```ts
it("intake sums bottle ml only — solids grams don't pollute it", async () => {
  const { family, baby, cookie } = await rig();
  await setPlan(family.id, "premium");
  const now = new Date().toISOString();
  await api("/api/feeds", {
    method: "POST",
    cookie,
    body: { babyId: baby.id, time: now, type: "bottle", amountMl: 120 },
  });
  await api("/api/feeds", {
    method: "POST",
    cookie,
    body: { babyId: baby.id, time: now, type: "solids", amountMl: 80 },
  });
  const res = await api(`/api/stats?babyId=${baby.id}&days=7`, { cookie });
  const s = (await res.json()) as { days: { intakeMl: number; feeds: number }[] };
  const today = s.days[s.days.length - 1]!;
  expect(today.feeds).toBe(2);
  expect(today.intakeMl).toBe(120);
});
```

(Adapt imports/endpoint body fields to what `test/stats.test.ts` actually uses — read it before writing.)

- [ ] **Step 2: Run to verify it fails** (`intakeMl` currently 200)

Run: `pnpm vitest run test/stats.test.ts`

- [ ] **Step 3: Implement**

`src/worker/routes/stats.ts` feed loop (currently `b.intakeMl += f.amountMl ?? 0;`):

```ts
b.feeds += 1;
if (f.type === "bottle") b.intakeMl += f.amountMl ?? 0;
```

`src/worker/routes/export.ts` feeds mapping: `unit: r.amountMl != null ? "ml" : null` becomes `unit: r.amountMl != null ? (r.type === "solids" ? "g" : "ml") : null`.

`FeedSheet.tsx`: replace the shared amount stepper with per-type props:

```tsx
{(type === "bottle" || type === "solids") && (
  <Stepper
    value={amountMl}
    onChange={setAmountMl}
    step={
      type === "bottle"
        ? (v, dir) => ((dir > 0 ? v < 50 : v <= 50) ? 5 : 10)
        : 5
    }
    min={5}
    max={500}
    unit={type === "solids" ? "g" : "ml"}
  />
)}
```

Also update the solids prefill default: in `applyPrefill`, solids fall back to `40` (a typical portion) instead of sharing bottle's `120` — keep bottle's default 120:

```ts
if (feedType === "bottle") setAmountMl(last?.amountMl ?? 120);
if (feedType === "solids") setAmountMl(last?.amountMl ?? 40);
```

`Home.tsx` `feedDetail`: where solids currently render as the bare word, show `` `${f.amountMl} g` `` when `amountMl` is set (read the function and follow its existing format for bottle ml).

`Timeline.tsx`: find where feed rows render `ml` (grep `ml` in the file); render `g` when the feed's type is solids, same format otherwise.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run test/stats.test.ts` → PASS; then `pnpm check && pnpm test && pnpm build` → PASS (fix any pre-existing test asserting solids-inclusive intake by updating the assertion — gates must not be weakened, but unit semantics changed deliberately).

- [ ] **Step 5: Commit**

```bash
git add src/web/components/sheets/FeedSheet.tsx src/web/screens/Home.tsx src/web/screens/Timeline.tsx src/worker/routes/export.ts src/worker/routes/stats.ts test/stats.test.ts src/web/lib/i18n.ts
git commit -m "feat(feeds): 5/10 ml steps, solids measured in grams, bottle-only intake sums" -m "Feedback batch items 4, 6." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: TimeField redesign + no time on measurements

**Files:**
- Modify: `src/web/components/TimeField.tsx` (replace the pick panel)
- Modify: `src/web/components/sheets/OtherLogSheet.tsx:391` (hide for measurement kind)
- Modify: `src/web/lib/i18n.ts`

**Interfaces:**
- Produces: `TimeField` keeps its exact external contract (`value: Date | null`, `onChange`, `className`) — only the "pick" panel changes. Sheets need no changes beyond OtherLogSheet's conditional.

- [ ] **Step 1: Rebuild the pick panel**

In `TimeField.tsx`, keep the Now / 15 m ago / Pick time chips and the null-means-now contract. Replace the `datetime-local` input with:

```tsx
type DayChoice = "today" | "yesterday" | "other";

// inside the component:
const [day, setDay] = useState<DayChoice>("today");

const setDatePart = (base: Date, dayChoice: DayChoice, otherDate?: string) => {
  const d = new Date(base);
  const ref = new Date();
  if (dayChoice === "yesterday") ref.setDate(ref.getDate() - 1);
  if (dayChoice === "other" && otherDate) {
    const [y, m, dd] = otherDate.split("-").map(Number);
    ref.setFullYear(y!, m! - 1, dd!);
  }
  d.setFullYear(ref.getFullYear(), ref.getMonth(), ref.getDate());
  return d;
};
```

Pick panel markup (replacing lines 51-62):

```tsx
{preset === "pick" && (
  <div className="space-y-2">
    <ChipGroup
      options={[
        { value: "today", label: t("Today") },
        { value: "yesterday", label: t("Yesterday") },
        { value: "other", label: t("Other day") },
      ]}
      value={day}
      onChange={(d) => {
        setDay(d);
        if (d !== "other") onChange(setDatePart(value ?? new Date(), d));
      }}
    />
    {day === "other" && (
      <input
        type="date"
        value={toDateInput(value ?? new Date())}
        max={toDateInput(new Date())}
        onChange={(e) =>
          e.target.value &&
          onChange(setDatePart(value ?? new Date(), "other", e.target.value))
        }
        className="h-12 w-full rounded-xl2 border border-line bg-surface px-4 text-base text-ink"
      />
    )}
    <input
      type="time"
      value={toTimeInput(value ?? new Date())}
      onChange={(e) => {
        const [h, m] = e.target.value.split(":").map(Number);
        const d = new Date(value ?? new Date());
        d.setHours(h ?? 0, m ?? 0, 0, 0);
        onChange(d);
      }}
      className="h-12 w-full rounded-xl2 border border-line bg-surface px-4 text-base text-ink"
    />
  </div>
)}
```

With small helpers next to `toLocalInputValue` (which can be deleted if now unused):

```tsx
const pad = (n: number) => String(n).padStart(2, "0");
const toDateInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTimeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
```

When switching into `pick`, initialize `day` from the current value's date (today / yesterday / other). A picked future moment (today + a later clock time) is allowed by the input but clamp on change: if the composed Date is in the future, use `new Date()` instead — retroactive logging never needs the future.

- [ ] **Step 2: Hide the field for measurements**

`OtherLogSheet.tsx` line ~391: wrap the `<TimeField …/>` in `{kind !== "measurement" && …}`. Verify the save path uses `time ?? new Date()` so measurements stamp "now" (it does — confirm while there).

- [ ] **Step 3: i18n**

Add nb entries: `"Today": "I dag"`, `"Yesterday": "I går"`, `"Other day": "Annen dag"` (check `Today`/`Yesterday` don't already exist — grep first).

- [ ] **Step 4: Verify + commit**

Run: `pnpm check && pnpm test && pnpm build` → PASS.

```bash
git add src/web/components/TimeField.tsx src/web/components/sheets/OtherLogSheet.tsx src/web/lib/i18n.ts
git commit -m "feat(ui): chip-based day+time picker; measurements drop the time field" -m "Feedback batch items 2, 3." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Night mode labeling

**Files:**
- Modify: `src/web/screens/settings/AppearanceSection.tsx:49-60`
- Modify: `src/web/lib/i18n.ts`

**Interfaces:** none.

- [ ] **Step 1: Relabel + status line**

In the night-mode `ChipGroup`: `{ value: "on", label: t("On") }` → `{ value: "on", label: t("Always on") }` (leave "Off" and the `Auto (22–07)` label as they are).

Below the ChipGroup (inside the same Card, before the schedule chips) add a status line:

```tsx
<p className="text-sm text-muted">
  {mode === "on"
    ? t("Night mode stays on until you switch it off.")
    : mode === "auto"
      ? `${t("Turns on at")} ${String(schedule.startHour).padStart(2, "0")}:00 · ${t("off at")} ${String(schedule.endHour).padStart(2, "0")}:00`
      : t("Night mode is off.")}
</p>
```

nb entries: `"Always on": "Alltid på"`, `"Night mode stays on until you switch it off.": "Nattmodus forblir på til du slår den av."`, `"Turns on at": "Slås på kl."`, `"off at": "av kl."`, `"Night mode is off.": "Nattmodus er av."`.

- [ ] **Step 2: Verify + commit**

Run: `pnpm check && pnpm build` → PASS.

```bash
git add src/web/screens/settings/AppearanceSection.tsx src/web/lib/i18n.ts
git commit -m "fix(night): 'Always on' label + explicit schedule status line" -m "Feedback batch item 8 — the 20:54 report was the manual On override, not a timezone bug (night.ts compares local getHours)." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Migration 0008 — per-side nursing minutes + sleep_location table

**Files:**
- Modify: `src/worker/db/schema.ts` (feedLog columns + new table)
- Create: `migrations/0008_feedback-batch.sql`
- Modify: `src/shared/schemas.ts` (FeedLogSchema + create/update schemas; new SleepLocationSchema)
- Modify: `src/worker/db/scoped.ts` (serialize/accept new feed fields; sleepLocation helpers)
- Modify: `src/worker/routes/feeds.ts` (pass-through of leftMin/rightMin — read the file; it likely spreads validated body into scoped helpers)
- Test: `test/sleep.test.ts` or `test/other-logs.test.ts` — NO; add to `test/household.test.ts`? NO — create `test/feedback-batch.test.ts` for this batch's server tests.

**Interfaces:**
- Produces: `feed_log.left_min` / `right_min` (nullable ints) surfaced as `leftMin`/`rightMin` in `FeedLogSchema`, accepted optionally in feed create/update. `schema.sleepLocation` table `(id, familyId, name, createdAt)`. Scoped helpers: `fam.listSleepLocations(): Promise<{id, name}[]>`, `fam.createSleepLocation(name): Promise<row>`, `fam.deleteSleepLocation(id): Promise<boolean>` (family-scoped like every other helper). Task 7 consumes the feed fields; Task 9 consumes the location helpers.

- [ ] **Step 1: Failing test**

Create `test/feedback-batch.test.ts` (helpers from `./helpers` as in other files):

```ts
import { describe, expect, it } from "vitest";
import { api, rig } from "./helpers";

describe("per-side nursing minutes", () => {
  it("stores and returns leftMin/rightMin on breast feeds", async () => {
    const { baby, cookie } = await rig();
    const res = await api("/api/feeds", {
      method: "POST",
      cookie,
      body: {
        babyId: baby.id,
        time: new Date().toISOString(),
        type: "breast",
        side: "both",
        durationMin: 25,
        leftMin: 10,
        rightMin: 15,
      },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { leftMin: number | null; rightMin: number | null };
    expect(created.leftMin).toBe(10);
    expect(created.rightMin).toBe(15);
  });
});
```

(Adapt the create-feed body/status to the real route contract — read `src/worker/routes/feeds.ts` and an existing feed test first.)

- [ ] **Step 2: Run to verify failure** (validation strips/rejects unknown fields today)

- [ ] **Step 3: Implement**

`src/worker/db/schema.ts` — in `feedLog` after `durationMin`:

```ts
leftMin: integer("left_min"),
rightMin: integer("right_min"),
```

New table (match the file's id-generation and FK conventions — read a neighbor table like `familyInvite` first):

```ts
export const sleepLocation = sqliteTable("sleep_location", {
  // Use the exact same id `$defaultFn` generator the other domain tables in
  // this file use (open the `baby` table definition and copy its id line
  // verbatim — do not invent a new generator).
  id: text("id").primaryKey().$defaultFn(idGeneratorCopiedFromBabyTable),
  familyId: text("family_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .$defaultFn(() => new Date())
    .notNull(),
});
```

`migrations/0008_feedback-batch.sql` (match 0007's dialect):

```sql
-- Feedback batch: per-side nursing minutes + custom sleep locations.
ALTER TABLE `feed_log` ADD COLUMN `left_min` integer;
ALTER TABLE `feed_log` ADD COLUMN `right_min` integer;
CREATE TABLE `sleep_location` (
  `id` text PRIMARY KEY NOT NULL,
  `family_id` text NOT NULL,
  `name` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`family_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `sleep_location_family_idx` ON `sleep_location` (`family_id`);
```

(Adjust FK/default syntax to exactly match how 0000_init.sql declares family-scoped tables; add the index to the Drizzle table def too.)

`src/shared/schemas.ts`: `FeedLogSchema` + feed create/update schemas gain `leftMin: z.number().int().min(0).max(600).nullable().optional()` (same for `rightMin`; on the log schema nullable non-optional to mirror existing nullable fields — match how `durationMin` is declared). Add:

```ts
export const SleepLocationSchema = z
  .object({ id: z.string(), name: z.string() })
  .openapi("SleepLocation");
```

`scoped.ts`: thread the two fields through createFeed/updateFeed (follow how `durationMin` flows); add the three sleepLocation helpers scoped by `familyId`, `deleteSleepLocation` returning whether a row matched (see `revokeApiKey` for the pattern). `serFeed` in `worker/lib.ts` spreads the row, so new columns flow automatically — verify.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run test/feedback-batch.test.ts` → PASS; `pnpm check && pnpm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/db/schema.ts migrations/0008_feedback-batch.sql src/shared/schemas.ts src/worker/db/scoped.ts src/worker/routes/feeds.ts test/feedback-batch.test.ts
git commit -m "feat(db): per-side nursing minutes + sleep_location table (migration 0008)" -m "Feedback batch items 5, 13 (data layer)." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Breastfeeding — per-side steppers + timer

**Files:**
- Modify: `src/web/components/sheets/FeedSheet.tsx` (breast branch rewrite)
- Create: `src/web/lib/nursing-timer.ts` (localStorage persistence)
- Modify: `src/web/lib/i18n.ts`

**Interfaces:**
- Consumes: `leftMin`/`rightMin` on FeedLog + create/update payloads (Task 6); Stepper function-step (Task 2).
- Produces: localStorage key `pjokk.nursing` holding `{ running: "left" | "right" | null, startedAt: number | null, leftSec: number, rightSec: number }`.

- [ ] **Step 1: The timer store**

`src/web/lib/nursing-timer.ts`:

```ts
// A dead-simple persisted nursing timer: accumulated seconds per side plus
// at most one running side. Survives the sheet closing or the PWA being
// backgrounded; cleared when a feed is saved.
const KEY = "pjokk.nursing";

export type NursingTimer = {
  running: "left" | "right" | null;
  startedAt: number | null;
  leftSec: number;
  rightSec: number;
};

const empty: NursingTimer = { running: null, startedAt: null, leftSec: 0, rightSec: 0 };

export function loadNursing(): NursingTimer {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...empty, ...(JSON.parse(raw) as NursingTimer) } : empty;
  } catch {
    return empty;
  }
}

export function saveNursing(t: NursingTimer) {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    /* storage unavailable — timer is best-effort */
  }
}

export function clearNursing() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Seconds for a side including a currently-running stretch. */
export function sideSeconds(t: NursingTimer, side: "left" | "right", now = Date.now()): number {
  const base = side === "left" ? t.leftSec : t.rightSec;
  return t.running === side && t.startedAt
    ? base + Math.floor((now - t.startedAt) / 1000)
    : base;
}
```

- [ ] **Step 2: Rebuild the breast branch in FeedSheet**

Replace the side `ChipGroup` + single duration Stepper with per-side rows. State changes:

- Remove `side`/`durationMin` state; add `leftMin`, `rightMin` (numbers) and `timer` (`NursingTimer`), plus a 1 s `setInterval` tick active only while `timer.running` and the sheet is open.
- Open-seed (in the existing `open && !wasOpen` block): edit rows use `edit.leftMin ?? …` — when both null, derive from legacy fields: `side === "right"` → `(0, durationMin)`, `side === "both"` → split `durationMin` half/half (ceil left), else `(durationMin, 0)`. Create seeds from the timer if it has accumulated seconds (`Math.max(1, Math.round(sideSeconds(...)/60))` per side with any seconds), otherwise from the last breast feed's `leftMin/rightMin` (falling back to the legacy derivation), otherwise 10/0.
- Save: for breast send `leftMin`, `rightMin`, `durationMin: leftMin + rightMin`, `side: leftMin > 0 && rightMin > 0 ? "both" : rightMin > 0 ? "right" : "left"`; require `leftMin + rightMin > 0` (disable Save otherwise). On successful save call `clearNursing()`.

UI per side (two rows, Left then Right):

```tsx
<div className="space-y-1">
  <div className="flex items-center justify-between px-1">
    <p className="text-xs font-semibold tracking-wide text-muted uppercase">{t("Left")}</p>
    <button
      type="button"
      onClick={() => toggleTimer("left")}
      className="rounded-full bg-surface-2 px-3 py-1 text-sm font-semibold text-ink active:scale-95"
    >
      {timer.running === "left"
        ? `${t("Stop")} · ${clock(sideSeconds(timer, "left", now))}`
        : t("Start timer")}
    </button>
  </div>
  <Stepper value={leftMin} onChange={setLeftMin} step={1} min={0} max={90} unit="min" />
</div>
```

with `clock(sec)` = `mm:ss` formatter local to the file, and `toggleTimer(side)`:

```ts
const toggleTimer = (side: "left" | "right") => {
  const now = Date.now();
  let t = { ...timer };
  if (t.running) {
    // bank the running side (even when toggling the same side off)
    const key = t.running === "left" ? "leftSec" : "rightSec";
    t = { ...t, [key]: sideSeconds(t, t.running, now), running: null, startedAt: null };
  }
  if (timer.running !== side) {
    t = { ...t, running: side, startedAt: now };
  }
  setTimer(t);
  saveNursing(t);
  // Reflect banked whole minutes into the steppers as they accrue.
  setLeftMin(Math.max(leftMin, Math.round(sideSeconds(t, "left", now) / 60)));
  setRightMin(Math.max(rightMin, Math.round(sideSeconds(t, "right", now) / 60)));
};
```

On stop, set the side's stepper to `Math.max(1, Math.round(sec / 60))` if any seconds accrued. Add a small "Reset timer" text button (visible when `leftSec + rightSec > 0 || running`) calling `clearNursing()` + zeroing timer state.

nb entries: `"Start timer": "Start tidtaker"`, `"Stop": "Stopp"`, `"Reset timer": "Nullstill tidtaker"` (grep for existing `Left`/`Right`/`Stop` keys first).

- [ ] **Step 3: Verify + commit**

Run: `pnpm check && pnpm test && pnpm build` → PASS.

```bash
git add src/web/components/sheets/FeedSheet.tsx src/web/lib/nursing-timer.ts src/web/lib/i18n.ts
git commit -m "feat(feeds): per-side nursing minutes with persistent start/stop timer" -m "Feedback batch item 5 (UI)." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Summary today block + Home three-line cards

**Files:**
- Modify: `src/worker/routes/sleep.ts` (summary route: tz param + today block)
- Modify: `src/shared/schemas.ts` (SummarySchema)
- Modify: `src/web/lib/data/logs.ts:42-51` (`useSummary` sends tz)
- Modify: `src/web/components/StatusCard.tsx` (optional `sub` third line)
- Modify: `src/web/screens/Home.tsx:132-158` (pass subs)
- Modify: `src/web/lib/i18n.ts`
- Test: `test/feedback-batch.test.ts` (append)

**Interfaces:**
- Consumes: bottle-only intake convention (Task 3).
- Produces: `SummarySchema.today = { feeds, intakeMl, solidsG, wet, dirty, both, sleepMin }` (all `z.number().int()`); `StatusCard` gains `sub?: string`.

- [ ] **Step 1: Failing test**

Append to `test/feedback-batch.test.ts`:

```ts
describe("summary today block", () => {
  it("counts today's feeds/diapers/sleep tz-aware", async () => {
    const { baby, cookie } = await rig();
    const now = new Date();
    await api("/api/feeds", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, time: now.toISOString(), type: "bottle", amountMl: 100 },
    });
    await api("/api/feeds", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, time: now.toISOString(), type: "solids", amountMl: 50 },
    });
    await api("/api/diapers", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, time: now.toISOString(), type: "wet" },
    });
    await api("/api/diapers", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, time: now.toISOString(), type: "both" },
    });
    const tz = now.getTimezoneOffset();
    const res = await api(`/api/summary?babyId=${baby.id}&tz=${tz}`, { cookie });
    const s = (await res.json()) as {
      today: { feeds: number; intakeMl: number; solidsG: number; wet: number; dirty: number; both: number; sleepMin: number };
    };
    expect(s.today.feeds).toBe(2);
    expect(s.today.intakeMl).toBe(100);
    expect(s.today.solidsG).toBe(50);
    expect(s.today.wet).toBe(1);
    expect(s.today.dirty).toBe(0);
    expect(s.today.both).toBe(1);
  });
});
```

(Adapt body fields to the real diaper/feed create contracts — read the routes.)

- [ ] **Step 2: Run to verify failure** (no `today` in response)

- [ ] **Step 3: Implement the server side**

Summary route query: `z.object({ babyId: z.string(), tz: z.coerce.number().int().min(-840).max(840).default(0) })`. In the handler, compute today's local window exactly as stats does (`tzMs = q.tz * 60_000`, `dayIdx = floor((now - tzMs)/DAY)`, window `[dayIdx*DAY + tzMs, (dayIdx+1)*DAY + tzMs)`), then use the existing scoped range helpers `feedsInRange` / `diapersInRange` / `sleepsInRange` (same ones stats uses) and fold:

```ts
const today = { feeds: 0, intakeMl: 0, solidsG: 0, wet: 0, dirty: 0, both: 0, sleepMin: 0 };
for (const f of feeds) {
  today.feeds += 1;
  if (f.type === "bottle") today.intakeMl += f.amountMl ?? 0;
  if (f.type === "solids") today.solidsG += f.amountMl ?? 0;
}
for (const d of diapers) {
  if (d.type === "wet") today.wet += 1;
  else if (d.type === "dirty") today.dirty += 1;
  else today.both += 1;
}
// Sleep minutes inside today's window; active sessions count up to now —
// same midnight-splitting idea as stats, but only one bucket:
for (const s of sleeps) {
  const from = Math.max(s.startTime.getTime(), rangeFrom);
  const to = Math.min(s.endTime?.getTime() ?? Date.now(), rangeTo, Date.now());
  if (to > from) today.sleepMin += Math.round((to - from) / 60_000);
}
```

`SummarySchema` gains the `today` object (all ints, required).

- [ ] **Step 4: Client**

`useSummary`: add `tz: String(new Date().getTimezoneOffset())` to the query (mirror `useStats`). `StatusCard`: optional `sub?: string` rendered as a third line `<p className="truncate text-xs text-muted">{sub}</p>` under the bold line. `Home.tsx` cards:

- Feed: `sub={s ? `${s.today.feeds} ${t("feeds")} · ${s.today.intakeMl} ml${s.today.solidsG > 0 ? ` · ${s.today.solidsG} g` : ""} ${t("today")}` : undefined}` — massage to read naturally; reuse the existing `feeds` i18n key; add `"today": "i dag"` if missing.
- Diaper: `` `${s.today.wet} ${t("wet")} · ${s.today.dirty} ${t("dirty")} · ${s.today.both} ${t("both")}` `` (check for existing wet/dirty/both keys — the diaper sheet has chips with those labels; reuse exact keys, mind capitalization: add lowercase variants if needed).
- Sleep: `sub={`${formatDuration(s.today.sleepMin * 60_000)} ${t("today")}`}` (check `formatDuration`'s signature in `src/web/lib/time.ts` — it takes ms).

- [ ] **Step 5: Verify + commit**

Run: `pnpm vitest run test/feedback-batch.test.ts` → PASS; `pnpm check && pnpm test && pnpm build` → PASS.

```bash
git add src/worker/routes/sleep.ts src/shared/schemas.ts src/web/lib/data/logs.ts src/web/components/StatusCard.tsx src/web/screens/Home.tsx src/web/lib/i18n.ts test/feedback-batch.test.ts
git commit -m "feat(home): tz-aware today totals on the status cards" -m "Feedback batch item 11." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Custom sleep locations — CRUD + settings + sheet

**Files:**
- Create: `src/worker/routes/sleep-locations.ts`
- Modify: `src/worker/index.ts` (mount)
- Modify: `src/web/lib/data/logs.ts` or `family.ts` (hooks: `useSleepLocations`, add/delete mutations — put them in a new `src/web/lib/data/sleep-locations.ts`, re-export from `index.ts`)
- Create: `src/web/screens/settings/SleepLocationsSection.tsx`
- Modify: `src/web/screens/settings/index.tsx` (render after BabiesSection, admin-only)
- Modify: `src/web/components/sheets/SleepSheet.tsx` (chips = defaults + custom; drop `asLocation`)
- Modify: `src/web/lib/i18n.ts`
- Test: `test/feedback-batch.test.ts` (append)

**Interfaces:**
- Consumes: Task 6's `fam.listSleepLocations/createSleepLocation/deleteSleepLocation` + `SleepLocationSchema`.
- Produces: `GET /api/sleep-locations` → `SleepLocation[]`; `POST /api/sleep-locations` body `{ name: string (1-40 chars, trimmed) }` → 201, admin-only, 409 `LIMIT_REACHED` above 20, 409 `DUPLICATE` on case-insensitive name match (defaults included); `DELETE /api/sleep-locations/{id}` → `{ ok: true }`, admin-only.

- [ ] **Step 1: Failing tests**

```ts
describe("custom sleep locations", () => {
  it("member reads, only admin writes, family-scoped", async () => {
    const a = await rig();
    const created = await api("/api/sleep-locations", {
      method: "POST",
      cookie: a.cookie,
      body: { name: "Hammock" },
    });
    expect(created.status).toBe(201);

    const member = await createUser("Reader");
    await addMember(member.id, a.family.id, "member");
    const memberCookie = await signIn(member.email);
    const list = await api("/api/sleep-locations", { cookie: memberCookie });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { name: string }[]).map((l) => l.name)).toContain("Hammock");
    expect(
      (await api("/api/sleep-locations", { method: "POST", cookie: memberCookie, body: { name: "Nope" } })).status,
    ).toBe(403);

    const b = await rig("Other family");
    const otherList = (await (await api("/api/sleep-locations", { cookie: b.cookie })).json()) as unknown[];
    expect(otherList).toHaveLength(0);
  });

  it("rejects duplicates (defaults included) and enforces the cap", async () => {
    const { cookie } = await rig();
    expect(
      (await api("/api/sleep-locations", { method: "POST", cookie, body: { name: "crib" } })).status,
    ).toBe(409);
  });
});
```

(Imports: `addMember, createUser, signIn` — extend the file's import list.)

- [ ] **Step 2: Run to verify failure** (404s)

- [ ] **Step 3: Implement the routes**

`src/worker/routes/sleep-locations.ts` — OpenAPI app (FamEnv) with the three routes. Writes check `c.var.memberRole` inline (the requireAdmin middleware pattern doesn't fit a mixed-permission path prefix):

```ts
const forbid = (c: Context) =>
  c.json({ error: "Admin only", code: "FORBIDDEN" }, 403);
// in POST/DELETE handlers:
if (c.var.memberRole !== "admin" && c.var.memberRole !== "owner") return forbid(c);
```

POST validation: `name: z.string().trim().min(1).max(40)`; reject 409 `DUPLICATE` when the trimmed name case-insensitively equals `crib`/`stroller`/`arms`/`contact nap` or an existing custom row; 409 `LIMIT_REACHED` at 20 rows. Mount in `index.ts` inside the `domainApp` chain (`.route("/", sleepLocationsApp)`) — NO path-level requireAdmin (GET is for everyone).

- [ ] **Step 4: Client**

`src/web/lib/data/sleep-locations.ts`: `useSleepLocations()` (query key `["sleep-locations"]`), `useAddSleepLocation()`, `useDeleteSleepLocation()` (invalidate on success) — copy the shape of existing hooks in `lib/data/*.ts`. `SleepLocationsSection.tsx`: admin-only card (Settings renders it conditionally) listing custom locations with a delete control + an inline `Input` + Add `Button` (match `ApiKeysSection`'s visual conventions; reuse `DeleteButton` if it fits). Settings `index.tsx`: render `<SectionTitle>{t("Sleep locations")}</SectionTitle><SleepLocationsSection />` after BabiesSection when `isAdmin`.

`SleepSheet.tsx`: delete the `Location` type + `asLocation`; `location` state becomes `string | null`, seeded directly from `edit.location`/`lastLocation` (no coercion). Chips:

```tsx
const custom = useSleepLocations().data ?? [];
const options = [
  { value: "crib", label: t("Crib") },
  { value: "stroller", label: t("Stroller") },
  { value: "arms", label: t("Contact nap") },
  ...custom.map((l) => ({ value: l.name, label: l.name })),
];
// A stored value not in the list (deleted custom location, legacy data)
// still renders — append it as a transient chip:
if (location && !options.some((o) => o.value === location)) {
  options.push({ value: location, label: location });
}
```

nb entries: `"Sleep locations": "Sovesteder"`, `"Add location": "Legg til sted"`, plus whatever the section's helper copy needs.

- [ ] **Step 5: Verify + commit**

Run: `pnpm vitest run test/feedback-batch.test.ts` → PASS; `pnpm check && pnpm test && pnpm build` → PASS.

```bash
git add src/worker/routes/sleep-locations.ts src/worker/index.ts src/web/lib/data/ src/web/screens/settings/ src/web/components/sheets/SleepSheet.tsx src/web/lib/i18n.ts test/feedback-batch.test.ts
git commit -m "feat(sleep): custom sleep locations — CRUD, settings management, sheet chips" -m "Feedback batch item 13. Also removes the asLocation coercion that rewrote unknown locations to crib on edit." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Stats day view + weight-card shortcut + docs

**Files:**
- Modify: `src/web/screens/Stats.tsx` (chip row, useStats type, weight card button, OtherLogSheet)
- Modify: `src/web/lib/data/insights.ts` (`days` type widens to `1 | 7 | 30`)
- Modify: `src/web/lib/i18n.ts`
- Modify: `DECISIONS.md`

**Interfaces:**
- Consumes: server `GET /api/stats` already accepts `days=1` free (gate is `days > 7`).

- [ ] **Step 1: Day chip**

`insights.ts`: `useStats(babyId, days: 1 | 7 | 30)`. `Stats.tsx`: `useState<1 | 7 | 30>(7)`; ChipGroup options `[{ value: "1", label: t("Day") }, { value: "7", label: t("Week") }, { value: "30", label: t("Month") }]`; the premium guard stays exactly as-is for "30". Chart: `interval={days === 30 ? 4 : 0}`, `maxBarSize={days === 30 ? 8 : 28}`. Card labels become time-window-aware: `days === 1 ? t("Sleep today") : t("Sleep / day")` and same for intake (`t("Intake today")`); the sub-line stays. The stale-persisted-30 reset effect keeps working (only 30 is gated).

- [ ] **Step 2: Weight card opens the measurement sheet**

In `Stats.tsx`: render `<OtherLogSheet …/>` (import it; read how `Home.tsx`/the More flow instantiates it for the exact props — `kind="measurement"`, `open`, `onOpenChange`, `babyId`) with local `const [measureOpen, setMeasureOpen] = useState(false)`. Wrap the existing weight `Card` content in a `<button type="button" onClick={() => setMeasureOpen(true)} className="w-full text-left">` (or make the Card itself the button, matching how StatusCard does it) so tapping it opens the sheet directly.

- [ ] **Step 3: i18n + DECISIONS**

nb: `"Day": "Dag"`, `"Sleep today": "Søvn i dag"`, `"Intake today": "Inntak i dag"` (grep for existing keys first).

DECISIONS.md (match format): one entry for the batch — night-mode 20:54 was the "On" override (labeling fixed, schedule logic untouched, still device-local); grams stored in `amountMl` with unit derived from type, intake sums bottle-only everywhere; custom sleep locations stored by name in the free-text column, defaults + customs merged client-side; per-side nursing minutes in new nullable columns with `durationMin` still the total (CSV exports total only).

- [ ] **Step 4: Final verification + commit**

Run: `pnpm check && pnpm test && pnpm build` → all PASS.

```bash
git add src/web/screens/Stats.tsx src/web/lib/data/insights.ts src/web/lib/i18n.ts DECISIONS.md
git commit -m "feat(stats): day view + weight card opens measurement sheet" -m "Feedback batch items 9, 10 + batch DECISIONS entry." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
