import { join } from "node:path";
import { expect, test } from "./fixtures";
import { freshFamily, openBabySettings } from "./helpers";

// The barnehage small items (issue #113): a preset for the custom reminder
// every barnehage family ends up writing by hand, and a medicine sheet for
// the staff, who may not give medicine without written instructions.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/daycare-small-shots";
const shot = (name: string) => join(SHOT_DIR, name);

test("the spare-clothes preset fills an ordinary custom reminder", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "spares");
  await page.goto("/profile");
  await page.getByRole("button", { name: "Add reminder", exact: true }).click();
  const sheet = page.getByRole("dialog");
  // The preset belongs to Custom, and only shows there.
  await expect(sheet.getByRole("button", { name: "Spare clothes, Fridays" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Custom", exact: true }).click();
  await sheet.getByRole("button", { name: "Spare clothes, Fridays" }).click();
  await expect(sheet.getByPlaceholder("What to remind about")).toHaveValue(
    "Check spare clothes and diapers",
  );
  await expect(sheet.getByLabel("Time")).toHaveValue("15:00");
  await expect(sheet.getByRole("button", { name: "Fridays", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await sheet.screenshot({ path: shot("reminder.png") });
  await sheet.getByRole("button", { name: "Add reminder", exact: true }).click();
  await expect(sheet).toBeHidden();

  const row = page.getByText("Check spare clothes and diapers", { exact: true }).locator("..");
  await expect(row).toContainText("at 15:00", { timeout: 10_000 });
  await expect(row).toContainText("Fri");
});

test("the medicine sheet for daycare downloads once there is a medicine", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "medsheet");
  await openBabySettings(page);
  // Nothing to print from an empty catalogue.
  await expect(page.getByRole("button", { name: /Sheet for daycare/ })).toBeDisabled();

  const made = await page.request.post("/api/medicines", {
    data: { name: "Paracet", defaultAmount: 2.5, unit: "ml", minIntervalMin: 360 },
  });
  expect(made.status(), await made.text()).toBe(201);
  await page.reload();

  const button = page.getByRole("button", { name: /Sheet for daycare/ });
  await expect(button).toBeVisible({ timeout: 10_000 });
  const downloadPromise = page.waitForEvent("download");
  await button.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("pjokk-baby-medsheet-medicines.pdf");
  const path = await download.path();
  await download.saveAs(shot("medicines.pdf"));
  const { statSync, readFileSync } = await import("node:fs");
  expect(statSync(path!).size).toBeGreaterThan(1500);
  expect(readFileSync(path!).subarray(0, 5).toString()).toBe("%PDF-");
});
