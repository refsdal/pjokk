import { join } from "node:path";
import { asDevice, expect, seedDayMode, test } from "./fixtures";
import { apiSignIn, apiSignup, freshEmail, freshFamily } from "./helpers";

// Screenshots of the chips and the "Logged by" line, for a human to look
// at. Off in the repo by default (test-results/ is gitignored); point
// E2E_SHOT_DIR somewhere else when the shots are the deliverable.
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/who-did-it-shots";
const shot = (name: string) => join(SHOT_DIR, name);

// Who did the care, not only who logged it (spec 2026-09-14-who-did-it):
// a two-parent family, a diaper logged by one for the other. The timeline
// names the one who did it; the edit sheet still knows who typed.

test("a diaper logged for a partner shows the partner on the timeline", async ({
  browser,
  page,
  request,
}, testInfo) => {
  await freshFamily(page, request, "whodidit");
  const named = await page.request.patch("/api/me", {
    data: { name: "Anne Admin" },
  });
  expect(named.ok(), `name the admin: ${named.status()}`).toBeTruthy();

  // The partner joins via an invite, exactly as invite.spec.ts does, and
  // gets a name so the chips and the timeline have a word to show.
  await page.goto("/settings/family");
  await page.getByRole("button", { name: "New invite link" }).click();
  const link = await page.getByText(/\/join\//).first().textContent();
  const code = link!.trim().split("/join/")[1]?.trim();
  expect(code, `code from ${link}`).toBeTruthy();

  const partnerEmail = freshEmail("partner");
  await apiSignup(request, partnerEmail);
  const ctx = await browser.newContext(asDevice(testInfo, 1));
  await seedDayMode(ctx);
  const partner = await ctx.newPage();
  await apiSignIn(partner, partnerEmail);
  const renamed = await partner.request.patch("/api/me", {
    data: { name: "Bo Partner" },
  });
  expect(renamed.ok(), `name the partner: ${renamed.status()}`).toBeTruthy();
  await partner.goto(`/join/${code}`);
  await expect(partner).toHaveURL(/\/home/, { timeout: 10_000 });
  await ctx.close();

  // A reload is how the admin's app learns about the new member (the
  // members query is cached); the chips only render for two or more.
  await page.goto("/home");
  await page.getByRole("button", { name: "Diaper", exact: true }).click();
  const sheet = page.getByRole("dialog");
  const chips = sheet.getByTestId("caretaker-chips");
  await expect(chips.getByRole("button")).toHaveCount(2);
  const me = chips.getByRole("button", { name: /Anne/ });
  const bo = chips.getByRole("button", { name: /Bo/ });
  await expect(me).toHaveAttribute("aria-pressed", "true");
  await bo.click();
  await expect(bo).toHaveAttribute("aria-pressed", "true");
  await sheet.screenshot({ path: shot("create.png") });
  await sheet.getByRole("button", { name: "Save" }).click();

  await page.goto("/timeline");
  const row = page.getByRole("button").filter({ hasText: "by Bo Partner" });
  await expect(row.first()).toBeVisible({ timeout: 10_000 });

  // The edit sheet opens on the partner and says who actually logged it.
  await row.first().click();
  const edit = page.getByRole("dialog");
  await expect(
    edit.getByTestId("caretaker-chips").getByRole("button", { name: /Bo/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(edit.getByTestId("logged-by")).toHaveText("Logged by Anne Admin");
  await edit.screenshot({ path: shot("edit.png") });
});
