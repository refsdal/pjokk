import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// The nap-window guide on Home (issue #46), against the real artifact. The
// fixture baby was born 2026-06-15, so through early September it sits in
// the 1–3 month row of data/wake-windows.json (60–120 minutes awake) and
// moves to the 3–5 month row (75–150) later — either way a wake 20 minutes
// ago puts the window ahead and a wake 4 hours ago puts it behind, which
// is all the assertions rely on. Switching the guide off in Settings
// removes the line.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/nap-window-shots";
const shot = (name: string) => join(SHOT_DIR, name);

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
}

async function logNap(page: Page, babyId: string, endMinutesAgo: number) {
  const end = new Date(Date.now() - endMinutesAgo * 60_000);
  const start = new Date(end.getTime() - 40 * 60_000);
  const res = await page.request.post("/api/sleep", {
    data: { babyId, startTime: start.toISOString(), endTime: end.toISOString(), type: "nap" },
  });
  expect(res.status(), await res.text()).toBe(201);
}

test("the awake card shows a nap window ahead, then past, and can be switched off", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "napwin");
  const babies = await (await page.request.get("/api/babies")).json();
  const babyId = babies[0].id as string;

  await logNap(page, babyId, 20);
  await page.goto("/home");
  await page.reload();
  await expect(page.getByText(/^Nap window \d\d:\d\d–\d\d:\d\d$/)).toBeVisible({
    timeout: 10_000,
  });
  await settle(page);
  await page.screenshot({ path: shot("1-home-window-ahead.png") });

  // A later, longer-ago wake: the window is behind us.
  await logNap(page, babyId, 4 * 60 + 10);
  // Newest sleep by start time is still the first one (ended 20 min ago), so
  // move it: delete it and let the older one be the last.
  const sleeps = await (await page.request.get(`/api/sleep?babyId=${babyId}`)).json();
  const newest = sleeps[0];
  const del = await page.request.delete(`/api/sleep/${newest.id}`);
  expect(del.status()).toBe(200);
  await page.reload();
  await expect(page.getByText("Past the usual nap window")).toBeVisible({ timeout: 10_000 });
  await settle(page);
  await page.screenshot({ path: shot("2-home-window-past.png") });

  // Settings: the switch and its disclaimer.
  await page.goto("/settings");
  await expect(page.getByText(/A guide, not advice/)).toBeVisible();
  await settle(page);
  await page
    .getByText(/A guide, not advice/)
    .locator("..")
    .screenshot({ path: shot("3-settings-nap-guide.png") });
  // The guide's Off is the first Off chip on the page (night mode's comes
  // later in the Appearance section).
  await page.getByRole("button", { name: "Off", exact: true }).first().click();

  await page.goto("/home");
  await expect(page.getByText("Awake", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Past the usual nap window")).toHaveCount(0);
});
