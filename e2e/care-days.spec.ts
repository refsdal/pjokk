import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// Days at home with an ill child (issue #108): a tap on a face on the
// illness card, counted per person per year in Settings against a number
// each sets for themselves.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/care-days-shots";
const shot = (name: string) => join(SHOT_DIR, name);

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function firstBabyId(page: Page): Promise<string> {
  const babies = await (await page.request.get("/api/babies")).json();
  return babies[0].id as string;
}

test("home today on the illness card, then the year in Settings", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "caredays");
  await page.request.patch("/api/me", { data: { name: "Anne Admin" } });
  const babyId = await firstBabyId(page);
  const ill = await page.request.post("/api/illness", {
    data: {
      babyId,
      startTime: new Date(Date.now() - 80 * 3_600_000).toISOString(),
      symptoms: ["fever"],
    },
  });
  expect(ill.ok(), `seed illness: ${ill.status()}`).toBeTruthy();
  // The three days before today, already at home: today makes four in a row.
  for (const back of [3, 2, 1]) {
    const d = new Date();
    d.setDate(d.getDate() - back);
    const res = await page.request.post("/api/care-days", {
      data: { date: localDate(d) },
    });
    expect(res.ok(), `seed day -${back}: ${res.status()}`).toBeTruthy();
  }
  await page.goto("/home");

  const chips = page.getByTestId("home-today-chips");
  const me = chips.getByRole("button", { name: /Anne/ });
  await expect(me).toHaveAttribute("aria-pressed", "false", { timeout: 10_000 });
  await expect(page.getByTestId("day-four")).toHaveCount(0);

  // One tap: a whole day. The fourth in a row gets its quiet note.
  await me.click();
  await expect(me).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("day-four")).toContainText(
    "An employer may ask for a doctor's note",
  );
  await page.screenshot({ path: shot("home.png") });
  // A second tap: half a day. A third: not home after all.
  await me.click();
  await expect(me).toContainText("half day");
  await me.click();
  await expect(me).toHaveAttribute("aria-pressed", "false");
  await me.click();
  await expect(me).toHaveAttribute("aria-pressed", "true");

  // Settings: four days, no number set, so no "of".
  await page.goto("/settings/family/care-days");
  const total = page.getByTestId("care-total-me");
  await expect(total).toHaveText("4 days", { timeout: 10_000 });
  const section = page.getByTestId("care-days");
  await section.getByRole("button", { name: "Set days" }).click();
  await section.getByRole("button", { name: "Save", exact: true }).click();
  await expect(total).toHaveText("4 of 10 days");
  await section.screenshot({ path: shot("settings.png") });

  // Removing a day counts down.
  await section.getByRole("button", { name: "Delete" }).first().click();
  await expect(total).toHaveText("3 of 10 days");
});
