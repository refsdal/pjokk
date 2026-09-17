import { join } from "node:path";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// Barnehage days against home days in Stats (issue #111): is the single
// midday nap pushing bedtime? One card, shown only once the window holds
// both kinds of day, and the chart marks the days she was there.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/stats-daycare-shots";
const shot = (name: string) => join(SHOT_DIR, name);

test("the split appears once there are barnehage days and home days", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "statsplit");
  const babies = await (await page.request.get("/api/babies")).json();
  const babyId = babies[0].id as string;
  const at = (daysAgo: number, h: number, m: number) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const post = async (path: string, data: Record<string, unknown>) => {
    const res = await page.request.post(path, { data: { babyId, ...data } });
    expect(res.status(), `${path}: ${await res.text()}`).toBe(201);
  };

  await page.goto("/stats");
  await expect(page.getByTestId("daycare-split")).toHaveCount(0);

  // Days 6–3 ago at barnehage (one-hour nap, bed 18:50); days 2–1 ago at
  // home (two-hour nap, bed 19:20). Local clock times, so the averages are
  // exact in any zone.
  for (const d of [6, 5, 4, 3]) {
    await post("/api/daycare", { startTime: at(d, 8, 0), endTime: at(d, 15, 30) });
    await post("/api/sleep", { startTime: at(d, 11, 30), endTime: at(d, 12, 30), type: "nap" });
    await post("/api/sleep", { startTime: at(d, 18, 50), endTime: at(d - 1, 6, 20), type: "night" });
  }
  for (const d of [2, 1]) {
    await post("/api/sleep", { startTime: at(d, 12, 0), endTime: at(d, 14, 0), type: "nap" });
    await post("/api/sleep", { startTime: at(d, 19, 20), endTime: at(d - 1, 6, 20), type: "night" });
  }

  await page.reload();
  const card = page.getByTestId("daycare-split");
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText("Daycare days (4)");
  await expect(card).toContainText("bed 18:50");
  await expect(card).toContainText("Home days (2)");
  await expect(card).toContainText("bed 19:20");
  // Seven cells under seven bars, four of them marked.
  const marks = page.getByTestId("daycare-marks").locator("> span");
  await expect(marks).toHaveCount(7);
  await expect(page.getByTestId("daycare-marks").locator(".bg-accent")).toHaveCount(4);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot("stats.png"), fullPage: true });
});

// Ill days (issue #127): "how much has she actually been ill?". One quiet
// row, only when the window has any, and the chart rings the days.
test("ill days are counted against the window and ringed under the chart", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "illdays");
  const babies = await (await page.request.get("/api/babies")).json();
  const babyId = babies[0].id as string;
  const at = (daysAgo: number, h: number) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(h, 0, 0, 0);
    return d.toISOString();
  };

  await page.goto("/stats");
  await expect(page.getByText("Sleep per day")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("ill-days")).toHaveCount(0);

  // Three days of it, four to two days ago; over since.
  const ill = await page.request.post("/api/illness", {
    data: { babyId, startTime: at(4, 15), endTime: at(2, 9), symptoms: ["vomiting"] },
  });
  expect(ill.status(), await ill.text()).toBe(201);

  await page.reload();
  await expect(page.getByTestId("ill-days-value")).toHaveText("3 of 7 days · 1 episode", {
    timeout: 10_000,
  });
  await expect(page.getByTestId("daycare-marks").locator('[data-ill="true"]')).toHaveCount(3);
  await expect(page.getByText("ill that day")).toBeVisible();
  await page.getByTestId("ill-days").scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot("ill-days.png"), fullPage: true });

  // The month view counts the same days against thirty.
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(page.getByTestId("ill-days-value")).toHaveText("3 of 30 days · 1 episode", {
    timeout: 10_000,
  });
});
