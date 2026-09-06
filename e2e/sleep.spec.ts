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
  // Awake now: the card reads the wake window as a duration, not "N ago",
  // and counts the session that just ended among today's naps.
  await expect(page.getByText("Awake", { exact: true })).toBeVisible();
  await expect(page.getByText("under a minute")).toBeVisible();
  await expect(page.getByText(/^1 nap · /)).toBeVisible();
});

test("tapping the sleep banner opens the edit sheet for the running session", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "sleep-edit");

  await page.getByRole("button", { name: "Sleep", exact: true }).click();
  await page.getByRole("button", { name: "Start sleep" }).click();
  await expect(page.getByText("Sleeping").first()).toBeVisible({ timeout: 10_000 });

  // The banner body is its own control, next to Wake — the same edit sheet
  // a timeline row opens, for fixing a start time logged late.
  await page.getByRole("button", { name: "Edit sleep" }).click();
  await expect(page.getByRole("heading", { name: "Edit sleep" })).toBeVisible();
  // A running session has no end time to edit; the sheet says so.
  await expect(page.getByText("Still sleeping")).toBeVisible();
  await page.getByPlaceholder("Note (optional)").fill("nap after lunch");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  // Saving edits the session rather than starting a second one: the banner
  // is still there, and Wake still ends it.
  await expect(page.getByRole("heading", { name: "Edit sleep" })).toHaveCount(0);
  await expect(page.getByText("Sleeping").first()).toBeVisible();
  await page.getByRole("button", { name: "Wake" }).click();
  await expect(page.getByText("Sleeping")).toHaveCount(0, { timeout: 10_000 });

  // The note landed on the one and only sleep entry: the timeline row (notes
  // render there as an icon, not text) opens the same sheet with it filled.
  await page.goto("/timeline");
  // The row, not the "Sleep" filter chip: the row's name carries its detail.
  await page.getByRole("button", { name: /^Sleep · / }).first().click();
  await expect(page.getByRole("heading", { name: "Edit sleep" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByPlaceholder("Note (optional)")).toHaveValue("nap after lunch");
});
