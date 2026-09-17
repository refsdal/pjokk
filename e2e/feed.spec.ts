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

// How much of a meal she ate (issue #113): nobody weighs a toddler's lunch,
// so an appetite alone says how it went, and the prefilled grams — never
// stepped — are not saved as if they were a measurement.
test("a solids meal logged by appetite says how it went, without grams", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "appetite");

  await page.getByRole("button", { name: "Feed", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Solids", exact: true }).click();
  const well = sheet.getByRole("button", { name: "Well", exact: true });
  await well.click();
  await expect(well).toHaveAttribute("aria-pressed", "true");
  await sheet.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText("ate well")).toBeVisible({ timeout: 10_000 });

  await page.goto("/timeline");
  const row = page.getByRole("button").filter({ hasText: "ate well" });
  await expect(row.first()).toBeVisible({ timeout: 10_000 });
  await expect(row.first()).not.toContainText(" g ");

  // The edit sheet opens on it, and saving untouched keeps it gramless.
  await row.first().click();
  const edit = page.getByRole("dialog");
  await expect(
    edit.getByRole("button", { name: "Well", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await edit.getByRole("button", { name: "Little", exact: true }).click();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("button").filter({ hasText: "ate little" }).first(),
  ).toBeVisible({ timeout: 10_000 });
  const babies = await (await page.request.get("/api/babies")).json();
  const feeds = await (
    await page.request.get(`/api/feeds?babyId=${babies[0].id}`)
  ).json();
  expect(feeds[0].appetite).toBe("little");
  expect(feeds[0].amountMl).toBeNull();
});
