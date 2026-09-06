import {
  type BrowserContext,
  type TestInfo,
  expect,
  test as base,
} from "@playwright/test";

// Every test is its own client.
//
// The app rate-limits credential sign-in per client address — Limen's 5 per
// 10 s, and Pjokk's own 20 per 10 minutes (api.go's auth-signin, in
// Postgres) — and every test here creates a fresh account and signs in. From
// one address the whole suite is one client with ~19 sign-ins per run, so a
// single retry anywhere tipped the last tests into 429. Real users never
// look like that; a whole family behind one ingress does not either, since
// the ingress forwards each device's address. So the e2e stack runs with
// TRUSTED_PROXY_HOPS=1 (scripts/e2e-stack.sh, ci.yml) and each test sends
// its own X-Forwarded-For — a distinct 10.x.y.z per test and per retry, so
// no test's budget is another's. The production limit is untouched.
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// `device` tells apart the contexts one test opens (the second caretaker's
// phone in help.spec.ts and invite.spec.ts): 0 is the default context.
export function clientAddress(testInfo: TestInfo, device = 0): string {
  const h = hash(testInfo.testId);
  return `10.${(h >>> 8) & 255}.${h & 255}.${testInfo.retry * 16 + device + 1}`;
}

// Options for a context a spec opens by hand — `browser.newContext(
// asDevice(testInfo, 1))` — so it, too, is its own client. Spread extra
// options after it.
export function asDevice(
  testInfo: TestInfo,
  device: number,
): { extraHTTPHeaders: Record<string, string> } {
  return { extraHTTPHeaders: { "X-Forwarded-For": clientAddress(testInfo, device) } };
}

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

// Every test's default `context` (and the `page` built on it) is seeded,
// and it and the `request` fixture carry the test's own client address.
// Specs that create their own context via `browser.newContext()` must call
// `seedDayMode(ctx)` themselves and pass `asDevice(testInfo, n)` — a raw
// context bypasses both.
export const test = base.extend({
  extraHTTPHeaders: async ({}, use, testInfo) => {
    await use(asDevice(testInfo, 0).extraHTTPHeaders);
  },
  context: async ({ context }, use) => {
    await seedDayMode(context);
    await use(context);
  },
});

export { expect };
