import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// Reminders (issue #45) in Settings → Notifications, against the real
// artifact: add a feed-gap reminder and a fixed-time custom one from the
// sheet, see both described in the list, delete one. The push itself is
// not observable here (the e2e stack has no VAPID keys); the sweep that
// sends it is covered by internal/jobs/reminders_test.go.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/reminder-shots";
const shot = (name: string) => join(SHOT_DIR, name);

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
}

test("adds a gap reminder and a fixed-time reminder, then removes one", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "reminders");

  await page.goto("/settings");
  const section = page.getByText("No reminders yet", { exact: false });
  await expect(section).toBeVisible({ timeout: 10_000 });

  // ---- A feed gap: the defaults are the whole reminder ------------------
  await page.getByRole("button", { name: "Add reminder", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "Add reminder" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "3 h", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await settle(page);
  await page.screenshot({ path: shot("1-sheet-feed-gap.png") });
  await sheet.getByRole("button", { name: "Add reminder", exact: true }).click();
  await expect(sheet).toBeHidden();

  const feedRow = page.getByText("Feed", { exact: true }).locator("..");
  await expect(feedRow).toBeVisible({ timeout: 10_000 });
  await expect(feedRow).toContainText("after 3 h");
  await expect(feedRow).toContainText("quiet 22:00–07:00");

  // ---- A custom fixed time on weekdays ----------------------------------
  await page.getByRole("button", { name: "Add reminder", exact: true }).click();
  await sheet.getByRole("button", { name: "Custom", exact: true }).click();
  await sheet.getByPlaceholder("What to remind about").fill("Vitamin D");
  await sheet.getByLabel("Time").fill("09:00");
  await sheet.getByRole("button", { name: "Weekdays", exact: true }).click();
  await settle(page);
  await page.screenshot({ path: shot("2-sheet-custom-time.png") });
  await sheet.getByRole("button", { name: "Add reminder", exact: true }).click();
  await expect(sheet).toBeHidden();

  const customRow = page.getByText("Vitamin D", { exact: true }).locator("..");
  await expect(customRow).toBeVisible({ timeout: 10_000 });
  await expect(customRow).toContainText("at 09:00");
  await expect(customRow).toContainText("Weekdays");
  await settle(page);
  // The list, both rows visible.
  await page
    .getByText("Reminders", { exact: true })
    .locator("..")
    .screenshot({ path: shot("3-reminder-list.png") });

  // ---- Delete the feed one; the custom one stays -------------------------
  await feedRow.locator("..").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("after 3 h")).toHaveCount(0, { timeout: 10_000 });
  await expect(customRow).toBeVisible();
});
