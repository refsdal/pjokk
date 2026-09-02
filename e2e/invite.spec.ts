import { expect, test } from "@playwright/test";
import { apiSignIn, apiSignup, freshEmail, freshFamily } from "./helpers";

// The closed-alpha join path for a user who already has an account: admin
// mints an invite in Settings, the other user opens /join/<code> and joins.
// (A BRAND-NEW invitee cannot join while OPEN_SIGNUP=0 — known product gap,
// tracked separately — so this spec models the supported path.)

test("a second caretaker joins via an invite link", async ({ browser, page, request }) => {
  await freshFamily(page, request, "inviter");

  await page.goto("/settings");
  await page.getByRole("button", { name: "New invite link" }).click();
  const link = await page.getByText(/\/join\//).first().textContent();
  expect(link, "invite link rendered").toBeTruthy();
  const code = link!.trim().split("/join/")[1]?.trim();
  expect(code, `code from ${link}`).toBeTruthy();

  const inviteeEmail = freshEmail("invitee");
  await apiSignup(request, inviteeEmail);

  const ctx = await browser.newContext();
  const invitee = await ctx.newPage();
  await apiSignIn(invitee, inviteeEmail);
  await invitee.goto(`/join/${code}`);
  await invitee.getByRole("button", { name: "Join family" }).click();

  await expect(invitee).toHaveURL(/\/home/, { timeout: 10_000 });
  await expect(invitee.getByText("Baby inviter").first()).toBeVisible();
  await ctx.close();
});
