import { expect, test } from "@playwright/test";
import { freshFamily } from "./helpers";

test("creates a family and a baby, and Home shows the status cards", async ({ page, request }) => {
  await freshFamily(page, request, "family");

  await expect(page.getByText("Baby family").first()).toBeVisible();
  await expect(page.getByText("Last feed")).toBeVisible();
  await expect(page.getByText("Last diaper")).toBeVisible();
});
