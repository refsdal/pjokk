import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// The WHO growth chart on Stats (issue #47): weight, length and head
// circumference against the P3/P50/P97 reference curves, switched with
// chips. The chart needs the baby's sex; the fixture baby has none, so the
// spec sets it first. The values logged are the WHO medians for a girl at
// those ages, so every dot should sit on the middle line.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/growth-shots";
const shot = (name: string) => join(SHOT_DIR, name);

// Scroll to the end first: the growth card is the last thing on Stats and
// the page's bottom padding keeps it clear of the fixed tab bar only there.
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
}

test("the growth chart switches between weight, length and head", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "growth");
  const babies = await (await page.request.get("/api/babies")).json();
  const baby = babies[0];
  const set = await page.request.patch(`/api/babies/${baby.id}`, {
    data: { sex: "girl" },
  });
  expect(set.status(), await set.text()).toBe(200);

  // Born 2026-06-15: birth, one month, two months (WHO girls' medians).
  const birth = new Date(baby.birthDate);
  const at = (months: number) =>
    new Date(birth.getTime() + months * 30.4375 * 24 * 3600_000).toISOString();
  const rows: [string, number, number][] = [
    ["weight", 0, 3.2322],
    ["weight", 1, 4.1873],
    ["weight", 2, 5.1282],
    ["length", 0, 49.1477],
    ["length", 1, 53.6872],
    ["length", 2, 57.0673],
    ["head", 0, 33.8787],
    ["head", 1, 36.5463],
    ["head", 2, 38.2521],
  ];
  for (const [type, months, value] of rows) {
    const res = await page.request.post("/api/measurements", {
      data: { babyId: baby.id, time: at(months), type, value },
    });
    expect(res.status(), await res.text()).toBe(201);
  }

  // The card sits below the fold on a phone, so the screenshots are of
  // the card itself (its title's parent), not the viewport.
  const card = (title: string) => page.getByText(title, { exact: true }).locator("..");

  await page.goto("/stats");
  await expect(card("Growth (WHO weight-for-age)")).toBeVisible({ timeout: 10_000 });
  await settle(page);
  await card("Growth (WHO weight-for-age)").screenshot({ path: shot("1-stats-weight.png") });

  await page.getByRole("button", { name: "Length (cm)", exact: true }).click();
  await expect(card("Growth (WHO length-for-age)")).toBeVisible();
  await settle(page);
  await card("Growth (WHO length-for-age)").screenshot({ path: shot("2-stats-length.png") });

  await page.getByRole("button", { name: "Head (cm)", exact: true }).click();
  await expect(card("Growth (WHO head-for-age)")).toBeVisible();
  await settle(page);
  await card("Growth (WHO head-for-age)").screenshot({ path: shot("3-stats-head.png") });
});
