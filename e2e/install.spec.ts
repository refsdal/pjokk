import type { Browser } from "@playwright/test";
import { expect, seedDayMode, test } from "./fixtures";
import { freshFamily } from "./helpers";

// The install hint, driven through a real browser because the frontend unit
// suite has no DOM. detectInstallState's UA matrix is unit-tested
// (apps/frontend/test/install-state.test.ts); what these specs cover is the
// part only a browser can answer — that the banner renders, that the sheet
// says the right thing for the state, and that a dismissal survives a reload.
//
// The suite's own profile is Pixel 7 (playwright.config.ts), which would
// resolve to "unsupported" — no captured prompt in headless Chromium — so
// each spec builds its own context with an iOS user agent. Chromium with an
// iPhone UA is enough: detection reads navigator strings and flags, never
// WebKit behaviour.

const IOS_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
// A Facebook/Mail-style webview: no Version/ and no Safari/ token.
const IOS_WEBVIEW =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.35.108]";

async function iosContext(browser: Browser, userAgent: string) {
  const ctx = await browser.newContext({ userAgent });
  await seedDayMode(ctx);
  return ctx;
}

test("iOS Safari is shown how to add Pjokk to the home screen", async ({
  browser,
  request,
}) => {
  const ctx = await iosContext(browser, IOS_SAFARI);
  const page = await ctx.newPage();
  await freshFamily(page, request, "installios");

  await expect(page.getByText("Add Pjokk to your home screen")).toBeVisible();
  await page.getByRole("button", { name: "Show me" }).click();

  // The Share-sheet route, spelled out. This is the instruction that is
  // correct ONLY in Safari, which is why the next spec exists. Matched on the
  // whole step: getByText is a case-insensitive substring match, and the
  // Settings row is also labelled "Add to home screen".
  await expect(
    page.getByText("Scroll down and tap Add to Home Screen"),
  ).toBeVisible();
  await ctx.close();
});

test("an in-app browser is sent to Safari instead of hunting for a menu", async ({
  browser,
  request,
}) => {
  const ctx = await iosContext(browser, IOS_WEBVIEW);
  const page = await ctx.newPage();
  await freshFamily(page, request, "installwv");

  await page.getByRole("button", { name: "Show me" }).click();
  // Add to Home Screen does not exist in a webview; telling the user to look
  // for it is the original bug. The sheet must send them to Safari.
  await expect(page.getByText("Open Pjokk in Safari")).toBeVisible();
  await ctx.close();
});

test("dismissing the install banner sticks across a reload", async ({
  browser,
  request,
}) => {
  const ctx = await iosContext(browser, IOS_SAFARI);
  const page = await ctx.newPage();
  await freshFamily(page, request, "installdismiss");

  const banner = page.getByText("Add Pjokk to your home screen");
  await expect(banner).toBeVisible();
  // exact: getByRole matches accessible names by case-insensitive substring,
  // and this spec's own baby ("Baby installdismiss") contains "dismiss".
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(banner).toBeHidden();

  await page.reload();
  await expect(page.getByText(/Baby installdismiss/)).toBeVisible({
    timeout: 10_000,
  });
  await expect(banner).toBeHidden();
  await ctx.close();
});

test("Settings keeps the install instructions reachable after a dismissal", async ({
  browser,
  request,
}) => {
  const ctx = await iosContext(browser, IOS_SAFARI);
  const page = await ctx.newPage();
  await freshFamily(page, request, "installsettings");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();

  await page.goto("/settings");
  await page.getByRole("button", { name: "Add to home screen" }).click();
  await expect(
    page.getByText("Scroll down and tap Add to Home Screen"),
  ).toBeVisible();
  await ctx.close();
});
