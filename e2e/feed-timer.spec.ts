import { join } from "node:path";
import type { Page } from "@playwright/test";
import { asDevice, expect, seedDayMode, test } from "./fixtures";
import { apiSignIn, apiSignup, freshEmail, freshFamily } from "./helpers";

// The shared nursing / pump timer (issue #44) between two caretakers,
// against the real artifact: one phone starts the clock from the feed
// sheet, the other phone's Home shows it running and stops it, and both
// end up with the same logged feed. internal/api/feed_timer_test.go covers
// the endpoints and lib/feed-timer-ui.test.ts the maths; only this spec can
// see that the second phone actually shows the banner.
//
// Same two-context shape as help.spec.ts, including the 15 s summary
// staleness wait before a reload (see refetchHome there).

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/feed-timer-shots";
const shot = (name: string) => join(SHOT_DIR, name);

const SUMMARY_STALE_MS = 15_000;
async function refetchHome(page: Page): Promise<void> {
  await page.waitForTimeout(SUMMARY_STALE_MS + 1_000);
  await page.goto("/home");
  await page.reload();
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
}

test("a nursing timer started on one phone runs, and stops, on the other", async ({
  browser,
  page,
  request,
}, testInfo) => {
  test.setTimeout(150_000);
  await freshFamily(page, request, "timer");

  // ---- A second caretaker joins via an invite (as in help.spec.ts) -----
  await page.goto("/settings");
  await page.getByRole("button", { name: "New invite link" }).click();
  const link = await page.getByText(/\/join\//).first().textContent();
  const code = link!.trim().split("/join/")[1]?.trim();
  expect(code, `code from ${link}`).toBeTruthy();

  const otherEmail = freshEmail("timer-other");
  await apiSignup(request, otherEmail);
  const ctx = await browser.newContext(asDevice(testInfo, 1));
  await seedDayMode(ctx);
  const other = await ctx.newPage();
  await apiSignIn(other, otherEmail);
  await other.goto(`/join/${code}`);
  await expect(other).toHaveURL(/\/home/, { timeout: 10_000 });

  // ---- Phone A: Feed → Breast → start the left side -------------------
  await page.goto("/home");
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await page.getByRole("button", { name: "Breast", exact: true }).click();
  // Two "Start timer" buttons (left, right); the first is the left side.
  await page.getByRole("button", { name: "Start timer" }).first().click();
  await expect(page.getByRole("button", { name: /^Pause · / })).toBeVisible({
    timeout: 10_000,
  });
  await settle(page);
  await page.screenshot({ path: shot("1-sheet-running.png") });

  // Closing the sheet leaves the clock running: it is family state now.
  await page.keyboard.press("Escape");
  // The banner's text column: label plus the "duration · side" line. The
  // sheet's own LEFT label is still in the DOM while it animates out, so
  // scope the side check to the banner.
  const banner = (p: Page) => p.getByText("Feeding").locator("..");
  await expect(banner(page)).toBeVisible({ timeout: 10_000 });
  await expect(banner(page)).toContainText("Left");

  // ---- Phone B: sees the running feed on Home -------------------------
  await refetchHome(other);
  await expect(banner(other)).toBeVisible({ timeout: 10_000 });
  await expect(banner(other)).toContainText("Left");
  await settle(other);
  await other.screenshot({ path: shot("2-other-home-banner.png") });

  // ---- Phone B stops it: one tap, the feed is logged from the clock ---
  await other.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(other.getByText("Feeding")).toHaveCount(0, { timeout: 10_000 });
  await expect(other.getByText(/1 feeds/)).toBeVisible({ timeout: 10_000 });

  // ---- Phone A: the banner is gone and the feed is the last feed ------
  await refetchHome(page);
  await expect(page.getByText("Feeding")).toHaveCount(0);
  await expect(page.getByText(/1 feeds/)).toBeVisible();
  await page.goto("/timeline");
  // A sub-minute latch still counts as one minute on the left side.
  await expect(
    page.getByRole("button", { name: /^Breast · left · 1 min/ }),
  ).toBeVisible({ timeout: 10_000 });
  await settle(page);
  await page.screenshot({ path: shot("3-timeline-after-stop.png") });

  await ctx.close();
});

test("a pump timer runs on Home and is stopped through the pump sheet", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "pump-timer");

  // Start it over the API, as a Home Assistant automation would; the
  // sheet's own Start button is the same call.
  const babies = await (await page.request.get("/api/babies")).json();
  const babyId = babies[0].id as string;
  const started = await page.request.post("/api/feeds/timer", {
    data: { babyId, kind: "pump", side: "both" },
  });
  expect(started.status(), await started.text()).toBe(201);

  await page.goto("/home");
  await page.reload();
  await expect(page.getByText("Pumping")).toBeVisible({ timeout: 10_000 });
  await settle(page);
  await page.screenshot({ path: shot("4-home-pump-banner.png") });

  // Stop opens the pump sheet: the clock is the duration, the amount is
  // the one thing the clock cannot know.
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pump" })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: shot("5-pump-sheet-stop.png") });
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText("Pumping")).toHaveCount(0, { timeout: 10_000 });
  await page.goto("/timeline");
  await expect(
    page.getByRole("button", { name: /^Pump · both · 100 ml/ }),
  ).toBeVisible({ timeout: 10_000 });
});
