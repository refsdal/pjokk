import { join } from "node:path";
import { expect, test } from "./fixtures";
import { freshFamily, openBabySettings } from "./helpers";

// "About <name>" for the barnehage (issue #109): routines read off the
// logs, four lines only the family knows, any section left out before the
// page is made, and a PDF built on the device.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/about-me-shots";
const shot = (name: string) => join(SHOT_DIR, name);

test("the page previews what the logs know, takes what they cannot, and downloads", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "about");
  const babies = await (await page.request.get("/api/babies")).json();
  const babyId = babies[0].id as string;

  // Five ordinary days: up at 06:20, a long nap from 11:30, bed at 19:10,
  // porridge and a bottle. Local clock times, so the medians are exact
  // whatever zone this runs in.
  const at = (daysAgo: number, h: number, m: number) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  for (const d of [1, 2, 3, 4, 5]) {
    for (const [path, data] of [
      ["/api/sleep", { startTime: at(d + 1, 19, 10), endTime: at(d, 6, 20), type: "night" }],
      ["/api/sleep", { startTime: at(d, 11, 30), endTime: at(d, 13, 0), type: "nap", location: "Stroller" }],
      ["/api/feeds", { time: at(d, 8, 0), type: "solids", food: "Porridge" }],
      ["/api/feeds", { time: at(d, 19, 0), type: "bottle", amountMl: 180 }],
    ] as const) {
      const res = await page.request.post(path, { data: { babyId, ...data } });
      expect(res.status(), await res.text()).toBe(201);
    }
  }
  const egg = await page.request.post("/api/feeds", {
    data: { babyId, time: at(60, 12, 0), type: "solids", food: "Egg", reaction: true },
  });
  expect(egg.status()).toBe(201);

  await openBabySettings(page);
  const card = page.getByTestId("about-me");
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByText("Usually wakes:")).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText("Usually wakes: 06:20");
  await expect(card).toContainText("Usual bedtime: 19:10");
  await expect(card).toContainText("The long nap: around 11:30, 1 h 30 min");
  await expect(card).toContainText("Usually naps in: Stroller");
  await expect(card).toContainText("Bottles a day: 1, around 180 ml");
  await expect(card).toContainText("Eats: Porridge");
  // Two months old and still on the page: a reaction does not expire.
  await expect(card).toContainText("Has reacted to: Egg");

  await card.getByLabel("Comfort items").fill("Cuddly rabbit and a dummy");
  await expect(card).toContainText("Comfort items: Cuddly rabbit and a dummy");

  // Leave the food section out: its lines go from the preview.
  await card.getByRole("switch", { name: /^Food/ }).click();
  await expect(card).not.toContainText("Has reacted to");
  await card.screenshot({ path: shot("card.png") });

  const downloadPromise = page.waitForEvent("download");
  await card.getByRole("button", { name: /Make the page/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("pjokk-baby-about-about.pdf");
  const path = await download.path();
  await download.saveAs(shot("about.pdf"));
  const { statSync, readFileSync } = await import("node:fs");
  expect(statSync(path!).size).toBeGreaterThan(1500);
  expect(readFileSync(path!).subarray(0, 5).toString()).toBe("%PDF-");

  // Making the page saved the typed line beside the baby.
  const saved = await (
    await page.request.get(`/api/babies/${babyId}/about`)
  ).json();
  expect(saved.comfort).toBe("Cuddly rabbit and a dummy");
});
