import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// Stats' night numbers (issue #50), against the real artifact: two night
// sessions and a nap seeded through the API, then the sleep card's
// night/day split, the stacked chart, the "Longest stretch" row and the
// intake card's feeds by type. The bucketing itself is covered by
// internal/api/stats_nights_test.go; this is the screen.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/stats-shots";
const shot = (name: string) => join(SHOT_DIR, name);

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
}

test("stats show the night/day split, the longest stretch and feeds by type", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "stats");
  const babies = await (await page.request.get("/api/babies")).json();
  const babyId = babies[0].id as string;

  const h = 3600_000;
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const post = async (path: string, data: Record<string, unknown>) => {
    const res = await page.request.post(path, { data: { babyId, ...data } });
    expect(res.status(), await res.text()).toBe(201);
  };
  // Last night: 3 h, then a 3 h 30 stretch after a waking; a 1 h nap today.
  await post("/api/sleep", { startTime: iso(20 * h), endTime: iso(17 * h), type: "night" });
  await post("/api/sleep", { startTime: iso(16.5 * h), endTime: iso(13 * h), type: "night" });
  await post("/api/sleep", { startTime: iso(4 * h), endTime: iso(3 * h), type: "nap" });
  await post("/api/feeds", { time: iso(12 * h), type: "bottle", amountMl: 120 });
  await post("/api/feeds", { time: iso(8 * h), type: "breast", side: "left" });
  await post("/api/feeds", { time: iso(2 * h), type: "bottle", amountMl: 150 });

  await page.goto("/stats");
  const stretch = page.getByText("Longest stretch", { exact: true }).locator("..");
  await expect(stretch).toContainText("3 h 30 m", { timeout: 10_000 });
  await expect(stretch).toContainText(/waking/);
  await expect(page.getByText(/night · .* day/)).toBeVisible();
  await expect(page.getByText(/bottle/)).toBeVisible();
  await settle(page);
  await page.screenshot({ path: shot("1-stats-week.png") });

  await page.getByRole("button", { name: "Day", exact: true }).click();
  await expect(page.getByText("Sleep today")).toBeVisible();
  // The night before a one-day window still counts as "last night".
  await expect(stretch).toContainText("3 h 30 m");
  await settle(page);
  await page.screenshot({ path: shot("2-stats-day.png") });
});
