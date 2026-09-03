import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

test("logs a feed from the sheet; Home and Timeline show it", async ({ page, request }) => {
  await freshFamily(page, request, "feed");

  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await page.getByRole("button", { name: "Save" }).click();

  // Home's status card reflects the entry ("1 feeds · N ml today").
  await expect(page.getByText(/1 feeds/)).toBeVisible({ timeout: 10_000 });

  await page.goto("/timeline");
  await expect(page.getByText(/1 feed/).or(page.getByText(/bottle|breast/i)).first()).toBeVisible();
});
