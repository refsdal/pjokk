import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// Issue #53 against the real artifact: imperial display units chosen on
// the profile change what Home, the feed sheet's stepper and the timeline
// show without touching what is stored (the API still answers in ml), and
// the PDF report downloads with the expected name.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/units-shots";
const shot = (name: string) => join(SHOT_DIR, name);

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
}

test("imperial units are a display preference; the stored values stay metric", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "units");
  const babies = await (await page.request.get("/api/babies")).json();
  const babyId = babies[0].id as string;
  const now = Date.now();
  const post = async (path: string, data: Record<string, unknown>) => {
    const res = await page.request.post(path, { data: { babyId, ...data } });
    expect(res.status(), await res.text()).toBe(201);
  };
  await post("/api/feeds", { time: new Date(now - 3600_000).toISOString(), type: "bottle", amountMl: 120 });
  await post("/api/measurements", { time: new Date(now - 1800_000).toISOString(), type: "temperature", value: 38.4 });
  await post("/api/measurements", { time: new Date(now - 7200_000).toISOString(), type: "weight", value: 5.2 });

  await page.goto("/profile");
  // e2e accounts start without a name, and the profile refuses a blank one.
  await page.getByLabel("Full name").fill("Units Tester");
  await page.getByRole("button", { name: "Imperial (oz, lb, in, °F)" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Profile saved")).toBeVisible();

  await page.goto("/home");
  await expect(page.getByText("4.1 oz", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/101\.1 °F/)).toBeVisible();
  await settle(page);
  await page.screenshot({ path: shot("1-home-imperial.png") });

  // The feed sheet's stepper prefills 4.1 oz; one step up saves 136 ml.
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByLabel("oz", { exact: true })).toHaveValue("4.1");
  await settle(page);
  await page.screenshot({ path: shot("2-feed-sheet-oz.png") });
  await sheet.getByLabel("increase oz").click();
  await expect(sheet.getByLabel("oz", { exact: true })).toHaveValue("4.6");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  const feeds = await (await page.request.get(`/api/feeds?babyId=${babyId}&limit=1`)).json();
  expect(feeds[0].amountMl).toBe(136);

  await page.goto("/timeline");
  await expect(page.getByRole("button", { name: /^Bottle · 4\.6 oz/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /^Weight · 11\.5 lb/ })).toBeVisible();

  await page.goto("/stats");
  await expect(page.getByText("11.5 lb")).toBeVisible({ timeout: 10_000 });
});

test("the PDF report downloads with the baby's name and the range in the file name", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "report");
  const babies = await (await page.request.get("/api/babies")).json();
  const babyId = babies[0].id as string;
  const h = 3600_000;
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  for (const data of [
    ["/api/feeds", { time: iso(20 * h), type: "bottle", amountMl: 120 }],
    ["/api/feeds", { time: iso(4 * h), type: "breast", side: "left" }],
    ["/api/sleep", { startTime: iso(14 * h), endTime: iso(9 * h), type: "night" }],
    ["/api/diapers", { time: iso(3 * h), type: "wet" }],
    ["/api/measurements", { time: iso(30 * h), type: "weight", value: 5.2 }],
    ["/api/measurements", { time: iso(2 * h), type: "temperature", value: 38.4 }],
    ["/api/medicine", { time: iso(2 * h), name: "Paracetamol", amount: 2.5, unit: "ml" }],
  ] as const) {
    const res = await page.request.post(data[0], { data: { babyId, ...data[1] } });
    expect(res.status(), await res.text()).toBe(201);
  }
  await page.goto("/settings");
  const card = page.getByText("PDF report", { exact: true }).locator("xpath=following-sibling::*[1]");
  await card.scrollIntoViewIfNeeded();
  await settle(page);
  await card.screenshot({ path: shot("3-settings-report.png") });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download PDF report/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^pjokk-baby-report-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.pdf$/);
  const path = await download.path();
  expect(path).not.toBeNull();
  // Keep the file next to the screenshots so a reviewer can open it.
  await download.saveAs(shot("4-report.pdf"));
  const { statSync, readFileSync } = await import("node:fs");
  expect(statSync(path!).size).toBeGreaterThan(2000);
  expect(readFileSync(path!).subarray(0, 5).toString()).toBe("%PDF-");
});
