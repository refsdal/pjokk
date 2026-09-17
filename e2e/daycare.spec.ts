import { join } from "node:path";
import type { Page } from "@playwright/test";
import { asDevice, expect, seedDayMode, test } from "./fixtures";
import { apiSignIn, apiSignup, freshEmail, freshFamily } from "./helpers";

// A day at barnehage (issue #105, spec 2026-09-17-daycare-session): dropped
// off from More, a calm banner on Home while she is there, picked up with
// one tap, and a span row on the timeline that opens the same sheet.

// Screenshots for a human to look at. Off in the repo by default
// (test-results/ is gitignored); point E2E_SHOT_DIR elsewhere to keep them.
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/daycare-shots";
const shot = (name: string) => join(SHOT_DIR, name);

async function firstBabyId(page: Page): Promise<string> {
  const babies = await (await page.request.get("/api/babies")).json();
  return babies[0].id as string;
}

test("drop off, see the banner, pick up, find the day on the timeline", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "daycare");
  const babyId = await firstBabyId(page);
  // A bottle before the drop-off, so the Last feed card has something that
  // goes stale while she is away.
  const fed = await page.request.post("/api/feeds", {
    data: {
      babyId,
      time: new Date(Date.now() - 60 * 60_000).toISOString(),
      type: "bottle",
      amountMl: 120,
    },
  });
  expect(fed.ok(), `seed feed: ${fed.status()}`).toBeTruthy();
  await page.goto("/home");

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Daycare", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Dropped off")).toBeVisible();
  // The pick-up fields stay folded until a finished day is asked for.
  await expect(sheet.getByText("Picked up")).toHaveCount(0);
  await sheet.screenshot({ path: shot("drop-off.png") });
  await sheet.getByRole("button", { name: "Drop off", exact: true }).click();

  const banner = page.getByText("At daycare", { exact: true });
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("At daycare since then")).toBeVisible();
  await page.screenshot({ path: shot("home-at-daycare.png") });

  // The server agrees, which is what holds the reminders.
  await expect
    .poll(async () => {
      const s = await (
        await page.request.get(`/api/summary?babyId=${babyId}`)
      ).json();
      return s.activeDaycare?.endTime ?? "none";
    })
    .toBeNull();

  await page.getByRole("button", { name: "Pick up", exact: true }).click();
  await expect(banner).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText("At daycare since then")).toHaveCount(0);

  await page.goto("/timeline");
  const row = page.getByRole("button").filter({ hasText: /^Daycare/ });
  await expect(row.first()).toBeVisible({ timeout: 10_000 });
  await row.first().click();
  const edit = page.getByRole("dialog");
  await expect(edit.getByText("Edit daycare day")).toBeVisible();
  await expect(edit.getByText("Picked up")).toBeVisible();

  // It lives under Other, with play and the rest.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Other", exact: true }).click();
  await expect(row.first()).toBeVisible();
  await page.getByRole("button", { name: "Feeds", exact: true }).click();
  await expect(row).toHaveCount(0);
});

test("a finished day names who dropped off and who picked up", async ({
  browser,
  page,
  request,
}, testInfo) => {
  await freshFamily(page, request, "daycare2");
  await page.request.patch("/api/me", { data: { name: "Anne Admin" } });

  // The partner joins via an invite, as who-did-it.spec.ts does.
  await page.goto("/settings");
  await page.getByRole("button", { name: "New invite link" }).click();
  const link = await page.getByText(/\/join\//).first().textContent();
  const code = link!.trim().split("/join/")[1]?.trim();
  expect(code, `code from ${link}`).toBeTruthy();
  const partnerEmail = freshEmail("daycare-partner");
  await apiSignup(request, partnerEmail);
  const ctx = await browser.newContext(asDevice(testInfo, 1));
  await seedDayMode(ctx);
  const partner = await ctx.newPage();
  await apiSignIn(partner, partnerEmail);
  await partner.request.patch("/api/me", { data: { name: "Bo Partner" } });
  await partner.goto(`/join/${code}`);
  await expect(partner).toHaveURL(/\/home/, { timeout: 10_000 });
  await ctx.close();

  await page.goto("/home");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Daycare", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Log a finished day" }).click();
  const pickup = sheet.getByTestId("pickup-chips");
  await expect(pickup.getByRole("button", { name: /Anne/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await pickup.getByRole("button", { name: /Bo/ }).click();
  await sheet.screenshot({ path: shot("finished-day.png") });
  await sheet.getByRole("button", { name: "Save", exact: true }).click();

  // No banner: the day is over.
  await expect(page.getByText("At daycare", { exact: true })).toHaveCount(0);

  await page.goto("/timeline");
  const row = page
    .getByRole("button")
    .filter({ hasText: "picked up by Bo Partner" });
  await expect(row.first()).toBeVisible({ timeout: 10_000 });
  await expect(row.first()).toContainText("by Anne Admin");
  await page.screenshot({ path: shot("timeline.png") });

  // The edit sheet opens on both people, and the pick-up can change hands.
  await row.first().click();
  const edit = page.getByRole("dialog");
  await expect(
    edit.getByTestId("pickup-chips").getByRole("button", { name: /Bo/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await edit
    .getByTestId("pickup-chips")
    .getByRole("button", { name: /Anne/ })
    .click();
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button").filter({ hasText: "picked up by Anne Admin" }),
  ).toBeVisible({ timeout: 10_000 });
});
