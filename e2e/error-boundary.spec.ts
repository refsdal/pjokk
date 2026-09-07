import { join } from "node:path";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// The error boundary, reproduced with the bug that motivated it: a Stats
// response of an older shape (no `nights`, no `avgFeedsByType`) crashed
// the screen on `nights.length`. Serving that shape makes the screen
// throw; the boundary catches it, says so in plain words, and "Try again"
// recovers once the real response is back.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/error-shots";
const shot = (name: string) => join(SHOT_DIR, name);

// page.route() cannot see a fetch made by the service worker.
test.use({ serviceWorkers: "block" });

test("a render error shows the recovery screen and Try again recovers", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "boundary");

  await page.route("**/api/stats?**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        days: [],
        avgSleepMin: 0,
        avgIntakeMl: 0,
        avgFeeds: 0,
        avgDiapers: 0,
        weight: null,
      }),
    }),
  );
  await page.goto("/stats");
  await expect(page.getByText("Something went wrong")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(/reading 'length'/)).toBeVisible();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot("1-error-screen.png") });

  await page.unroute("**/api/stats?**");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Sleep / day")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Something went wrong")).toBeHidden();
});
