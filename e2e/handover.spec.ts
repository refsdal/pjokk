import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// The pick-up handover (issue #106, spec 2026-09-17-daycare-handover): one
// sheet at pick-up that writes ordinary nap, meal and diaper rows, shown on
// the timeline as the barnehage's rather than the parent's who typed them.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/handover-shots";
const shot = (name: string) => join(SHOT_DIR, name);

async function firstBabyId(page: Page): Promise<string> {
  const babies = await (await page.request.get("/api/babies")).json();
  return babies[0].id as string;
}

test("pick up, answer the card, find the day's rows on the timeline", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "handover");
  const babyId = await firstBabyId(page);
  // Still running, so Pick up ends it now. It began at 08:00 YESTERDAY so
  // that, whatever hour this runs at, the usual nap and lunch fall inside
  // it — the sheet only offers what fits the hours she was there, and the
  // server refuses the rest (OUTSIDE_DAY). The clamping itself is pinned in
  // handover-ui.test.ts and handover_test.go, where the clock is fixed.
  const start = new Date();
  start.setDate(start.getDate() - 1);
  start.setHours(8, 0, 0, 0);
  const dropped = await page.request.post("/api/daycare", {
    data: { babyId, startTime: start.toISOString() },
  });
  expect(dropped.ok(), `seed drop-off: ${dropped.status()}`).toBeTruthy();
  const dayId = (await dropped.json()).id as string;
  await page.goto("/home");

  const card = page.getByText("How was the day at daycare?");
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Pick up", exact: true }).click();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: shot("home-card.png") });

  await page.getByRole("button", { name: "Add", exact: true }).click();
  const sheet = page.getByRole("dialog");
  // Opens on one usual nap; lunch went well; two wet nappies; a good day.
  await expect(sheet.getByLabel("Nap started")).toHaveValue("11:30");
  await sheet.getByLabel("Nap ended").fill("13:10");
  await sheet
    .getByRole("group", { name: "Lunch" })
    .getByRole("button", { name: "Well", exact: true })
    .click();
  await sheet.getByRole("button", { name: "increase wet" }).click();
  await sheet.getByRole("button", { name: "increase wet" }).click();
  await sheet.getByRole("button", { name: "Good day", exact: true }).click();
  await sheet.screenshot({ path: shot("sheet.png") });
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card).toHaveCount(0, { timeout: 10_000 });

  // Ordinary rows, on the API…
  await expect
    .poll(async () => {
      const h = await (
        await page.request.get(`/api/daycare/${dayId}/handover`)
      ).json();
      return [h.naps.length, h.meals.length, h.diapers.wet, h.mood];
    })
    .toEqual([1, 1, 2, "good"]);
  const sleeps = await (
    await page.request.get(`/api/sleep?babyId=${babyId}`)
  ).json();
  expect(sleeps[0].daycareId).toBe(dayId);
  expect(sleeps[0].type).toBe("nap");

  // …and on the timeline, as the barnehage's.
  await page.goto("/timeline");
  const mine = page.getByRole("button").filter({ hasText: "at daycare" });
  await expect(mine).toHaveCount(4, { timeout: 10_000 }); // nap, meal, 2 diapers
  await expect(mine.filter({ hasText: "ate well" })).toHaveCount(1);
  await page.screenshot({ path: shot("timeline.png") });

  // Reopened from the day, it reads back what was saved — and saving it
  // again replaces rather than doubles.
  await page
    .getByRole("button")
    .filter({ hasText: /^Daycare/ })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Handover", exact: true })
    .click();
  const again = page.getByRole("dialog", { name: "Handover" });
  await expect(again.getByLabel("Nap ended")).toHaveValue("13:10");
  await expect(
    again
      .getByRole("group", { name: "Lunch" })
      .getByRole("button", { name: "Well", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await again.getByRole("button", { name: "decrease wet" }).click();
  await again.getByRole("button", { name: "Save", exact: true }).click();
  await expect(mine).toHaveCount(3, { timeout: 10_000 });
});

test("the card can be waved away without writing anything", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "handover2");
  const babyId = await firstBabyId(page);
  const end = new Date(Date.now() - 30 * 60_000);
  const start = new Date(end.getTime() - 7 * 3_600_000);
  await page.request.post("/api/daycare", {
    data: {
      babyId,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
    },
  });
  await page.goto("/home");
  const card = page.getByText("How was the day at daycare?");
  await expect(card).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Feed", exact: true })).toBeVisible();
  await expect(card).toHaveCount(0);
});
