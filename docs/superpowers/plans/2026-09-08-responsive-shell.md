# Responsive Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SPA use the width of a tablet or desktop window — rail navigation, side-panel sheets, a two/three-pane Home with the More actions unfolded — without touching the phone layout or any log sheet's internals.

**Architecture:** Three viewport tiers (compact < 768 px, regular 768–1279 px, wide ≥ 1280 px) expressed as Tailwind `md:` / `xl:` classes wherever possible. A small `lib/layout.ts` exposes the tier to the three places CSS cannot reach (the vaul drawer direction, the wide-only Recent query, the latched sheet direction). The Timeline's row rendering is extracted into `components/TimelineList.tsx` so Home's Recent pane and the Timeline tab share one implementation; the More sheet's tile list is extracted into a pure `moreActions()` so Home's unfolded action tiles and the sheet share one data source.

**Tech Stack:** React 19, Tailwind v4 (`@import "tailwindcss"`, dynamic spacing scale so `w-22` / `pl-22` / `h-32` exist), vaul 1.1.2 (`direction` prop, `Drawer.Close`), @tabler/icons-react, bun test (no DOM — components are checked via `renderToStaticMarkup` or pure functions), Playwright (Chromium; `devices["Pixel 7"]`, `devices["Galaxy Tab S4 landscape"]`, `devices["Desktop Chrome"]`).

**Spec:** `docs/superpowers/specs/2026-09-08-responsive-shell-design.md`

## Global Constraints

- Tiers by viewport width only; never user-agent, touch or pointer sniffing.
- Breakpoints are Tailwind defaults: `md` = 768 px, `xl` = 1280 px. Content capped at 1400 px.
- Touch targets never shrink: 44 px minimum stays at every tier.
- No hover-driven UI, no density mode, no master–detail.
- Every user-facing string goes through `t()`; a new literal needs a row in the `nb` dictionary in `apps/frontend/src/lib/i18n.ts` or `node scripts/check-i18n.mjs` fails (`bun run check` runs it).
- Only `components/Sheet.tsx` imports `vaul`. `components/TabBar.tsx` never imports `useTier` (the rail is CSS-only).
- Night mode keeps three actions in the bottom half; the phone keeps the More sheet.
- The account avatar stays at the right edge of the baby header at every tier; the rail is navigation-only.
- Commits: Conventional Commits, small and scoped, trailer lines
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01C4AJHps9yATdm2FPYtQMnN`.
- Work on branch `feat/responsive-shell` (already exists, holds the spec).
- Frontend commands run from `apps/frontend`: `bun test` (unit), `bun run typecheck`. Repo-root commands: `bun run check` (biome + i18n + typecheck), `bun run test`.

---

## File map

| File | Responsibility |
|---|---|
| `apps/frontend/src/lib/layout.ts` (new) | `Tier`, `tierFor(width)`, `tierFromMatches(regular, wide)`, `useTier()` |
| `apps/frontend/src/lib/hotkeys.ts` (new) | `isTypingTarget`, `hotkeyFor`, `useHotkeys` |
| `apps/frontend/src/lib/utils.ts` | add `focusRing` class constant |
| `apps/frontend/src/styles.css` | `.pb-tabbar` media query |
| `apps/frontend/src/components/TabBar.tsx` | bottom bar → left rail at `md:` (CSS only) |
| `apps/frontend/src/components/Sheet.tsx` | bottom drawer → right panel at `md:`, latched direction, close button |
| `apps/frontend/src/components/LogButton.tsx` | `className` prop, `md:` sizing |
| `apps/frontend/src/components/HomeActions.tsx` (new) | primaries + unfolded row tiles (More button at compact) |
| `apps/frontend/src/components/TimelineList.tsx` (new) | day groups, `Row`, edit-sheet dispatch — extracted from Timeline |
| `apps/frontend/src/components/HomeRecent.tsx` (new) | wide-only Recent pane on Home |
| `apps/frontend/src/components/sheets/OtherLogSheet.tsx` | export pure `moreActions()`; `MoreSheet` uses it |
| `apps/frontend/src/screens/Timeline.tsx` | keeps header/search/chips/paging; renders `TimelineList` |
| `apps/frontend/src/screens/Home.tsx` | grid layout, `HomeActions`, `HomeRecent`, hotkeys, night column anchoring |
| `apps/frontend/src/screens/shell.tsx`, `screens/admin/shell.tsx` | rail offset + 1400 px cap |
| `apps/frontend/src/screens/{Timeline,Stats,Calendar,Vaccines,Profile}.tsx`, `screens/settings/index.tsx`, `screens/admin/shell.tsx` | wider reading columns |
| `apps/frontend/src/lib/data/insights.ts` | `useTimeline(..., enabled)` |
| `apps/frontend/src/lib/i18n.ts` | `Close` key |
| `apps/frontend/vite.config.ts` | manifest `orientation: "any"` |
| `apps/frontend/test/layout.test.ts`, `test/hotkeys.test.ts`, `test/more-actions.test.ts`, `test/layout-guards.test.ts` (new) | unit tests |
| `e2e/playwright.config.ts`, `e2e/layout.spec.ts` (new) | tablet + desktop projects, layout spec |
| `DECISIONS.md`, `SMOKE-TEST.md`, `CLAUDE.md` | decisions, manual checks, IA note |

---

### Task 1: Tier detection (`lib/layout.ts`)

**Files:**
- Create: `apps/frontend/src/lib/layout.ts`
- Test: `apps/frontend/test/layout.test.ts`

**Interfaces:**
- Produces: `type Tier = "compact" | "regular" | "wide"`, `REGULAR_MIN = 768`, `WIDE_MIN = 1280`, `tierFor(width: number): Tier`, `tierFromMatches(regular: boolean, wide: boolean): Tier`, `useTier(): Tier`.

- [ ] **Step 1: Write the failing test**

`apps/frontend/test/layout.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  REGULAR_MIN,
  WIDE_MIN,
  tierFor,
  tierFromMatches,
} from "../src/lib/layout";

// The tiers are Tailwind's md (768) and xl (1280): the CSS side of the
// layout is `md:` / `xl:` classes, and everything the JS side decides
// (drawer direction, the wide-only Recent query) must agree with it to the
// pixel, or a window at exactly 768 px gets a side panel and a bottom bar.
describe("tierFor", () => {
  it("matches Tailwind's md and xl breakpoints exactly", () => {
    expect(REGULAR_MIN).toBe(768);
    expect(WIDE_MIN).toBe(1280);
    expect(tierFor(320)).toBe("compact");
    expect(tierFor(767)).toBe("compact");
    expect(tierFor(768)).toBe("regular");
    expect(tierFor(1279)).toBe("regular");
    expect(tierFor(1280)).toBe("wide");
    expect(tierFor(2560)).toBe("wide");
  });
});

describe("tierFromMatches", () => {
  it("derives the tier from the two media queries", () => {
    expect(tierFromMatches(false, false)).toBe("compact");
    expect(tierFromMatches(true, false)).toBe("regular");
    expect(tierFromMatches(true, true)).toBe("wide");
  });
  it("never reports wide without regular (a contradictory pair is regular at most)", () => {
    expect(tierFromMatches(false, true)).toBe("compact");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/frontend && bun test test/layout.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/layout'`.

- [ ] **Step 3: Write the implementation**

`apps/frontend/src/lib/layout.ts`:

```ts
import { useEffect, useState } from "react";

// Viewport tiers (spec §1). The CSS side is Tailwind's `md:` / `xl:`
// classes; this is the JS side for the three things a class cannot do —
// the vaul drawer direction, gating the wide-only Recent query, and the
// sheet's latched direction. The numbers are Tailwind's defaults and must
// stay in step with them.
export type Tier = "compact" | "regular" | "wide";

export const REGULAR_MIN = 768;
export const WIDE_MIN = 1280;

export function tierFor(width: number): Tier {
  if (width >= WIDE_MIN) return "wide";
  if (width >= REGULAR_MIN) return "regular";
  return "compact";
}

// From the two min-width media queries, so the answer agrees with the CSS
// even where innerWidth and the media-query viewport differ (scrollbars,
// zoom). A `wide` match without a `regular` match cannot happen on a sane
// engine; treat it as compact rather than trust half of a contradiction.
export function tierFromMatches(regular: boolean, wide: boolean): Tier {
  if (!regular) return "compact";
  return wide ? "wide" : "regular";
}

const REGULAR_QUERY = `(min-width: ${REGULAR_MIN}px)`;
const WIDE_QUERY = `(min-width: ${WIDE_MIN}px)`;

function currentTier(): Tier {
  if (typeof window === "undefined" || !window.matchMedia) return "compact";
  return tierFromMatches(
    window.matchMedia(REGULAR_QUERY).matches,
    window.matchMedia(WIDE_QUERY).matches,
  );
}

export function useTier(): Tier {
  const [tier, setTier] = useState<Tier>(currentTier);
  useEffect(() => {
    const queries = [
      window.matchMedia(REGULAR_QUERY),
      window.matchMedia(WIDE_QUERY),
    ];
    const apply = () => setTier(currentTier());
    apply();
    for (const q of queries) q.addEventListener("change", apply);
    return () => {
      for (const q of queries) q.removeEventListener("change", apply);
    };
  }, []);
  return tier;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/frontend && bun test test/layout.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/layout.ts apps/frontend/test/layout.test.ts
git commit -m "feat(layout): viewport tier detection (compact / regular / wide)

Phase 7 — responsive shell, spec §1."
```

---

### Task 2: Rail navigation and the shell offset

**Files:**
- Modify: `apps/frontend/src/components/TabBar.tsx`
- Modify: `apps/frontend/src/styles.css` (the `.pb-tabbar` rule)
- Modify: `apps/frontend/src/screens/shell.tsx` (the returned tree)
- Modify: `apps/frontend/src/screens/admin/shell.tsx` (the returned tree)
- Modify: `apps/frontend/src/lib/utils.ts` (add `focusRing`)
- Test: `apps/frontend/test/layout-guards.test.ts`

**Interfaces:**
- Produces: `focusRing` (string of Tailwind classes) exported from `lib/utils.ts`.

- [ ] **Step 1: Write the failing guard test**

`apps/frontend/test/layout-guards.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Structural guards for the responsive shell (spec, Testing).
//
// The side-panel behaviour lives in ONE place (components/Sheet.tsx is the
// only vaul import), and the rail is CSS-only (TabBar.tsx never reads the
// tier in JS). Both are easy to undo by accident — a second Drawer.Root
// somewhere, or a "quick" `useTier()` in the nav — so they are checked here
// the way contrast.test.ts checks the palette.
const SRC = join(import.meta.dir, "..", "src");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

describe("responsive shell guards", () => {
  it("only components/Sheet.tsx imports vaul", () => {
    const importers = [...walk(SRC)]
      .filter((p) => /from\s+["']vaul["']/.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(SRC.length + 1));
    expect(importers).toEqual(["components/Sheet.tsx"]);
  });

  it("the tab bar / rail is CSS-only (no useTier in TabBar.tsx)", () => {
    const src = readFileSync(join(SRC, "components", "TabBar.tsx"), "utf8");
    expect(src).not.toContain("useTier");
    // The rail exists: the nav carries md: classes that move it to the left.
    expect(src).toContain("md:left-0");
    expect(src).toContain("md:flex-col");
  });

  it(".pb-tabbar stops clearing the bottom bar at md and up", () => {
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    expect(css).toMatch(
      /@media \(min-width: 768px\)\s*\{\s*\.pb-tabbar\s*\{\s*padding-bottom: 1\.5rem;\s*\}\s*\}/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/frontend && bun test test/layout-guards.test.ts`
Expected: FAIL on the second and third tests (`md:left-0` missing, no media query). The first passes already — keep it, it is the guard.

- [ ] **Step 3: Add the focus-ring constant**

In `apps/frontend/src/lib/utils.ts`, append:

```ts
// Visible keyboard focus (spec §6). A shared string rather than a
// component so the log buttons, rail items, chips and steppers all get the
// same ring; Tailwind sees the literal here and emits the classes once.
export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
```

- [ ] **Step 4: Turn the tab bar into a rail at md**

Replace the returned JSX in `apps/frontend/src/components/TabBar.tsx` with:

```tsx
  return (
    // Compact: the fixed bottom bar. md and up: the SAME nav becomes a fixed
    // 88 px left rail (spec §2) — pure CSS, no second markup path, so the
    // admin shell's own tab list gets the rail for free.
    <nav
      aria-label={t("Main")}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-safe backdrop-blur md:inset-x-auto md:top-0 md:bottom-0 md:left-0 md:w-22 md:border-t-0 md:border-r md:pt-4 md:pb-0"
    >
      <div className="mx-auto flex max-w-md md:mx-0 md:max-w-none md:flex-col">
        {tabs.map(({ to, label, icon: Icon, exact }) => {
          const active = exact
            ? pathname === to || pathname === `${to}/`
            : pathname.startsWith(to);
          return (
            <Link
              key={to}
              to={to}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-16 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-semibold md:h-18 md:w-22 md:flex-none",
                focusRing,
                active ? "text-accent" : "text-muted",
              )}
            >
              <Icon className="h-6 w-6" stroke={active ? 2.4 : 2} />
              {t(label)}
            </Link>
          );
        })}
      </div>
    </nav>
  );
```

Update the import line to `import { cn, focusRing } from "@/lib/utils";`.

Add the dictionary row in `apps/frontend/src/lib/i18n.ts`, inside the `nb` object next to `Account: "Konto",`:

```ts
  Main: "Hoved",
```

- [ ] **Step 5: The tab-bar clearance and the shell offset**

In `apps/frontend/src/styles.css`, replace the `.pb-tabbar` rule with:

```css
.pb-tabbar {
  padding-bottom: calc(4.25rem + env(safe-area-inset-bottom));
}
/* md and up: the tab bar is a left rail (components/TabBar.tsx), so there
   is nothing at the bottom to clear. One rule here rather than 22 call
   sites. */
@media (min-width: 768px) {
  .pb-tabbar {
    padding-bottom: 1.5rem;
  }
}
```

In `apps/frontend/src/screens/shell.tsx`, replace the final `return (...)` with:

```tsx
  return (
    <div className="min-h-dvh">
      {impersonatedBy && (
        <div className="flex items-center justify-between gap-3 bg-danger px-4 py-2 pt-safe text-sm font-semibold text-white">
          <span>Impersonating {name}</span>
          <button
            type="button"
            className="rounded-full bg-white/20 px-3 py-1"
            onClick={() => void stopImpersonating()}
          >
            Stop
          </button>
        </div>
      )}
      <AppBadge />
      {/* md and up: clear the 88 px rail and cap the content at 1400 px
          (spec §1–2). Screens keep their own max-w inside this. */}
      <div className="md:pl-22">
        <div className="mx-auto max-w-[1400px]">
          <Outlet />
        </div>
      </div>
      <TabBar />
    </div>
  );
```

In `apps/frontend/src/screens/admin/shell.tsx`, replace the returned tree with:

```tsx
  return (
    <div className="min-h-dvh">
      <div className="md:pl-22">
        <div className="mx-auto max-w-xl px-4 pt-safe md:max-w-3xl">
          <header className="flex items-center gap-3 py-4">
            <Link to="/settings" className="text-muted" title="Back to app">
              <IconArrowLeft className="h-6 w-6" />
            </Link>
            <IconShieldCog className="h-6 w-6 text-accent" />
            <h1 className="text-2xl font-extrabold text-ink">Admin</h1>
          </header>
          <div className="pb-tabbar">
            <Outlet />
          </div>
        </div>
      </div>
      <TabBar tabs={adminTabs} />
    </div>
  );
```

- [ ] **Step 6: Run the guard test and typecheck**

Run: `cd apps/frontend && bun test test/layout-guards.test.ts && bun run typecheck`
Expected: PASS (3 tests), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/components/TabBar.tsx apps/frontend/src/styles.css apps/frontend/src/screens/shell.tsx apps/frontend/src/screens/admin/shell.tsx apps/frontend/src/lib/utils.ts apps/frontend/src/lib/i18n.ts apps/frontend/test/layout-guards.test.ts
git commit -m "feat(layout): tab bar becomes a left rail at md, shell clears it

CSS only — one nav, one media query for .pb-tabbar. Spec §2."
```

---

### Task 3: Wider reading columns on the other screens

**Files:**
- Modify: `apps/frontend/src/screens/Timeline.tsx` (root div, currently `mx-auto max-w-md px-4 pt-safe`)
- Modify: `apps/frontend/src/screens/Stats.tsx` (root div)
- Modify: `apps/frontend/src/screens/Calendar.tsx` (root div)
- Modify: `apps/frontend/src/screens/Vaccines.tsx` (root div)
- Modify: `apps/frontend/src/screens/Profile.tsx` (root div)
- Modify: `apps/frontend/src/screens/settings/index.tsx` (root div)

Each screen's root `<div className="mx-auto max-w-md px-4 pt-safe">` gains one `md:` class (spec §5). Login, Welcome, Join and the error screen are untouched.

- [ ] **Step 1: Apply the widths**

| File | Root div className |
|---|---|
| `screens/Timeline.tsx` | `mx-auto max-w-md px-4 pt-safe md:max-w-2xl md:px-6` |
| `screens/Stats.tsx` | `mx-auto max-w-md px-4 pt-safe md:max-w-3xl md:px-6` |
| `screens/Calendar.tsx` | `mx-auto max-w-md px-4 pt-safe md:max-w-3xl md:px-6` |
| `screens/Vaccines.tsx` | `mx-auto max-w-md px-4 pt-safe md:max-w-lg md:px-6` |
| `screens/Profile.tsx` | `mx-auto max-w-md px-4 pt-safe md:max-w-lg md:px-6` |
| `screens/settings/index.tsx` | `mx-auto max-w-md px-4 pt-safe md:max-w-lg md:px-6` |

Use `grep -n 'className="mx-auto max-w-md px-4 pt-safe"' apps/frontend/src/screens/*.tsx apps/frontend/src/screens/settings/index.tsx` to find each line; there is exactly one per file listed (Home.tsx also matches — leave Home for Task 6).

- [ ] **Step 2: Typecheck and lint**

Run: `bun run check`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/screens
git commit -m "feat(layout): wider reading columns at md on Timeline, Stats, Calendar, Settings, Profile, Vaccines

Width only, no layout change. Spec §5."
```

---

### Task 4: Sheets become a right side panel at md, direction latched at open

**Files:**
- Modify: `apps/frontend/src/components/Sheet.tsx` (whole file)
- Modify: `apps/frontend/src/lib/i18n.ts` (add `Close`)
- Test: `apps/frontend/test/sheet.test.tsx`

**Interfaces:**
- Consumes: `useTier` from Task 1.
- Produces: `Sheet` keeps its props (`open`, `onOpenChange`, `title`, `children`); the drawer content carries `data-direction="bottom" | "right"` (the e2e spec reads it).
- Exports `directionFor(tier: Tier): "bottom" | "right"` for the unit test.

- [ ] **Step 1: Write the failing test**

`apps/frontend/test/sheet.test.tsx`:

```ts
import { describe, expect, it } from "bun:test";
import { directionFor } from "../src/components/Sheet";

// The render itself needs a DOM (vaul is a Radix dialog with portals), so
// the panel is exercised by e2e/layout.spec.ts. What can be pinned here is
// the tier → direction rule (spec §3): a bottom drawer on the phone, a right
// panel from md up.
describe("Sheet direction", () => {
  it("is a bottom drawer only at compact", () => {
    expect(directionFor("compact")).toBe("bottom");
    expect(directionFor("regular")).toBe("right");
    expect(directionFor("wide")).toBe("right");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/frontend && bun test test/sheet.test.tsx`
Expected: FAIL — `directionFor` is not exported.

- [ ] **Step 3: Rewrite Sheet.tsx**

```tsx
import { IconX } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { Drawer } from "vaul";
import { t } from "@/lib/i18n";
import { type Tier, useTier } from "@/lib/layout";
import { cn, focusRing } from "@/lib/utils";

// The one vaul import in the app (test/layout-guards.test.ts).
//
// Compact: a bottom sheet, Save at the very bottom inside the safe area —
// reachable with a thumb, one-handed. md and up (spec §3): the SAME sheet
// as a 420 px panel on the right edge, full height. Every sheet was laid
// out for max-w-md minus padding, so nothing inside changes; only the edge
// it comes from.

export type SheetDirection = "bottom" | "right";

export function directionFor(tier: Tier): SheetDirection {
  return tier === "compact" ? "bottom" : "right";
}

export function Sheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  const wanted = directionFor(useTier());
  // Latched at open: changing vaul's `direction` on an open drawer
  // re-animates it and can remount the content, which would throw away a
  // half-filled feed when a window is resized across 768 px (the same
  // hazard Home guards for the 22:00 night flip). The tier is read when the
  // sheet opens and kept until it closes; the next open uses the new tier.
  const [direction, setDirection] = useState<SheetDirection>(wanted);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDirection(wanted);
  }
  const side = direction === "right";

  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      repositionInputs={false}
      direction={direction}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Drawer.Content
          data-direction={direction}
          className={cn(
            "fixed z-50 flex flex-col bg-bg outline-none",
            side
              ? "inset-y-0 right-0 w-[420px] max-w-full rounded-l-3xl"
              : "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-3xl",
          )}
        >
          {side ? (
            // A side panel has no swipe-down cue, so it gets a close
            // button; Escape and the scrim close it too.
            <div className="flex items-center justify-between pt-5 pr-3 pb-1 pl-5">
              <Drawer.Title className="text-lg font-bold text-ink">
                {title}
              </Drawer.Title>
              <Drawer.Close
                aria-label={t("Close")}
                className={cn(
                  "flex h-11 w-11 items-center justify-center rounded-full text-ink-soft active:bg-surface-2",
                  focusRing,
                )}
              >
                <IconX className="h-5 w-5" />
              </Drawer.Close>
            </div>
          ) : (
            <>
              <div className="mx-auto mt-3 h-1.5 w-10 shrink-0 rounded-full bg-line" />
              <Drawer.Title className="px-5 pt-3 pb-1 text-lg font-bold text-ink">
                {title}
              </Drawer.Title>
            </>
          )}
          <div className="flex-1 overflow-y-auto px-5 pb-safe">{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
```

Add to the `nb` dictionary in `apps/frontend/src/lib/i18n.ts` (next to `Account: "Konto",`):

```ts
  Close: "Lukk",
```

- [ ] **Step 4: Run tests, typecheck, i18n check**

Run: `cd apps/frontend && bun test && bun run typecheck && cd ../.. && node scripts/check-i18n.mjs`
Expected: all PASS, `i18n ok`.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/Sheet.tsx apps/frontend/src/lib/i18n.ts apps/frontend/test/sheet.test.tsx
git commit -m "feat(layout): sheets open as a 420 px right panel at md, direction latched at open

One component for all seventeen sheets. Spec §3."
```

---

### Task 5: The More sheet's actions as a shared, pure list

**Files:**
- Modify: `apps/frontend/src/components/sheets/OtherLogSheet.tsx` (the `MoreSheet` function, lines ~72–160)
- Test: `apps/frontend/test/more-actions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MoreAction = { key: string; label: string; icon: TablerIcon; tint: string; pick: () => void };
  export type MoreHandlers = { onPick: (kind: OtherKind) => void; onPickPlay: (type: PlayType) => void; onPickHelp: () => void; onVaccines: () => void };
  export function moreActions(h: MoreHandlers): MoreAction[];
  ```
  Home's unfolded tiles (Task 6) and `MoreSheet` both render this list.

- [ ] **Step 1: Write the failing test**

`apps/frontend/test/more-actions.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { moreActions } from "../src/components/sheets/OtherLogSheet";

// One data source for the More sheet (phone) and Home's unfolded tiles
// (tablet, desktop — spec §4): a new activity kind must show up in both
// without a second edit, and in the same order.
describe("moreActions", () => {
  const calls: string[] = [];
  const actions = moreActions({
    onPick: (kind) => calls.push(`pick:${kind}`),
    onPickPlay: (type) => calls.push(`play:${type}`),
    onPickHelp: () => calls.push("help"),
    onVaccines: () => calls.push("vaccines"),
  });

  it("lists the six kinds, the three play types, vaccines and help, in that order", () => {
    expect(actions.map((a) => a.key)).toEqual([
      "medicine",
      "bath",
      "note",
      "milestone",
      "measurement",
      "pump",
      "play:tummy",
      "play:walk",
      "play:play",
      "vaccines",
      "help",
    ]);
  });

  it("routes each pick to the right handler", () => {
    calls.length = 0;
    for (const a of actions) a.pick();
    expect(calls).toEqual([
      "pick:medicine",
      "pick:bath",
      "pick:note",
      "pick:milestone",
      "pick:measurement",
      "pick:pump",
      "play:tummy",
      "play:walk",
      "play:play",
      "vaccines",
      "help",
    ]);
  });

  it("carries a label, icon and tint for every tile", () => {
    for (const a of actions) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(typeof a.icon).toBe("object");
      expect(a.tint.startsWith("text-")).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/frontend && bun test test/more-actions.test.ts`
Expected: FAIL — `moreActions` is not exported.

- [ ] **Step 3: Extract the list**

In `apps/frontend/src/components/sheets/OtherLogSheet.tsx`, immediately above `export function MoreSheet(`, add:

```tsx
export type MoreAction = {
  key: string;
  label: string;
  icon: TablerIcon;
  tint: string;
  pick: () => void;
};

export type MoreHandlers = {
  onPick: (kind: OtherKind) => void;
  onPickPlay: (type: PlayType) => void;
  onPickHelp: () => void;
  onVaccines: () => void;
};

// The "More" actions, in display order: the six generic kinds, the three
// play kinds (timed sessions with their own endpoints, so they sit beside
// the generic kinds rather than inside otherKindMeta), the vaccines
// screen, and asking another caretaker for help. ONE list, rendered by the
// phone's More sheet below and by Home's unfolded tiles at md and up
// (components/HomeActions.tsx) — test/more-actions.test.ts pins the order.
export function moreActions(h: MoreHandlers): MoreAction[] {
  return [
    ...(Object.keys(otherKindMeta) as OtherKind[]).map((kind) => ({
      key: kind,
      ...otherKindMeta[kind],
      pick: () => h.onPick(kind),
    })),
    ...playTypeOrder.map((type) => ({
      key: `play:${type}`,
      ...playKindMeta[type],
      pick: () => h.onPickPlay(type),
    })),
    // Vaccines open a screen, not a sheet — the programme schedule needs
    // more room than a tray.
    {
      key: "vaccines",
      label: "Vaccines",
      icon: IconVaccine,
      tint: "text-growth",
      pick: h.onVaccines,
    },
    // Not a log at all — a ping to another caretaker. Lives here because
    // More is the one place every extra action is reachable from.
    {
      key: "help",
      label: "Ask for help",
      icon: IconHandStop,
      tint: "text-danger",
      pick: h.onPickHelp,
    },
  ];
}
```

Then inside `MoreSheet`, delete the local `const tiles: {...}[] = [ ... ];` block (everything from `// Play kinds are timed sessions` through the closing `];`) and replace it with:

```tsx
  const tiles = moreActions({
    onPick,
    onPickPlay,
    onPickHelp,
    onVaccines: () => {
      onOpenChange(false);
      void navigate({ to: "/vaccines" });
    },
  });
```

The JSX below it (`tiles.map(({ key, label, icon: Icon, tint, pick }) => ...`) is unchanged.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd apps/frontend && bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/sheets/OtherLogSheet.tsx apps/frontend/test/more-actions.test.ts
git commit -m "refactor(more): the More sheet's tiles as a pure, shared moreActions() list"
```

---

### Task 6: Home — two/three panes, primaries + unfolded actions, night column

**Files:**
- Modify: `apps/frontend/src/components/LogButton.tsx` (whole file)
- Create: `apps/frontend/src/components/HomeActions.tsx`
- Modify: `apps/frontend/src/screens/Home.tsx` (the day-mode return tree, the `NightHome` root div)
- Test: `apps/frontend/test/home-actions.test.tsx`

**Interfaces:**
- Consumes: `moreActions`, `MoreAction`, `MoreHandlers` (Task 5); `focusRing` (Task 2).
- Produces: `HomeActions` component:
  ```tsx
  <HomeActions active={boolean} onFeed={() => void} onDiaper={() => void} onSleep={() => void} onMore={() => void} actions={MoreAction[]} />
  ```
  `LogButton` gains `className?: string`.

- [ ] **Step 1: Write the failing test**

`apps/frontend/test/home-actions.test.tsx`:

```tsx
import { describe, expect, it } from "bun:test";
import { IconPill } from "@tabler/icons-react";
import { renderToStaticMarkup } from "react-dom/server";
import { HomeActions } from "../src/components/HomeActions";

// No DOM here (see router.test.ts): the markup is checked statically. The
// tier is CSS — the More button is `md:hidden`, the unfolded tiles are
// `hidden md:...` — so both are always in the markup and what changes is
// which one the viewport shows (e2e/layout.spec.ts checks that).
const noop = () => {};
const actions = [
  { key: "medicine", label: "Medicine", icon: IconPill, tint: "text-growth", pick: noop },
  { key: "help", label: "Ask for help", icon: IconPill, tint: "text-danger", pick: noop },
];

describe("HomeActions", () => {
  const html = renderToStaticMarkup(
    <HomeActions
      active={false}
      onFeed={noop}
      onDiaper={noop}
      onSleep={noop}
      onMore={noop}
      actions={actions}
    />,
  );

  it("renders the three primaries and a More button hidden from md up", () => {
    expect(html).toContain(">Feed<");
    expect(html).toContain(">Diaper<");
    expect(html).toContain(">Sleep<");
    expect(html).toMatch(/md:hidden[^>]*>[\s\S]*?>More</);
  });

  it("renders every action as a row tile under a 'Log something' label, hidden below md", () => {
    expect(html).toContain("Log something");
    expect(html).toContain(">Medicine<");
    expect(html).toContain(">Ask for help<");
    expect(html).toContain('data-testid="home-actions-unfolded"');
    expect(html).toMatch(/data-testid="home-actions-unfolded"[^>]*class="[^"]*\bhidden\b[^"]*md:flex/);
  });

  it("disables Sleep while a session runs", () => {
    const running = renderToStaticMarkup(
      <HomeActions active onFeed={noop} onDiaper={noop} onSleep={noop} onMore={noop} actions={[]} />,
    );
    expect(running).toContain(">Sleeping…<");
    expect(running).toMatch(/disabled=""[^>]*>[\s\S]*?>Sleeping…</);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/frontend && bun test test/home-actions.test.tsx`
Expected: FAIL — `Cannot find module '../src/components/HomeActions'`.

- [ ] **Step 3: LogButton grows at md and accepts a className**

Replace `apps/frontend/src/components/LogButton.tsx` with:

```tsx
import type { Icon as TablerIcon } from "@tabler/icons-react";
import { cn, focusRing } from "@/lib/utils";

// The big log buttons: the whole point of the home screen. h-28 on the
// phone; h-32 with a bigger disc and label from md up (spec §4) — big
// screens get bigger targets, not more of them.
export function LogButton({
  icon: Icon,
  label,
  tintClass,
  onClick,
  disabled,
  className,
}: {
  icon: TablerIcon;
  label: string;
  tintClass: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-28 flex-col items-center justify-center gap-2 rounded-xl2 border border-line bg-surface select-none active:scale-[0.97] active:bg-surface-2 disabled:opacity-40 md:h-32",
        focusRing,
        className,
      )}
    >
      <span
        className={cn(
          "flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 md:h-14 md:w-14",
          tintClass,
        )}
      >
        <Icon className="h-6 w-6 md:h-7 md:w-7" />
      </span>
      <span className="text-base font-bold text-ink md:text-lg">{label}</span>
    </button>
  );
}
```

- [ ] **Step 4: Create HomeActions**

`apps/frontend/src/components/HomeActions.tsx`:

```tsx
import {
  IconBabyBottle,
  IconDiaper,
  IconMoon,
  IconPlus,
} from "@tabler/icons-react";
import { LogButton } from "@/components/LogButton";
import type { MoreAction } from "@/components/sheets/OtherLogSheet";
import { t } from "@/lib/i18n";
import { cn, focusRing } from "@/lib/utils";

// Home's action column (spec §4).
//
// Compact: the 2×2 grid — Feed, Diaper, Sleep, More — exactly as before.
// md and up: More disappears; the three primaries become a row, and the
// eleven More-sheet actions unfold beneath them as 44 px row tiles, two
// across, under the sheet's own "Log something" title. Smaller and lighter
// than the primaries on purpose, so the hierarchy stays: three big things,
// then a list. Both forms are in the markup; the tier is CSS.
export function HomeActions({
  active,
  onFeed,
  onDiaper,
  onSleep,
  onMore,
  actions,
}: {
  active: boolean;
  onFeed: () => void;
  onDiaper: () => void;
  onSleep: () => void;
  onMore: () => void;
  actions: MoreAction[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <LogButton
          icon={IconBabyBottle}
          label={t("Feed")}
          tintClass="text-feed"
          onClick={onFeed}
        />
        <LogButton
          icon={IconDiaper}
          label={t("Diaper")}
          tintClass="text-diaper"
          onClick={onDiaper}
        />
        <LogButton
          icon={IconMoon}
          label={active ? t("Sleeping…") : t("Sleep")}
          tintClass="text-sleep"
          onClick={onSleep}
          disabled={active}
        />
        <LogButton
          icon={IconPlus}
          label={t("More")}
          tintClass="text-growth"
          onClick={onMore}
          className="md:hidden"
        />
      </div>
      <div
        data-testid="home-actions-unfolded"
        className="hidden md:flex md:flex-col md:gap-2 md:pt-2"
      >
        <p className="px-1 text-xs font-semibold tracking-wide text-muted uppercase">
          {t("Log something")}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {actions.map(({ key, label, icon: Icon, tint, pick }) => (
            <button
              key={key}
              type="button"
              onClick={pick}
              className={cn(
                "flex h-11 items-center gap-2.5 rounded-full border border-line bg-surface pr-3.5 pl-1.5 text-left text-sm font-semibold text-ink select-none active:scale-[0.97] active:bg-surface-2",
                focusRing,
              )}
            >
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2",
                  tint,
                )}
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="truncate">{t(label)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the unit test**

Run: `cd apps/frontend && bun test test/home-actions.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Rework Home's day-mode tree**

In `apps/frontend/src/screens/Home.tsx`:

1. Change the imports: remove `IconBabyBottle`'s siblings that become unused — after this task Home still uses `IconBabyBottle`, `IconBabyCarriage`, `IconDiaper`, `IconMoon`, `IconTemperature` (the status cards and NightHome) but no longer `IconPlus`; remove `IconPlus` and the `LogButton` import. Add:
   ```tsx
   import { HomeActions } from "@/components/HomeActions";
   import { moreActions } from "@/components/sheets/OtherLogSheet";
   ```
   (`MoreSheet, OtherLogSheet` stay imported from the same module.)

2. Inside `HomeScreen`, after `const queryClient = useQueryClient();`, add:
   ```tsx
   // The unfolded tiles at md and up (components/HomeActions.tsx) — the
   // same list the More sheet renders on the phone, with the same handlers.
   const actions = moreActions({
     onPick: (kind) => {
       setOtherKind(kind);
       setPumpStop(false);
       setMeasurementType("weight");
       setSheet("other");
     },
     onPickPlay: (type) => {
       setPlayType(type);
       setSheet("play");
     },
     onPickHelp: () => setSheet("help"),
     onVaccines: () => void navigate({ to: "/vaccines" }),
   });
   ```

3. Replace the day-mode `return (` tree, from `<div className="mx-auto max-w-md px-4 pt-safe">` down to (and including) the closing `</div>` before `);`, with:

```tsx
    // Compact: one column, exactly as before. md: two panes — status on
    // the left, actions on the right edge, the edge the side panel opens
    // from, so the cards stay readable beside an open sheet ("left informs,
    // right acts", spec §4). xl: a third pane, Recent, in the middle.
    <div className="mx-auto max-w-md px-4 pt-safe md:grid md:max-w-none md:grid-cols-[minmax(0,1fr)_minmax(320px,440px)] md:items-start md:gap-6 md:px-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_440px] xl:px-8">
      <div className="min-w-0">
        {/* Baby header */}
        <header className="flex items-center justify-between py-4">
          <BabySwitcher />
          <button
            type="button"
            aria-label={t("Account")}
            onClick={() => setSheet("account")}
            className={cn("rounded-full active:scale-95", focusRing)}
          >
            <Avatar
              src={me.data?.avatarUrl}
              name={me.data?.displayName ?? "?"}
              size={11}
            />
          </button>
        </header>

        <div className="space-y-3">
          {/* Below the baby header, above everything else: a call for help is
              the first thing to see, but it must not displace whose home this
              is. */}
          {openHelp && <HelpCard request={openHelp} />}
          {active && (
            <ActiveSleepBanner
              session={active}
              onEdit={(session) => {
                setEditSleep(session);
                setSheet("sleep-edit");
              }}
            />
          )}
          {activePlay && <ActivePlayBanner session={activePlay} />}
          {activeFeed && (
            <ActiveFeedBanner
              timer={activeFeed}
              onOpen={() => setSheet("feed")}
            />
          )}
          {activePump && (
            <ActivePumpBanner
              timer={activePump}
              onStop={() => {
                setOtherKind("pump");
                setPumpStop(true);
                setSheet("other");
              }}
            />
          )}

          {/* Status before action: last feed / last diaper at a glance */}
          <div className="grid grid-cols-1 gap-3">
            <StatusCard
              icon={IconBabyBottle}
              label={t("Last feed")}
              time={s?.lastFeed ? new Date(s.lastFeed.time) : null}
              detail={s?.lastFeed ? feedDetail(s.lastFeed, units) : undefined}
              sub={
                s
                  ? `${s.today.feeds} ${t("feeds")} · ${formatVolume(s.today.intakeMl, units)}${
                      s.today.solidsG > 0 ? ` · ${s.today.solidsG} g` : ""
                    } ${t("today")}`
                  : undefined
              }
              tintClass="text-feed"
              onClick={() => setSheet("feed")}
            />
            <StatusCard
              icon={IconDiaper}
              label={t("Last diaper")}
              time={s?.lastDiaper ? new Date(s.lastDiaper.time) : null}
              detail={s?.lastDiaper ? t(s.lastDiaper.type) : undefined}
              sub={
                s
                  ? `${s.today.wet} ${t("wet")} · ${s.today.dirty} ${t("dirty")} · ${s.today.both} ${t("both")}${s.today.dry > 0 ? ` · ${s.today.dry} ${t("dry")}` : ""}`
                  : undefined
              }
              tintClass="text-diaper"
              onClick={() => setSheet("diaper")}
            />
            {/* The wake window, not "last sleep N ago": the same instant read
                as a duration, because how long she has been up is what decides
                whether the next nap is due. The last sleep's length rides
                along as the detail. */}
            {!active && s?.lastSleep?.endTime && (
              <StatusCard
                icon={IconMoon}
                label={t("Awake")}
                time={new Date(s.lastSleep.endTime)}
                format={formatElapsed}
                detail={`${formatDuration(
                  new Date(s.lastSleep.endTime).getTime() -
                    new Date(s.lastSleep.startTime).getTime(),
                )} ${t("nap")}`}
                sub={`${s.today.sleeps} ${s.today.sleeps === 1 ? t("nap") : t("naps")} · ${formatDuration(s.today.sleepMin * 60_000)} ${t("today")}`}
                note={nap ? describeNapWindow(nap) : undefined}
                tintClass="text-sleep"
                onClick={() => setSheet("sleep")}
              />
            )}
            {/* Only while it is still a live question — see
                showsTemperatureCard. A fever takes the danger tint so it reads
                at a glance, which is the whole reason the card exists. */}
            {s?.lastTemperature &&
              showsTemperatureCard(new Date(s.lastTemperature.time)) && (
                <StatusCard
                  icon={IconTemperature}
                  label={t("Last temperature")}
                  time={new Date(s.lastTemperature.time)}
                  detail={`${formatMeasurementIn(
                    s.lastTemperature.type,
                    s.lastTemperature.value,
                    units,
                  )} ${TREND_ARROW[tempTrend]}`}
                  sub={
                    tempStatus === "ok" ? undefined : t(TREND_LABEL[tempTrend])
                  }
                  tintClass={STATUS_TINT[tempStatus]}
                  accessory={
                    <span className={STATUS_TINT[tempStatus]}>
                      <TemperatureSparkline rows={measurementRows} />
                    </span>
                  }
                  onClick={() => {
                    setOtherKind("measurement");
                    setMeasurementType("temperature");
                    setSheet("other");
                  }}
                />
              )}
          </div>
        </div>
      </div>

      {/* xl only: today's log beside the actions (Task 7 fills this in). */}
      <HomeRecent babyId={baby.id} />

      {/* Primaries (+ More on the phone; the unfolded tiles from md up).
          pb-tabbar clears the bottom bar on the phone and is 1.5rem from md
          (styles.css). */}
      <div className="pt-4 pb-tabbar md:sticky md:top-0 md:pt-6">
        <HomeActions
          active={!!active}
          onFeed={() => setSheet("feed")}
          onDiaper={() => setSheet("diaper")}
          onSleep={() => setSheet("sleep")}
          onMore={() => {
            prefetchOtherLists(queryClient, baby.id);
            setSheet("more");
          }}
          actions={actions}
        />
      </div>

      <FeedSheet
        open={sheet === "feed"}
        onOpenChange={(o) => setSheet(o ? "feed" : null)}
        babyId={baby.id}
        recentFeeds={feeds.data ?? []}
        activeFeed={activeFeed}
      />
      <DiaperSheet
        open={sheet === "diaper"}
        onOpenChange={(o) => setSheet(o ? "diaper" : null)}
        babyId={baby.id}
        lastDiaper={s?.lastDiaper ?? null}
      />
      <SleepSheet
        open={sheet === "sleep" || sheet === "sleep-edit"}
        onOpenChange={(o) => {
          if (!o) setSheet(null);
        }}
        babyId={baby.id}
        lastLocation={s?.lastSleep?.location ?? null}
        edit={sheet === "sleep-edit" ? editSleep : null}
      />
      <MoreSheet
        open={sheet === "more"}
        onOpenChange={(o) => setSheet(o ? "more" : null)}
        onPick={(kind) => {
          setOtherKind(kind);
          setPumpStop(false);
          // Reset: the temperature card sets this, and without clearing it
          // here the More picker would keep opening on temperature ever after.
          setMeasurementType("weight");
          setSheet("other");
        }}
        onPickPlay={(type) => {
          setPlayType(type);
          setSheet("play");
        }}
        onPickHelp={() => setSheet("help")}
      />
      <OtherLogSheet
        open={sheet === "other"}
        onOpenChange={(o) => setSheet(o ? "other" : null)}
        babyId={baby.id}
        kind={otherKind}
        initialMeasurementType={measurementType}
        activePump={activePump}
        stopTimer={pumpStop}
      />
      <PlaySheet
        open={sheet === "play"}
        onOpenChange={(o) => setSheet(o ? "play" : null)}
        babyId={baby.id}
        type={playType}
      />
      <HelpSheet
        open={sheet === "help"}
        onOpenChange={(o) => setSheet(o ? "help" : null)}
      />
      <AccountSheet
        open={sheet === "account"}
        onOpenChange={(o) => setSheet(o ? "account" : null)}
      />

      {/* Day-mode Home only: night mode is three actions and nothing else. */}
      <InstallBanner />
    </div>
```

   Until Task 7 lands, add a temporary stub at the bottom of Home.tsx so the file compiles — Task 7 replaces it with the real import:
   ```tsx
   // Replaced by components/HomeRecent.tsx in the next task.
   function HomeRecent(_props: { babyId: string }) {
     return null;
   }
   ```
   Add `import { cn, focusRing } from "@/lib/utils";` to the imports.

4. In `NightHome`, change the root div's className from
   `"mx-auto flex min-h-dvh max-w-md flex-col justify-end px-4 pb-tabbar"` to
   `"mx-auto flex min-h-dvh max-w-md flex-col justify-end px-4 pb-tabbar md:mr-0 md:ml-auto md:px-6"`
   with the comment above it:
   ```tsx
   // md and up: the same phone-width column, anchored bottom-right — "right
   // acts", and never three 1000 px buttons across a tablet (spec §4).
   ```

- [ ] **Step 7: Typecheck, lint, all unit tests**

Run: `bun run check && cd apps/frontend && bun test`
Expected: clean and PASS. Biome may reorder imports — run `bun run lint:fix` from the repo root if it complains, then re-run.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/components/LogButton.tsx apps/frontend/src/components/HomeActions.tsx apps/frontend/src/screens/Home.tsx apps/frontend/test/home-actions.test.tsx
git commit -m "feat(home): two-pane layout at md with the More actions unfolded as row tiles

Left informs, right acts. Night home anchors bottom-right. Spec §4."
```

---

### Task 7: TimelineList extraction and Home's Recent pane

**Files:**
- Create: `apps/frontend/src/components/TimelineList.tsx`
- Modify: `apps/frontend/src/screens/Timeline.tsx`
- Modify: `apps/frontend/src/lib/data/insights.ts` (`useTimeline`)
- Create: `apps/frontend/src/components/HomeRecent.tsx`
- Modify: `apps/frontend/src/screens/Home.tsx` (drop the stub, import the real one)
- Test: `apps/frontend/test/timeline-list.test.ts`

**Interfaces:**
- Produces:
  ```tsx
  export function TimelineList({ babyId, entries }: { babyId: string | undefined; entries: TimelineEntry[] }): JSX.Element;
  export function groupByDay(entries: TimelineEntry[]): { key: string; date: Date; entries: TimelineEntry[] }[];
  export function daySummary(entries: TimelineEntry[]): string;
  ```
  `useTimeline(babyId, filter, q = "", enabled = true)`.

- [ ] **Step 1: Write the failing test**

`apps/frontend/test/timeline-list.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { TimelineEntry } from "@pjokk/shared";
import { daySummary, groupByDay } from "../src/components/TimelineList";

// The grouping and the day line used to be private to the Timeline screen;
// Home's Recent pane (spec §4) renders the same list, so they moved to the
// shared component and get pinned here.
const feed = (time: string): TimelineEntry =>
  ({
    kind: "feed",
    id: `f-${time}`,
    time,
    type: "bottle",
    amountMl: 100,
    side: null,
    durationMin: null,
    contents: null,
    food: null,
    reaction: null,
    notes: null,
    caretakerId: "u1",
    caretakerName: "Anders",
  }) as unknown as TimelineEntry;
const sleep = (startTime: string, endTime: string | null): TimelineEntry =>
  ({
    kind: "sleep",
    id: `s-${startTime}`,
    startTime,
    endTime,
    location: null,
    type: "nap",
    notes: null,
    caretakerId: "u1",
    caretakerName: "Anders",
  }) as unknown as TimelineEntry;

describe("groupByDay", () => {
  it("groups consecutive entries by local day, sessions by their start", () => {
    const groups = groupByDay([
      feed("2026-09-08T12:48:00"),
      sleep("2026-09-08T10:52:00", "2026-09-08T11:37:00"),
      feed("2026-09-07T21:45:00"),
    ]);
    expect(groups.map((g) => g.entries.length)).toEqual([2, 1]);
    expect(groups[0]!.date.getDate()).toBe(8);
    expect(groups[1]!.date.getDate()).toBe(7);
  });
});

describe("daySummary", () => {
  it("counts feeds, naps and diapers and leaves out zeros", () => {
    expect(
      daySummary([
        feed("2026-09-08T12:48:00"),
        feed("2026-09-08T09:15:00"),
        sleep("2026-09-08T10:52:00", "2026-09-08T11:37:00"),
      ]),
    ).toBe("2 feeds · 1 nap");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/frontend && bun test test/timeline-list.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create TimelineList.tsx by moving code out of Timeline.tsx**

Move, verbatim, from `apps/frontend/src/screens/Timeline.tsx` into the new `apps/frontend/src/components/TimelineList.tsx`: `entryTime`, `dayLabel`, `daySummary`, `diaperLabel`, `entryMain`, `kindStyle`, and `Row`, together with every import they need (the `@tabler/icons-react` icons `IconBabyBottle, IconDiaper, IconMoon, IconNote, IconVaccine, type Icon as TablerIcon`; `isFever, measurementMeta`; `Avatar`; `otherKindMeta, type OtherEntry, OtherLogSheet`; `playKindMeta`; `nextDoseFrom`; `photoSrc`; `formatMeasurementIn, formatVolume, type Units, useUnits`; `diaperDetail, feedDetail, sleepTitle`; `formatClock, formatDay, formatDuration`; `t`; `cn`; the sheets `DiaperSheet, FeedSheet, PlaySheet, SleepSheet, VaccineSheet`; `useFeeds, useMedicineCatalogue, useMemberAvatars`; `useState`; `type TimelineEntry`). Then add, exported:

```tsx
// Day groups: consecutive entries (already newest-first) by local day.
export function groupByDay(
  entries: TimelineEntry[],
): { key: string; date: Date; entries: TimelineEntry[] }[] {
  const groups: { key: string; date: Date; entries: TimelineEntry[] }[] = [];
  for (const entry of entries) {
    const d = entryTime(entry);
    const key = d.toDateString();
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else groups.push({ key, date: d, entries: [entry] });
  }
  return groups;
}

// The day-grouped dense list plus tap-to-edit through the log sheets —
// shared by the Timeline tab and Home's Recent pane (spec §4). Owns the
// edit-sheet state; the caller owns the query, the filters and paging.
export function TimelineList({
  babyId,
  entries,
}: {
  babyId: string | undefined;
  entries: TimelineEntry[];
}) {
  const feeds = useFeeds(babyId);
  const avatars = useMemberAvatars();
  const [editEntry, setEditEntry] = useState<TimelineEntry | null>(null);
  // The catalogue for THIS baby carries each entry's newest linked dose;
  // the row that IS that dose gets the "next dose OK from" note.
  const catalogue = useMedicineCatalogue(babyId, !!babyId);
  const nextDoseFor = (entry: TimelineEntry): Date | null => {
    if (entry.kind !== "medicine" || !entry.medicineId) return null;
    const m = (catalogue.data ?? []).find((c) => c.id === entry.medicineId);
    if (!m || !m.lastDoseAt) return null;
    if (new Date(m.lastDoseAt).getTime() !== new Date(entry.time).getTime())
      return null;
    return nextDoseFrom(m);
  };
  const groups = groupByDay(entries);
  const otherEdit =
    editEntry &&
    editEntry.kind !== "feed" &&
    editEntry.kind !== "diaper" &&
    editEntry.kind !== "sleep" &&
    editEntry.kind !== "play" &&
    editEntry.kind !== "vaccine"
      ? (editEntry as OtherEntry)
      : null;

  return (
    <>
      {groups.map((group) => (
        <section key={group.key} className="pb-2">
          <header className="flex items-baseline justify-between px-1 pt-3 pb-1">
            <h2 className="text-sm font-bold text-ink">
              {dayLabel(group.date)}
            </h2>
            <p className="text-xs text-muted">{daySummary(group.entries)}</p>
          </header>
          <div className="divide-y divide-line">
            {group.entries.map((entry) => (
              <Row
                key={`${entry.kind}-${entry.id}`}
                entry={entry}
                avatarUrl={avatars[entry.caretakerId]}
                nextDose={nextDoseFor(entry)}
                onClick={() => setEditEntry(entry)}
              />
            ))}
          </div>
        </section>
      ))}

      <FeedSheet
        open={editEntry?.kind === "feed"}
        onOpenChange={(o) => !o && setEditEntry(null)}
        babyId={babyId ?? ""}
        recentFeeds={feeds.data ?? []}
        edit={editEntry?.kind === "feed" ? editEntry : null}
      />
      <DiaperSheet
        open={editEntry?.kind === "diaper"}
        onOpenChange={(o) => !o && setEditEntry(null)}
        babyId={babyId ?? ""}
        lastDiaper={null}
        edit={editEntry?.kind === "diaper" ? editEntry : null}
      />
      <SleepSheet
        open={editEntry?.kind === "sleep"}
        onOpenChange={(o) => !o && setEditEntry(null)}
        babyId={babyId ?? ""}
        lastLocation={null}
        edit={editEntry?.kind === "sleep" ? editEntry : null}
      />
      <PlaySheet
        open={editEntry?.kind === "play"}
        onOpenChange={(o) => !o && setEditEntry(null)}
        babyId={babyId ?? ""}
        edit={editEntry?.kind === "play" ? editEntry : null}
      />
      <VaccineSheet
        open={editEntry?.kind === "vaccine"}
        onOpenChange={(o) => !o && setEditEntry(null)}
        babyId={babyId ?? ""}
        edit={editEntry?.kind === "vaccine" ? editEntry : null}
      />
      <OtherLogSheet
        open={!!otherEdit}
        onOpenChange={(o) => !o && setEditEntry(null)}
        babyId={babyId ?? ""}
        kind={otherEdit?.kind ?? "medicine"}
        edit={otherEdit}
      />
    </>
  );
}
```

`daySummary` becomes `export function daySummary(...)` (same body as before).

- [ ] **Step 4: Slim Timeline.tsx down to the screen**

`TimelineScreen` keeps: `useSelectedBaby`, filter/search state and debounce, `useTimeline`, `entries`, the header (title, search button, `BabySwitcher compact`), the `Input`, the `ChipGroup`, loading / error / empty states, and the Load more button. Replace everything from `{groups.map((group) => (` to the closing `)}` of the `groups.map` AND the whole block of edit sheets (from `<FeedSheet` through the `OtherLogSheet` IIFE) with:

```tsx
        <TimelineList babyId={baby?.id} entries={entries} />
```

placed inside the `<div className="pb-tabbar">`, right after the empty-state `<p>`, and before the Load more button. Delete the now-unused local code (`groups` loop, `feeds`, `avatars`, `editEntry`, `catalogue`, `nextDoseFor`) and imports (`Avatar`, the sheets, `otherKindMeta`, `OtherEntry`, `playKindMeta`, `nextDoseFrom`, `photoSrc`, `formatMeasurementIn`, `formatVolume`, `Units`, `useUnits`, `diaperDetail`, `feedDetail`, `sleepTitle`, `formatClock`, `formatDay`, `formatDuration`, `isFever`, `measurementMeta`, the icons except `IconSearch`, `useFeeds`, `useMedicineCatalogue`, `useMemberAvatars`, `cn` if unused). Add `import { TimelineList } from "@/components/TimelineList";`.

- [ ] **Step 5: `useTimeline` gains `enabled`**

In `apps/frontend/src/lib/data/insights.ts`:

```ts
export function useTimeline(
  babyId: string | undefined,
  filter: TimelineFilter | null,
  // A search term (issue #52); "" is the plain feed.
  q = "",
  // Home's Recent pane exists only at the wide tier; a phone must never
  // fetch a page it will not render.
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: ["timeline", babyId, filter ?? "all", q],
    enabled: !!babyId && enabled,
```

(rest unchanged).

- [ ] **Step 6: Create HomeRecent.tsx and wire it in**

`apps/frontend/src/components/HomeRecent.tsx`:

```tsx
import { TimelineList } from "@/components/TimelineList";
import { useTimeline } from "@/lib/data";
import { useTier } from "@/lib/layout";

// Home's middle pane at the wide tier (spec §4): the first page of the
// selected baby's timeline — no filter, no search, no paging — so a desktop
// answers "what has happened today" without leaving Home. Hidden below xl
// by CSS AND not fetched there (the query is enabled only at wide).
export function HomeRecent({ babyId }: { babyId: string }) {
  const wide = useTier() === "wide";
  const timeline = useTimeline(babyId, null, "", wide);
  const entries = timeline.data?.pages[0]?.entries ?? [];
  return (
    <section
      data-testid="home-recent"
      className="hidden min-w-0 xl:block xl:pt-6"
    >
      <TimelineList babyId={babyId} entries={entries} />
    </section>
  );
}
```

Check `useTimeline` is re-exported from `@/lib/data` (`grep -n "insights" apps/frontend/src/lib/data/index.ts`); if the index re-exports `./insights` it is. In `apps/frontend/src/screens/Home.tsx` delete the temporary `function HomeRecent` stub and add `import { HomeRecent } from "@/components/HomeRecent";`.

- [ ] **Step 7: Tests, typecheck, lint**

Run: `bun run check && cd apps/frontend && bun test`
Expected: clean, PASS (timeline-list test included).

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/components/TimelineList.tsx apps/frontend/src/components/HomeRecent.tsx apps/frontend/src/screens/Timeline.tsx apps/frontend/src/screens/Home.tsx apps/frontend/src/lib/data/insights.ts apps/frontend/test/timeline-list.test.ts
git commit -m "feat(home): Recent pane at xl, sharing the Timeline's list with the Timeline tab

TimelineList owns the rows and the edit sheets; the screens own the query. Spec §4."
```

---

### Task 8: Keyboard hotkeys on Home and visible focus

**Files:**
- Create: `apps/frontend/src/lib/hotkeys.ts`
- Modify: `apps/frontend/src/screens/Home.tsx` (mount the hook)
- Modify: `apps/frontend/src/components/Chips.tsx`, `components/Stepper.tsx`, `components/StatusCard.tsx` (add `focusRing`)
- Test: `apps/frontend/test/hotkeys.test.ts`

**Interfaces:**
- Produces: `isTypingTarget(target)`, `hotkeyFor(event, map)`, `useHotkeys(map, enabled)`.

- [ ] **Step 1: Write the failing test**

`apps/frontend/test/hotkeys.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { hotkeyFor, isTypingTarget } from "../src/lib/hotkeys";

// Spec §6: plain single keys on Home, ignored while typing and with any
// modifier held (browser shortcuts stay the browser's). No DOM in this
// suite, so targets are duck-typed {tagName, isContentEditable} objects —
// which is also why isTypingTarget must not use instanceof.
const map = { f: () => "feed", d: () => "diaper", s: () => "sleep" };
const key = (k: string, extra: Partial<Parameters<typeof hotkeyFor>[0]> = {}) => ({
  key: k,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  target: { tagName: "BODY", isContentEditable: false },
  ...extra,
});

describe("hotkeyFor", () => {
  it("maps plain keys, case-insensitively", () => {
    expect(hotkeyFor(key("f"), map)?.()).toBe("feed");
    expect(hotkeyFor(key("F"), map)?.()).toBe("feed");
    expect(hotkeyFor(key("s"), map)?.()).toBe("sleep");
  });
  it("ignores unknown keys", () => {
    expect(hotkeyFor(key("x"), map)).toBeNull();
  });
  it("ignores any modifier", () => {
    expect(hotkeyFor(key("f", { ctrlKey: true }), map)).toBeNull();
    expect(hotkeyFor(key("f", { metaKey: true }), map)).toBeNull();
    expect(hotkeyFor(key("f", { altKey: true }), map)).toBeNull();
  });
  it("ignores keys typed into a field", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(
        hotkeyFor(key("f", { target: { tagName, isContentEditable: false } }), map),
      ).toBeNull();
    }
    expect(
      hotkeyFor(key("f", { target: { tagName: "DIV", isContentEditable: true } }), map),
    ).toBeNull();
  });
});

describe("isTypingTarget", () => {
  it("is false for nothing and for plain elements", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON", isContentEditable: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/frontend && bun test test/hotkeys.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement hotkeys.ts**

```ts
import { useEffect, useRef } from "react";

// Single-key shortcuts for Home (spec §6): F / D / S open the sheets. Not
// tier-gated — a Bluetooth keyboard on a tablet gets them too — and never
// with a modifier, so nothing the browser owns is shadowed.

export type HotkeyMap = Record<string, () => void>;

type KeyLike = {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target: EventTarget | { tagName?: string; isContentEditable?: boolean } | null;
};

// Duck-typed rather than instanceof: the unit suite has no DOM.
export function isTypingTarget(target: KeyLike["target"]): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el || typeof el.tagName !== "string") return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable === true
  );
}

export function hotkeyFor(e: KeyLike, map: HotkeyMap): (() => void) | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  if (isTypingTarget(e.target)) return null;
  return map[e.key.toLowerCase()] ?? null;
}

export function useHotkeys(map: HotkeyMap, enabled = true): void {
  // The newest map without re-subscribing on every render.
  const latest = useRef(map);
  useEffect(() => {
    latest.current = map;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const fn = hotkeyFor(e, latest.current);
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
```

- [ ] **Step 4: Run the unit test**

Run: `cd apps/frontend && bun test test/hotkeys.test.ts`
Expected: PASS.

- [ ] **Step 5: Mount on Home; focus rings on the log-flow controls**

In `apps/frontend/src/screens/Home.tsx`:
- add `import { useHotkeys } from "@/lib/hotkeys";` and `useWakeSleep` to the existing `@/lib/data` import list (it is already exported there; `NightHome` uses it).
- inside `HomeScreen`, after the `const actions = moreActions({...})` block, add:

```tsx
  // F / D / S with no sheet open (spec §6). S wakes a running session, as
  // the banner's button does, because the Sleep button is disabled then.
  const wakeSleep = useWakeSleep();
  const activeSleepId = summary.data?.activeSleep?.id ?? null;
  useHotkeys(
    {
      f: () => setSheet("feed"),
      d: () => setSheet("diaper"),
      s: () =>
        activeSleepId
          ? wakeSleep.mutate({ id: activeSleepId })
          : setSheet("sleep"),
    },
    sheet === null && !!baby,
  );
```

  Hooks must run unconditionally: place this ABOVE the early returns (`if (babies.isError) ...`). `summary`, `sheet`, `baby` are all declared above those returns already.

- Focus rings: in `components/Chips.tsx` add `focusRing` to both chip button class lists (`cn("h-11 min-w-16 ...", focusRing, value === ... )`); in `components/Stepper.tsx` add it to the two `−`/`+` buttons; in `components/StatusCard.tsx` add it to the root `<button>`'s className via `cn("flex w-full ...", focusRing)`. Import `focusRing` from `@/lib/utils` in each.

- [ ] **Step 6: Tests, typecheck, lint**

Run: `bun run check && cd apps/frontend && bun test`
Expected: clean, PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/lib/hotkeys.ts apps/frontend/src/screens/Home.tsx apps/frontend/src/components/Chips.tsx apps/frontend/src/components/Stepper.tsx apps/frontend/src/components/StatusCard.tsx apps/frontend/test/hotkeys.test.ts
git commit -m "feat(home): F / D / S hotkeys and visible keyboard focus

Plain keys, no modifiers, never while typing. Spec §6."
```

---

### Task 9: Manifest orientation, docs

**Files:**
- Modify: `apps/frontend/vite.config.ts` (`orientation: "portrait"` line ~61)
- Modify: `DECISIONS.md` (append a section)
- Modify: `SMOKE-TEST.md` (append to section 6)
- Modify: `CLAUDE.md` (Frontend bullet list, after the `viewport-fit=cover` bullet)

- [ ] **Step 1: Manifest**

In `apps/frontend/vite.config.ts` replace `orientation: "portrait",` with:

```ts
        // "any": a tablet in a landscape stand rotates (spec §7). Phones
        // follow their own rotation lock regardless.
        orientation: "any",
```

- [ ] **Step 2: DECISIONS.md**

Append:

```markdown
## 2026-09-08 — responsive shell: phone, tablet, desktop from one layout

- **Tiers by viewport width, never user-agent.** `md` (768) and `xl`
  (1280) — Tailwind's own — so the CSS side (`md:` / `xl:` classes) and the
  JS side (`lib/layout.ts`, used only for the vaul direction and the
  wide-only Recent query) cannot disagree. A narrowed desktop window is a
  phone; a phone in landscape is not a tablet.
- **The bottom sheet becomes a 420 px right panel at `md`**, in the one
  component that imports vaul. Every sheet was laid out for `max-w-md`,
  so nothing inside them changed. The direction is latched when the sheet
  opens: resizing across 768 px mid-edit keeps the half-filled sheet
  rather than remounting it (the same hazard as the 22:00 night flip).
- **"Left informs, right acts."** Home at `md` puts the status cards on
  the left and the actions on the right edge — the edge the panel opens
  from — so the cards stay readable beside an open sheet. Option B
  (actions across the bottom) lost on the mockups because the panel
  covered its buttons and there was nowhere for the desktop Recent pane.
- **No More button above 768 px.** The three primaries become a row and
  the eleven More-sheet actions unfold beneath them as 44 px row tiles,
  from the SAME `moreActions()` list the sheet renders — a new kind lands
  in both. Row tiles over the sheet's 96 px tiles because they keep the
  hierarchy (three big things, then a list) and fit a 712 px tablet
  without scrolling.
- **Desktop is the tablet tier plus a keyboard.** F / D / S on Home,
  Escape, visible focus rings — and nothing else: no density, no hover
  menus, no master–detail. Touch targets never shrink.
- **The account avatar stays in the baby header; the rail is navigation
  only.**
- **Manifest `orientation: "any"`.** It was `portrait`, which locked an
  installed tablet app in a landscape stand. An already-installed Android
  app only sees this after Chrome regenerates the WebAPK.
```

- [ ] **Step 3: SMOKE-TEST.md**

Append to the end of section 6 (after item 22, before `## 7.`):

```markdown
23. **Tablet & desktop.** On a tablet in landscape (or a desktop window
    ≥ 768 px wide): the tab bar is a left rail; Feed opens as a panel on
    the right with Save reachable without scrolling; Home shows status
    left, actions right, with Feed / Diaper / Sleep on top and the eleven
    More actions as small row tiles below (no More button). At ≥ 1280 px
    a Recent list sits between them and tapping a row opens its edit
    sheet. Resize the window across 768 px with a sheet half-filled: the
    value survives. Press `f`, `d`, `s` on Home: the sheets open; Escape
    closes. Rotate an installed Android tablet app: it follows (a
    reinstall may be needed for the WebAPK to pick up the manifest). On
    an iPad Safari PWA check the panel's full height and the safe areas.
```

- [ ] **Step 4: CLAUDE.md**

In the `**Frontend**` bullet list, after the `viewport-fit=cover` bullet, add:

```markdown
- Responsive shell (spec `docs/superpowers/specs/2026-09-08-responsive-shell-design.md`):
  three viewport tiers — compact (< 768), regular (`md:`), wide (`xl:`).
  From `md` the tab bar is a left rail (CSS only, `TabBar.tsx`), sheets
  are a 420 px right panel (`Sheet.tsx`, the only vaul import), and Home
  is two panes with the More actions unfolded as row tiles
  (`HomeActions.tsx`, fed by `moreActions()`); `xl` adds a Recent pane
  (`HomeRecent.tsx` over `TimelineList.tsx`). `lib/layout.ts` is the JS
  side of the tier and exists for exactly what CSS cannot do. Desktop is
  the tablet tier plus F / D / S hotkeys (`lib/hotkeys.ts`) — never
  density or hover UI.
```

- [ ] **Step 5: Lint and commit**

Run: `bun run check`
Expected: clean.

```bash
git add apps/frontend/vite.config.ts DECISIONS.md SMOKE-TEST.md CLAUDE.md
git commit -m "docs: responsive shell decisions, smoke checks; manifest orientation any"
```

---

### Task 10: E2E — tablet and desktop projects, layout spec

**Files:**
- Modify: `e2e/playwright.config.ts`
- Create: `e2e/layout.spec.ts`

**Interfaces:**
- Consumes: `data-direction` on the sheet content (Task 4), `data-testid="home-actions-unfolded"` (Task 6), `data-testid="home-recent"` (Task 7), the `nav[aria-label="Main"]` (Task 2), the Stepper's `increase ml` button and `ml` input.

- [ ] **Step 1: Playwright projects**

Replace `e2e/playwright.config.ts` with:

```ts
import { defineConfig, devices } from "@playwright/test";

// The E2E suite drives the REAL production artifact: the Go binary (or the
// container image) serving the embedded SPA against a real Postgres — never
// the vite dev server, so what passes here is what ships. Start the stack
// with `bash scripts/e2e-stack.sh up` (or let `mise run e2e` do everything).
//
// Workers = 1 on purpose: the specs share one database and one signup-open
// app instance; user isolation is per-spec via unique emails, but ordering
// noise (rate limits, invite counts) is not worth parallelism at this size.
//
// Three projects, one browser (Chromium). Pjokk is mobile-first, so every
// spec runs on the Pixel 7 profile; only layout.spec.ts — the responsive
// shell — also runs on a landscape tablet (the regular tier) and a desktop
// window (the wide tier), so the rest of the suite keeps its single run.
export default defineConfig({
  testDir: ".",
  workers: 1,
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3300",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    {
      name: "tablet",
      testMatch: /layout\.spec\.ts/,
      use: { ...devices["Galaxy Tab S4 landscape"] },
    },
    {
      name: "desktop",
      testMatch: /layout\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
```

- [ ] **Step 2: The layout spec**

`e2e/layout.spec.ts`:

```ts
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// The responsive shell (docs/superpowers/specs/2026-09-08-responsive-shell-
// design.md). Runs on all three projects; each test says which tier it is
// about. The tier is decided by the viewport, never the device, so the
// checks read the viewport rather than the project name where they can.

const rail = (page: import("@playwright/test").Page) =>
  page.getByRole("navigation", { name: "Main" });

test("navigation is a bottom bar on the phone and a left rail from 768 px", async ({ page, request }) => {
  await freshFamily(page, request, "layout-nav");
  const box = await rail(page).boundingBox();
  const vp = page.viewportSize()!;
  expect(box).not.toBeNull();
  if (vp.width < 768) {
    // Bottom bar: full width, at the bottom edge.
    expect(box!.width).toBeGreaterThan(vp.width - 2);
    expect(box!.y + box!.height).toBeGreaterThan(vp.height - 2);
  } else {
    // Rail: 88 px wide, full height, at the left edge.
    expect(box!.x).toBe(0);
    expect(Math.round(box!.width)).toBe(88);
    expect(box!.height).toBeGreaterThan(vp.height - 2);
  }
});

test("Feed opens as a 420 px right panel from 768 px, with Save in view", async ({ page, request }, testInfo) => {
  test.skip(page.viewportSize()!.width < 768, "regular and wide tiers only");
  await freshFamily(page, request, "layout-panel");
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Feed" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-direction", "right");
  const box = (await dialog.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(Math.round(box.width)).toBe(420);
  expect(Math.round(box.x + box.width)).toBe(vp.width);
  await expect(page.getByRole("button", { name: "Save" })).toBeInViewport();
  // The status cards stay readable beside the panel.
  await expect(page.getByText("Last feed")).toBeVisible();
  testInfo.annotations.push({ type: "tier", description: "regular+" });
});

test("the More actions unfold on Home from 768 px and stay a sheet on the phone", async ({ page, request }) => {
  await freshFamily(page, request, "layout-more");
  const unfolded = page.getByTestId("home-actions-unfolded");
  const more = page.getByRole("button", { name: "More", exact: true });
  if (page.viewportSize()!.width < 768) {
    await expect(more).toBeVisible();
    await expect(unfolded).toBeHidden();
  } else {
    await expect(more).toBeHidden();
    await expect(unfolded).toBeVisible();
    await expect(unfolded.getByRole("button")).toHaveCount(11);
    await unfolded.getByRole("button", { name: "Medicine" }).click();
    await expect(page.getByRole("dialog", { name: "Medicine" })).toBeVisible();
  }
});

test("wide: Home shows Recent and a row opens its edit sheet", async ({ page, request }) => {
  test.skip(page.viewportSize()!.width < 1280, "wide tier only");
  await freshFamily(page, request, "layout-recent");
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await page.getByRole("button", { name: "Save" }).click();
  const recent = page.getByTestId("home-recent");
  await expect(recent).toBeVisible();
  const row = recent.getByRole("button", { name: /Bottle/ }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(page.getByRole("dialog", { name: "Edit feed" })).toBeVisible();
});

test("a sheet survives a resize across 768 px and reopens in the new direction", async ({ page, request }) => {
  test.skip(page.viewportSize()!.width < 1280, "starts at the wide tier");
  await freshFamily(page, request, "layout-resize");
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Feed" });
  await expect(dialog).toHaveAttribute("data-direction", "right");
  const amount = dialog.getByRole("textbox", { name: "ml" });
  const before = Number(await amount.inputValue());
  await dialog.getByRole("button", { name: "increase ml" }).click();
  await expect(amount).toHaveValue(String(before + (before < 50 ? 5 : 10)));

  await page.setViewportSize({ width: 600, height: 900 });
  // Still open, still a right panel (latched), value intact.
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-direction", "right");
  await expect(amount).toHaveValue(String(before + (before < 50 ? 5 : 10)));

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Feed" })).toHaveAttribute("data-direction", "bottom");
});

test("F opens Feed, not while typing; Escape closes", async ({ page, request }) => {
  await freshFamily(page, request, "layout-keys");
  await page.keyboard.press("f");
  const dialog = page.getByRole("dialog", { name: "Feed" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.keyboard.press("d");
  const diaper = page.getByRole("dialog", { name: "Diaper" });
  await expect(diaper).toBeVisible();
  // Typing into the note must not open another sheet.
  await diaper.getByPlaceholder("Note (optional)").fill("f");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(diaper).toBeHidden();
});

test("night mode keeps three actions in the bottom half, right-aligned from 768 px", async ({ page, request, context }) => {
  // fixtures.ts seeds night "off"; a later init script wins.
  await context.addInitScript(() => {
    try {
      localStorage.setItem("pjokk.night.mode", "on");
    } catch {
      // storage unavailable
    }
  });
  await freshFamily(page, request, "layout-night");
  const vp = page.viewportSize()!;
  for (const name of ["Sleep", "Feed", "Diaper"]) {
    const box = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(box.y).toBeGreaterThan(vp.height / 2);
    if (vp.width >= 768) {
      expect(box.x + box.width).toBeGreaterThan(vp.width - 60);
      expect(box.width).toBeLessThanOrEqual(448);
    }
  }
});
```

- [ ] **Step 3: Typecheck the e2e folder**

Run: `bun run typecheck`
Expected: clean (the root script also runs `tsc --noEmit -p e2e`).

- [ ] **Step 4: Run the suite against the real stack**

Run from the repo root (needs Docker; builds the image on first run — several minutes):

```bash
E2E_REBUILD=1 bash scripts/e2e-stack.sh up
cd e2e && bunx playwright test layout.spec.ts
bunx playwright test --project=mobile   # the untouched suite still passes on the phone
cd .. && bash scripts/e2e-stack.sh down
```

Expected: `layout.spec.ts` green on mobile, tablet and desktop; the mobile project green. If a Diaper note placeholder differs from `Note (optional)`, read `components/sheets/DiaperSheet.tsx` for the real placeholder and adjust the spec, not the sheet.

- [ ] **Step 5: Commit**

```bash
git add e2e/playwright.config.ts e2e/layout.spec.ts
git commit -m "test(e2e): tablet and desktop projects with a responsive-shell layout spec"
```

---

### Task 11: Verification and the pull request

- [ ] **Step 1: Full checks**

```bash
bun run check
bun run test
cd apps/frontend && bun run build && cd ../..
```

Expected: all clean. The build must succeed — the SPA is embedded in the Go binary.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/responsive-shell
gh pr create --title "feat(layout): responsive shell — phone, tablet, desktop" --body "$(cat <<'EOF'
## What

The SPA uses the width of a tablet or desktop window (spec: `docs/superpowers/specs/2026-09-08-responsive-shell-design.md`, plan: `docs/superpowers/plans/2026-09-08-responsive-shell.md`). Nothing changes below 768 px.

- Three viewport tiers on Tailwind's `md` / `xl`; `lib/layout.ts` for the three things CSS cannot do.
- Tab bar → left rail at `md` (CSS only, one component).
- Sheets → 420 px right panel at `md`, direction latched at open, close button.
- Home: status left, actions right; Feed / Diaper / Sleep on top with the eleven More actions unfolded as row tiles (one `moreActions()` list with the sheet). `xl` adds a Recent pane over the extracted `TimelineList`.
- F / D / S hotkeys on Home, visible focus rings.
- Manifest `orientation: any`.
- Playwright: `tablet` and `desktop` projects run `layout.spec.ts`; the rest of the suite stays on Pixel 7.

## Test plan

- [ ] `bun run check`, `bun run test`
- [ ] `mise run e2e` (mobile suite + layout spec on tablet and desktop)
- [ ] SMOKE-TEST.md §6 item 23 on a real tablet

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01C4AJHps9yATdm2FPYtQMnN
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** §1 tiers → Task 1; §2 rail + shell offset → Task 2; §3 sheets → Task 4; §4 Home (panes, unfolded actions, Recent, night column, avatar in header) → Tasks 5–7; §5 widths → Task 3; §6 keyboard + focus → Task 8; §7 manifest → Task 9; §8/§9 recorded → Task 9 docs; Testing → Tasks 1–8 unit, Task 10 e2e, Task 9 smoke. Spec §5's Stats "summary rows in `md:grid-cols-2`" is deliberately NOT done: the Stats summary markup was not read for this plan and a blind grid could break the chart row; width alone is applied. Note it in the PR if it matters.
- **Types:** `Tier` (Task 1) is consumed by `directionFor` (Task 4) and `useTier` by `Sheet`/`HomeRecent`; `MoreAction`/`moreActions` (Task 5) by `HomeActions`/`Home` (Task 6); `TimelineList`/`groupByDay`/`daySummary` (Task 7) by `HomeRecent` and the test; `focusRing` (Task 2) by Tasks 4, 6, 8; `data-direction`, the two `data-testid`s and `nav[aria-label=Main]` by Task 10.
