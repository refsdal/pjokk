import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { freshFamily, openBabySettings } from "./helpers";

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
  await page.goto("/profile");
  await expect(page.getByText(/A guide, not advice/)).toBeVisible();
  await settle(page);
  await page
    .getByText(/A guide, not advice/)
    .locator("..")
    .screenshot({ path: shot("3-settings-nap-guide.png") });
  // The guide's own Off: night mode has an Off chip on this page too.
  await page
    .getByText(/A guide, not advice/)
    .locator("..")
    .getByRole("button", { name: "Off", exact: true })
    .click();

  await page.goto("/home");
  await expect(page.getByText("Awake", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Past the usual nap window")).toHaveCount(0);
});

// The family's own anchor (issue #112): past twelve months the cited table
// stops, and a barnehage's fixed nap sets the rhythm. When a family has
// given the card its own number, the card says that instead of a window.
test("a usual nap set in Settings replaces the window on the awake card", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "usualnap");
  const babies = await (await page.request.get("/api/babies")).json();
  const babyId = babies[0].id as string;
  // She woke three hours ago from a sleep that began last evening: old
  // enough that it is plainly not "the nap".
  const end = new Date(Date.now() - 3 * 3_600_000);
  const start = new Date(end.getTime() - 10 * 3_600_000);
  const slept = await page.request.post("/api/sleep", {
    data: { babyId, startTime: start.toISOString(), endTime: end.toISOString(), type: "night" },
  });
  expect(slept.status(), await slept.text()).toBe(201);

  // Two hours ahead while that is still today; late in the evening the
  // same rule is exercised from the other side, an hour behind.
  const now = new Date();
  const ahead = now.getHours() < 21;
  const anchor = new Date(now.getTime() + (ahead ? 2 : -1) * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(anchor.getHours())}:${pad(anchor.getMinutes())}`;

  await page.goto("/home");
  await expect(page.getByText("Awake", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/^Usual nap/)).toHaveCount(0);

  await openBabySettings(page);
  const field = page.getByTestId("usual-nap").getByLabel("Usual nap");
  await field.fill(clock);
  await expect
    .poll(async () => {
      const s = await (await page.request.get(`/api/summary?babyId=${babyId}`)).json();
      return s.usualNapMinute;
    })
    .toBe(anchor.getHours() * 60 + anchor.getMinutes());
  await page.getByTestId("usual-nap").screenshot({ path: shot("4-settings-usual-nap.png") });

  await page.goto("/home");
  await expect(
    page.getByText(ahead ? `Usual nap ${clock}` : `Usual nap was ${clock}`, { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  // Instead of the age window, not beside it.
  await expect(page.getByText(/Nap window|nap window/)).toHaveCount(0);
  await settle(page);
  await page.screenshot({ path: shot("5-home-usual-nap.png") });

  // Cleared, the card goes back to the age table.
  await openBabySettings(page);
  await page.getByTestId("usual-nap").getByRole("button", { name: "Clear" }).click();
  await page.goto("/home");
  await expect(page.getByText(/^Usual nap/)).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText(/nap window/i)).toBeVisible({ timeout: 10_000 });
});

// The usual nap, suggested from the logs (issue #126): a family that fills
// in the pick-up handover has already said when the barnehage nap begins.
// Offered beside the field, never applied on its own.
test("the usual nap is suggested from the barnehage's logged naps", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "napsuggest");
  const babies = await (await page.request.get("/api/babies")).json();
  const babyId = babies[0].id as string;
  const at = (daysAgo: number, h: number, m: number) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };

  await openBabySettings(page);
  const box = page.getByTestId("usual-nap");
  await expect(box).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("usual-nap-suggestion")).toHaveCount(0);

  // Three days at barnehage, each with a handover nap: 11:30, 11:40, 11:35.
  for (const [daysAgo, minute] of [
    [3, 30],
    [2, 40],
    [1, 35],
  ] as const) {
    const day = await page.request.post("/api/daycare", {
      data: { babyId, startTime: at(daysAgo, 8, 0), endTime: at(daysAgo, 15, 30) },
    });
    expect(day.status(), await day.text()).toBe(201);
    const handover = await page.request.put(`/api/daycare/${(await day.json()).id}/handover`, {
      data: {
        naps: [{ startTime: at(daysAgo, 11, minute), endTime: at(daysAgo, 13, 0) }],
        meals: [],
        diapers: { wet: 0, dirty: 0 },
        mood: null,
      },
    });
    expect(handover.status(), await handover.text()).toBe(200);
  }

  await page.reload();
  const suggestion = page.getByTestId("usual-nap-suggestion");
  await expect(suggestion).toContainText("Logged at daycare: around 11:35", { timeout: 10_000 });
  // Offered, not applied.
  await expect(box.getByLabel("Usual nap")).toHaveValue("");
  await box.screenshot({ path: shot("6-settings-nap-suggestion.png") });

  await suggestion.getByRole("button", { name: "Use this" }).click();
  await expect(box.getByLabel("Usual nap")).toHaveValue("11:35", { timeout: 10_000 });
  // Nothing left to suggest once the anchor says the same.
  await expect(suggestion).toHaveCount(0);
});
