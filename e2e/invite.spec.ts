import { expect, seedDayMode, test } from "./fixtures";
import { apiSignIn, apiSignup, freshEmail, freshFamily } from "./helpers";

// The closed-alpha join path: admin mints an invite in Settings, the other
// user opens /join/<code> and joins. Two invitee shapes below: one who
// already has an account, and a brand-new one whose account was just
// created via OAuth (issue #26 — OAuth account creation stays open even
// under closed signup; see DECISIONS.md 2026-09-02). Both land the same
// way: the join screen auto-redeems ANY signed-in visitor with a valid
// invite on mount (Join.tsx's `didAuto` effect) — there is no reliable
// window to click "Join family" for either shape, since `busy` flips true,
// and the button's label with it, before a UI click could land.

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
  await seedDayMode(ctx);
  const invitee = await ctx.newPage();
  await apiSignIn(invitee, inviteeEmail);
  await invitee.goto(`/join/${code}`);
  // No button click: the join screen auto-redeems a signed-in visitor.
  await expect(invitee).toHaveURL(/\/home/, { timeout: 10_000 });
  await expect(invitee.getByText("Baby inviter").first()).toBeVisible();
  await ctx.close();
});

test("a brand-new invitee auto-redeems on opening the join link", async ({ page, request, browser }) => {
  await freshFamily(page, request, "autojoin");
  await page.goto("/settings");
  await page.getByRole("button", { name: "New invite link" }).click();
  const link = await page.getByText(/\/join\//).first().textContent();
  const code = link!.trim().split("/join/")[1]?.trim();

  const inviteeEmail = freshEmail("autoinvitee");
  await apiSignup(request, inviteeEmail);
  const ctx = await browser.newContext();
  await seedDayMode(ctx);
  const invitee = await ctx.newPage();
  await apiSignIn(invitee, inviteeEmail);
  await invitee.goto(`/join/${code}`);
  // No button click: the join screen auto-redeems a signed-in visitor.
  await expect(invitee).toHaveURL(/\/home/, { timeout: 10_000 });
  await expect(invitee.getByText("Baby autojoin").first()).toBeVisible();
  await ctx.close();
});
