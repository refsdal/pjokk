import {
  type BrowserContext,
  expect,
  test as base,
} from "@playwright/test";

// Force day-mode for the whole suite.
//
// The app defaults night mode to "auto" (`apps/frontend/src/lib/night.ts`),
// which renders the stripped-down NightHome (Wake/Feed/Diaper only — no baby
// name, no status cards, no "N feeds" summary) between 22:00 and 07:00 of the
// *browser's local* time. Every spec asserts day-mode Home content, so a run
// whose clock falls in that window fails wholesale — and the container sets no
// TZ, so CI runs in UTC and any job between 22:00–07:00 UTC went red
// regardless of the diff under test.
//
// The fix is time-independent: seed the per-device override
// (localStorage `pjokk.night.mode` = "off") before the app script runs, so
// night mode is never "auto" during a test. `addInitScript` runs before page
// scripts on every navigation in the context, and localStorage is scoped to
// the app origin the bundle reads from.
export async function seedDayMode(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      localStorage.setItem("pjokk.night.mode", "off");
    } catch {
      // storage unavailable — the app falls back to "auto", but that only
      // bites inside the night window; nothing we can do from here then.
    }
  });
}

// Every test's default `context` (and the `page` built on it) is seeded.
// Specs that create their own context via `browser.newContext()` must call
// `seedDayMode(ctx)` themselves — a raw context bypasses this fixture.
export const test = base.extend({
  context: async ({ context }, use) => {
    await seedDayMode(context);
    await use(context);
  },
});

export { expect };
