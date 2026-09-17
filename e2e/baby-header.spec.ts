import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// The baby header: the babies in a fixed row on every baby screen, the
// current one a pill, the others faces — and a photo of the baby, set on
// the baby's settings page, that shows in that row.

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

test("a photo of the baby shows in the header", async ({ page, request }) => {
  await freshFamily(page, request, "babyphoto");

  await page.goto("/settings");
  await page.getByRole("link", { name: /Baby babyphoto/ }).click();
  await expect(page).toHaveURL(/\/settings\/baby\//);
  await page.getByLabel("Change photo").setInputFiles({
    name: "baby.png",
    mimeType: "image/png",
    buffer: PNG_1x1,
  });
  await expect(page.getByText("Photo updated")).toBeVisible({ timeout: 10_000 });

  await page.goto("/home");
  const header = page.locator("header").first();
  await expect(header.getByText("Baby babyphoto")).toBeVisible();
  await expect(header.locator("img").first()).toBeVisible();

  // The same header on Timeline.
  await page.goto("/timeline");
  await expect(page.locator("header").first().locator("img").first()).toBeVisible();

  await page.goto("/settings");
  await page.getByRole("link", { name: /Baby babyphoto/ }).click();
  await page.getByRole("button", { name: "Remove photo" }).click();
  await expect(page.getByText("Photo removed")).toBeVisible();
  await page.goto("/home");
  await expect(page.locator("header").first().locator("img")).toHaveCount(0);
});

test("a second baby joins the row and one tap switches", async ({ page, request }) => {
  await freshFamily(page, request, "twobabies");

  await page.goto("/settings");
  await page.getByRole("button", { name: "Add baby" }).click();
  await page.getByPlaceholder("Baby's name").fill("Oskar");
  await page.getByLabel("Birth date").fill("2024-01-10");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("link", { name: /Oskar/ })).toBeVisible();

  await page.goto("/home");
  // The first baby is the pill (pressed, name as text); Oskar is a face
  // named for the screen reader, to the RIGHT of it.
  const first = page.getByRole("button", { name: "Baby twobabies", pressed: true });
  const oskar = page.getByRole("button", { name: "Oskar", exact: true });
  await expect(first).toBeVisible();
  await expect(oskar).toHaveAttribute("aria-pressed", "false");
  const firstBox = await first.boundingBox();
  const oskarBox = await oskar.boundingBox();
  expect(oskarBox!.x).toBeGreaterThan(firstBox!.x);

  await oskar.click();
  await expect(page.getByRole("button", { name: "Oskar", pressed: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Baby twobabies", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  // The order did not change: the first baby's face stays on the left.
  const firstAfter = await page.getByRole("button", { name: "Baby twobabies", exact: true }).boundingBox();
  const oskarAfter = await page.getByRole("button", { name: "Oskar", pressed: true }).boundingBox();
  expect(firstAfter!.x).toBeLessThan(oskarAfter!.x);

  // The selection follows to Stats.
  await page.goto("/stats");
  await expect(page.getByRole("button", { name: "Oskar", pressed: true })).toBeVisible();
});
