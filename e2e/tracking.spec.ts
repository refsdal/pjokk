import { expect, test } from "./fixtures";
import {
  ALL_FEATURES,
  apiSignIn,
  apiSignup,
  enrolKiosk,
  freshEmail,
  freshFamily,
  openBabySettings,
} from "./helpers";

// Per-baby tracking switches (spec
// docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md): a new
// baby chooses on the carousel, a switch that is off hides its entry
// points everywhere and keeps its history, and the kiosk follows too.

test("a new baby chooses on the carousel; the recommended set reflows Home", async ({
  page,
  request,
}) => {
  const email = freshEmail("tracking-new");
  await apiSignup(request, email);
  await apiSignIn(page, email);
  await page.goto("/");
  await expect(page.getByText("Set up your family")).toBeVisible();
  await page.getByPlaceholder(/Family name/).fill("The tracking family");
  await page.getByRole("button", { name: "Create family" }).click();
  await expect(page.getByText("Who are we tracking?")).toBeVisible();
  await page.getByPlaceholder("Baby's name").fill("Ida");
  const born = new Date();
  born.setMonth(born.getMonth() - 3); // three months old: the newborn band
  await page.getByLabel("Birth date").fill(born.toISOString().slice(0, 10));
  await page.getByRole("button", { name: "Add baby" }).click();

  await expect(page).toHaveURL(/\/settings\/baby\/[^/]+\/tracking\?new=/);
  await expect(page.getByTestId("tracking-card-feeds")).toBeVisible();
  // The first card carries the recommended-set card on top: the switch
  // must still sit inside the strip with room for the light-up ring, and
  // the strip must never scroll vertically (it clips the ring otherwise).
  const fit = await page.evaluate(() => {
    const strip = document.querySelector('[data-testid="tracking-strip"]') as HTMLElement;
    const s = strip.getBoundingClientRect();
    const b = document
      .querySelector('[data-testid="tracking-card-feeds"] [role=switch]')!
      .getBoundingClientRect();
    return {
      right: s.right - b.right,
      bottom: s.bottom - b.bottom,
      overflow: strip.scrollHeight - strip.clientHeight,
    };
  });
  expect(fit.overflow).toBe(0);
  expect(fit.right).toBeGreaterThanOrEqual(14);
  expect(fit.bottom).toBeGreaterThanOrEqual(14);
  // Every card is a switch, off until chosen.
  await expect(
    page.getByTestId("tracking-card-feeds").getByRole("switch"),
  ).toHaveAttribute("aria-checked", "false");
  await page.getByTestId("use-recommended").click();
  const summary = page.getByTestId("tracking-summary");
  await expect(summary).toContainText("Feeds");
  await expect(summary).toContainText("Sleep");
  await expect(summary).toContainText("Diapers");
  await expect(summary).toContainText("Growth and temperature");
  await expect(summary).not.toContainText("Milestones");
  await page.getByTestId("tracking-done").click();

  await expect(page).toHaveURL(/\/home/);
  await expect(page.getByRole("button", { name: "Feed", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Diaper", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sleep", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "More", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("button", { name: "Measurement" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Medicine" })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Ask for help" })).toBeVisible();
});

test("switching Feeds off hides its entry points and keeps its history", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "tracking-off");
  // One feed on the record first.
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/1 feeds/)).toBeVisible({ timeout: 10_000 });

  await openBabySettings(page);
  await page.getByRole("link", { name: /What to track/ }).click();
  await expect(page).toHaveURL(/\/tracking$/);
  const feeds = page.getByTestId("tracking-card-feeds").getByRole("switch");
  await expect(feeds).toHaveAttribute("aria-checked", "true");
  await feeds.click();
  await expect(feeds).toHaveAttribute("aria-checked", "false");

  await page.goto("/home");
  await expect(page.getByRole("button", { name: "Diaper", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Feed", exact: true })).toHaveCount(0);
  await expect(page.getByText(/Last feed/)).toHaveCount(0);

  await page.goto("/timeline");
  await expect(page.getByRole("button", { name: "Diapers", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Feeds", exact: true })).toHaveCount(0);
  // The old feed still shows under All.
  await expect(
    page.getByText(/1 feed/).or(page.getByText(/bottle|breast/i)).first(),
  ).toBeVisible();

  await page.goto("/stats");
  await expect(page.getByText(/Sleep \/ day/)).toBeVisible();
  await expect(page.getByText(/Intake \/ day/)).toHaveCount(0);

  await page.goto("/profile");
  await page.getByRole("button", { name: "Add reminder", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("button", { name: "Diaper", exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Feed", exact: true })).toHaveCount(0);
});

test("the kiosk hides a card whose switch is off", async ({ page, request }) => {
  await freshFamily(page, request, "tracking-kiosk");
  const [baby] = (await (await page.request.get("/api/babies")).json()) as { id: string }[];
  const res = await page.request.put(`/api/babies/${baby.id}/features`, {
    data: { features: ALL_FEATURES.filter((f) => f !== "diapers") },
  });
  expect(res.ok()).toBeTruthy();
  await enrolKiosk(page);
  await expect(page.getByTestId("kiosk-feed")).toBeVisible();
  await expect(page.getByTestId("kiosk-sleep")).toBeVisible();
  await expect(page.getByTestId("kiosk-diaper")).toHaveCount(0);
});
