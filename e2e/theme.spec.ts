import { expect, seedDayMode, test } from "./fixtures";

// Regression coverage for a reported bug: an installed PWA on an Android
// phone in dark mode showed a near-white status bar, with the system drawing
// its light glyphs over it — the clock and notification icons unreadable.
//
// First cause: both the `dark` class and the theme-color meta were applied
// from a useEffect, which runs AFTER the first paint, so the meta started
// light every time and the UI flashed the light theme on every cold start in
// dark or night mode. public/theme-init.js now does it before anything paints.
//
// Second cause, reported still broken after that: the bar itself. An
// installed Android app is a WebAPK and its status-bar background is baked
// from the manifest's `theme_color` when the APK is generated, so it cannot
// follow a per-device theme — while the glyph colour keeps coming from this
// meta. Dark meta over a bar baked light is white glyphs on white. Both are
// dark now, and an installed app reports dark whatever its theme; see
// apps/frontend/src/lib/system-chrome.ts.

const DARK_BG = "#171512";
const LIGHT_BG = "#faf9f7";

async function themeColor(page: import("@playwright/test").Page) {
  return page.locator('meta[name="theme-color"]').getAttribute("content");
}

/**
 * Makes the page believe it was launched from the home screen.
 *
 * There is no honest way to do this in a headless run: Playwright has no
 * `display-mode` in `emulateMedia`, a raw CDP `Emulation.setEmulatedMedia` is
 * overwritten again when Playwright re-applies its own on navigation (probed:
 * the query still answered `browser`), and `--app=` produces no app window
 * headlessly. So the media query itself is faked — everything downstream of it
 * is the real shipped code, reading the real meta in the real image, which is
 * the part worth covering here. The resolution rules themselves are pinned
 * against the source file in apps/frontend/test/theme-init.test.ts.
 *
 * Wrapped rather than replaced, so `prefers-color-scheme` still answers from
 * the context's own colour scheme.
 */
async function emulateInstalled(context: import("@playwright/test").BrowserContext) {
  await context.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      if (!/display-mode:\s*(standalone|fullscreen|minimal-ui)/.test(query)) {
        return real(query);
      }
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    };
  });
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

test("an installed app never reports a light status-bar colour", async ({
  browser,
}) => {
  // The bug this half exists for. The app's own theme is LIGHT here, and the
  // page stays light — but the status bar above it is baked dark by the
  // manifest, so the colour we hand the system has to be dark too or the
  // clock and notification icons vanish into it.
  const ctx = await browser.newContext({ colorScheme: "light" });
  await seedDayMode(ctx);
  await emulateInstalled(ctx);
  const page = await ctx.newPage();
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("/login");

  await expect(page.locator("html")).not.toHaveClass(/dark/);
  expect(await themeColor(page)).toBe(DARK_BG);
  await ctx.close();
});

test("an installed app in dark mode keeps the dark status-bar colour", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ colorScheme: "dark" });
  await seedDayMode(ctx);
  await emulateInstalled(ctx);
  const page = await ctx.newPage();
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("/login");

  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await themeColor(page)).toBe(DARK_BG);
  await ctx.close();
});
