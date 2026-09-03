import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

test("starts a sleep session, sees the banner, wakes", async ({ page, request }) => {
  await freshFamily(page, request, "sleep");

  await page.getByRole("button", { name: "Sleep", exact: true }).click();
  // Starting a session is "Start sleep"; "Save" belongs to the edit sheet.
  await page.getByRole("button", { name: "Start sleep" }).click();

  // The active-session banner takes over Home.
  await expect(page.getByText("Sleeping").first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Wake" }).click();

  await expect(page.getByText("Sleeping")).toHaveCount(0, { timeout: 10_000 });
});
