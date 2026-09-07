import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// The medicine catalogue (issue #49), against the real artifact: two
// entries added under Settings → Medicines (one with a 6 h interval, one
// supplement), the log sheet offering them as chips and prefilling the
// dose, and — once a dose is logged — the "Next dose OK from" caution on
// the sheet and on the timeline's newest dose. The API itself is covered
// by internal/api/medicine_catalogue_test.go.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/medicine-shots";
const shot = (name: string) => join(SHOT_DIR, name);

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
}

test("catalogue entries become chips with a prefilled dose and a next-dose caution", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "medicine");

  // ---- Settings → Medicines: paracetamol every 6 h, vitamin D supplement --
  await page.goto("/settings");
  await page.getByRole("button", { name: "Add medicine" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByPlaceholder("Name (e.g. Paracetamol)").fill("Paracetamol");
  await sheet.getByRole("button", { name: "6 h", exact: true }).click();
  await settle(page);
  await page.screenshot({ path: shot("1-add-medicine-sheet.png") });
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("2.5 ml · every 6 h")).toBeVisible({
    timeout: 10_000,
  });

  await page.getByRole("button", { name: "Add medicine" }).click();
  await sheet.getByPlaceholder("Name (e.g. Paracetamol)").fill("Vitamin D");
  await sheet.getByRole("button", { name: "drops", exact: true }).click();
  await sheet.getByLabel("increase drops").click();
  await sheet.getByRole("button", { name: "Supplement", exact: true }).click();
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("3 drops · supplement")).toBeVisible({
    timeout: 10_000,
  });
  await settle(page);
  await page
    .getByText("Medicines", { exact: true })
    .locator("xpath=following-sibling::*[1]")
    .screenshot({ path: shot("2-medicines-list.png") });

  // ---- The log sheet: chips, prefilled dose, save ------------------------
  await page.goto("/home");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Medicine", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "Other…" })).toBeVisible();
  await sheet.getByRole("button", { name: "Paracetamol", exact: true }).click();
  await expect(sheet.getByLabel("ml", { exact: true })).toHaveValue("2.5");
  // No dose yet: nothing to caution about.
  await expect(sheet.getByText("Next dose OK from")).toHaveCount(0);
  await settle(page);
  await page.screenshot({ path: shot("3-log-sheet-chips.png") });
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();

  // ---- Reopen: last-value prefill keeps the chip, and the caution shows --
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Medicine", exact: true }).click();
  await expect(
    sheet.getByRole("button", { name: "Paracetamol", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(sheet.getByText("Next dose OK from")).toBeVisible({
    timeout: 10_000,
  });
  await settle(page);
  await page.screenshot({ path: shot("4-next-dose-caution.png") });
  // The supplement never cautions.
  await sheet.getByRole("button", { name: "Vitamin D", exact: true }).click();
  await expect(sheet.getByText("Next dose OK from")).toHaveCount(0);
  await expect(sheet.getByLabel("drops", { exact: true })).toHaveValue("3.0");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // ---- Timeline: the newest dose carries the note -------------------------
  await page.goto("/timeline");
  const row = page.getByRole("button", { name: /^Paracetamol · 2.5 ml/ });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText(/next \d\d:\d\d/);
  await settle(page);
  await page.screenshot({ path: shot("5-timeline-next-dose.png") });
});
