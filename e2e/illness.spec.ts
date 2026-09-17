import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// Illness episodes (issue #107, spec 2026-09-17-illness-and-care-days): a
// card on Home while she is ill, a symptom-free clock against the family's
// own number of hours, and a span row on the timeline.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/illness-shots";
const shot = (name: string) => join(SHOT_DIR, name);

async function firstBabyId(page: Page): Promise<string> {
  const babies = await (await page.request.get("/api/babies")).json();
  return babies[0].id as string;
}

test("an illness from More: the card, the clock, a fever that moves it, recovered", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "illness");
  const babyId = await firstBabyId(page);

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Illness", exact: true }).click();
  const sheet = page.getByRole("dialog");
  const hours = sheet.getByRole("group", {
    name: "Symptom-free hours before daycare",
  });
  // No suggestion for a cough; FHI's 48 h once vomiting is ticked.
  await sheet.getByRole("button", { name: "Cough", exact: true }).click();
  await expect(hours.getByRole("button", { name: "None" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await sheet.getByRole("button", { name: "Vomiting", exact: true }).click();
  await expect(hours.getByRole("button", { name: "48 h" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await sheet.screenshot({ path: shot("sheet.png") });
  await sheet.getByRole("button", { name: "Save", exact: true }).click();

  const clock = page.getByTestId("illness-clock");
  await expect(clock).toHaveText("Still has symptoms", { timeout: 10_000 });
  await expect(page.getByText("cough · vomiting")).toBeVisible();

  await page.getByRole("button", { name: "Symptom-free now" }).click();
  await expect(clock).toContainText("Symptom-free since Today");
  await expect(clock).toContainText("48 h on");
  await page.screenshot({ path: shot("home-counting.png") });

  // A fever logged afterwards is a symptom nobody told the card about: the
  // clock restarts from the reading. Seeded a minute ahead so it is
  // unambiguously later than the tap above.
  const feverAt = new Date(Date.now() + 60_000);
  const before = await clock.textContent();
  const fever = await page.request.post("/api/measurements", {
    data: {
      babyId,
      time: feverAt.toISOString(),
      type: "temperature",
      value: 38.6,
    },
  });
  expect(fever.ok(), `seed fever: ${fever.status()}`).toBeTruthy();
  await page.reload();
  await expect(clock).toContainText("48 h on", { timeout: 10_000 });
  const hhmm = feverAt.toLocaleTimeString("nb-NO", {
    hour: "2-digit",
    minute: "2-digit",
  });
  await expect(clock).toContainText(`Symptom-free since Today ${hhmm}`);
  expect(before).not.toBeNull();

  // The More tile opens the episode she already has, not a second one.
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Illness", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Edit illness")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Recovered", exact: true }).click();
  await expect(clock).toHaveCount(0, { timeout: 10_000 });

  await page.goto("/timeline");
  const row = page.getByRole("button").filter({ hasText: /^Illness/ });
  await expect(row.first()).toContainText("cough · vomiting · 1 day", {
    timeout: 10_000,
  });
  await page.screenshot({ path: shot("timeline.png") });
});
