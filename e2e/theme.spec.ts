import { expect, seedDayMode, test } from "./fixtures";

// Regression coverage for a reported bug: an installed PWA on an Android
// phone in dark mode showed a near-white status bar, with the system drawing
// its light glyphs over it — the clock and notification icons unreadable.
//
// Cause: both the `dark` class and the theme-color meta were applied from a
// useEffect, which runs AFTER the first paint. An installed app takes its
// status-bar colour from that meta, so it started light every time, and the
// UI itself flashed the light theme on every cold start in dark or night
// mode. public/theme-init.js now does it before anything paints.

const DARK_BG = "#171512";
const LIGHT_BG = "#faf9f7";

async function themeColor(page: import("@playwright/test").Page) {
  return page.locator('meta[name="theme-color"]').getAttribute("content");
}

test("a dark-mode device gets the dark theme and status-bar colour", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ colorScheme: "dark" });
  await seedDayMode(ctx);
  const page = await ctx.newPage();
  await page.goto("/login");

  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await themeColor(page)).toBe(DARK_BG);
  await ctx.close();
});

test("a light-mode device stays light", async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: "light" });
  await seedDayMode(ctx);
  const page = await ctx.newPage();
  await page.goto("/login");

  await expect(page.locator("html")).not.toHaveClass(/dark/);
  expect(await themeColor(page)).toBe(LIGHT_BG);
  await ctx.close();
});

test("the theme is applied without the app bundle running at all", async ({
  browser,
}) => {
  // The point of theme-init.js is that it does NOT wait for React. Blocking
  // the bundle isolates it: if the class and the colour are still right with
  // no application code executing, they were set before the first paint —
  // which is the only thing that fixes the status bar and the flash.
  const ctx = await browser.newContext({ colorScheme: "dark" });
  await seedDayMode(ctx);
  const page = await ctx.newPage();
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("/login");

  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await themeColor(page)).toBe(DARK_BG);
  await ctx.close();
});

test("night mode wins over the device's light setting", async ({ browser }) => {
  // Night mode is scheduled or manual, never derived from the OS — so it has
  // to override prefers-color-scheme, and it must do so before the paint as
  // well. This is the 3am case the whole night palette exists for.
  const ctx = await browser.newContext({ colorScheme: "light" });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("pjokk.night.mode", "on");
    } catch {
      // storage unavailable
    }
  });
  const page = await ctx.newPage();
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("/login");

  await expect(page.locator("html")).toHaveClass(/night/);
  expect(await themeColor(page)).toBe("#171310");
  await ctx.close();
});
