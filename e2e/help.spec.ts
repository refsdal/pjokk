import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { asDevice, expect, seedDayMode, test } from "./fixtures";
import { apiSignIn, apiSignup, freshEmail, freshFamily } from "./helpers";

// The whole "Ask for help" round trip between two caretakers, against the
// real artifact: More → Ask for help → Send → the card appears on BOTH
// Homes in the open styling → the target answers → both cards go calm →
// the sender clears it. This is the flow the design spec
// (docs/superpowers/specs/2026-09-06-help-request-design.md) describes, and
// the only place it is exercised end to end — internal/api/help_test.go
// covers the endpoints, lib/help-ui.test.ts the view decisions, but neither
// can see that a red border actually renders for the other person.
//
// E2E accounts have no display name (the API signup path has no name
// field), so every name the server projects is COALESCE'd to "" and the UI
// falls back: chips show the email, headlines read "Someone …". That is the
// worst case for the copy and worth asserting as-is.
//
// Push is not configured in the e2e stack (no VAPID keys, no browser
// subscription), so `delivered` is 0 and Send reports "… hasn't turned on
// notifications". The card must appear regardless: it is family state, not
// a notification.

// Screenshots of the open/acknowledged card, for a human to look at. Off in
// the repo by default (test-results/ is gitignored); point E2E_SHOT_DIR
// somewhere else when the shots are the deliverable.
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/help-shots";
const shot = (name: string) => join(SHOT_DIR, name);

/**
 * The help card element: the `<p>` carrying the state label, two levels up
 * (p → text column → card). Anchoring on the label rather than a class is
 * what lets the assertions below check the classes honestly.
 */
function helpCard(page: Page, label: "Help requested" | "On the way"): Locator {
  return page.getByText(label, { exact: true }).locator("xpath=../..");
}

// A reload stands in for "the other phone looks again": the restored
// IndexedDB snapshot is revalidated straight away (lib/query.ts
// afterRestore), so the other caretaker's request shows without waiting
// out staleTime. Until someone looks, web push covers the gap in
// production; the e2e stack has no VAPID keys.
async function refetchHome(page: Page): Promise<void> {
  await page.reload();
}

test("a caretaker asks another for help and gets an answer", async ({
  browser,
  page,
  request,
}, testInfo) => {
  // ---- 1. Sender: a fresh family, on Home ------------------------------
  await freshFamily(page, request, "helper");

  // ---- 2. Target: a second caretaker joins via an invite ---------------
  // Same shape as invite.spec.ts: admin mints the code, the invitee opens
  // /join/<code> in their own context and is auto-redeemed on mount.
  await page.goto("/settings");
  await page.getByRole("button", { name: "New invite link" }).click();
  const link = await page.getByText(/\/join\//).first().textContent();
  const code = link!.trim().split("/join/")[1]?.trim();
  expect(code, `code from ${link}`).toBeTruthy();

  const targetEmail = freshEmail("helpee");
  await apiSignup(request, targetEmail);
  const ctx = await browser.newContext(asDevice(testInfo, 1));
  await seedDayMode(ctx);
  const target = await ctx.newPage();
  await apiSignIn(target, targetEmail);
  await target.goto(`/join/${code}`);
  await expect(target).toHaveURL(/\/home/, { timeout: 10_000 });

  // The sender's tab has been open since before the join, and the members
  // query is cached (staleTime 15 s). A reload is how a real sender's app
  // learns about the new member; it is not what the flow under test is.
  await page.goto("/home");

  // ---- 3. Sender: More → Ask for help → Send ---------------------------
  await page.getByRole("button", { name: "More", exact: true }).click();
  const more = page.getByRole("dialog");
  await expect(more).toBeVisible();
  await more.getByRole("button", { name: "Ask for help", exact: true }).click();

  const sheet = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("button", { name: "Send", exact: true }) });
  await expect(sheet).toBeVisible();

  // Exactly one other member, prefilled — the single-other-member default
  // (pickDefaultMember) is what makes this a two-tap flow.
  const who = sheet.locator('p:text-is("Who?") + div');
  await expect(who.getByRole("button")).toHaveCount(1);
  const chip = who.getByRole("button", { name: targetEmail });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(chip).toContainText("No notifications");

  await sheet.screenshot({ path: shot("sheet.png") });

  // A preset fills the message without the keyboard.
  await sheet
    .getByRole("button", { name: "Bring a bottle", exact: true })
    .click();
  await expect(sheet.getByPlaceholder("Message (optional)")).toHaveValue(
    "Bring a bottle",
  );

  await sheet.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByText(`${targetEmail} hasn't turned on notifications`),
  ).toBeVisible();
  await expect(sheet).toBeHidden();

  // ---- 4. Sender's Home: the open card ---------------------------------
  const senderOpen = helpCard(page, "Help requested");
  await expect(senderOpen).toBeVisible();
  // Sender is neither the target nor nameless-free: "… from someone".
  await expect(senderOpen).toContainText("Someone needs a hand from someone");
  await expect(senderOpen).toContainText("Bring a bottle");
  await expect(
    senderOpen.getByRole("button", { name: "Never mind", exact: true }),
  ).toBeVisible();
  await expect(senderOpen).toHaveClass(/border-danger/);
  await expect(senderOpen).toHaveClass(/animate-help-ping/);
  await expect(senderOpen.locator("svg")).toHaveAttribute(
    "class",
    /animate-help-wave/,
  );

  // ---- 5. Target: sees it, answers it ----------------------------------
  await refetchHome(target);
  const targetOpen = helpCard(target, "Help requested");
  await expect(targetOpen).toBeVisible();
  await expect(targetOpen).toContainText("Someone needs a hand");
  // The target is asked directly — no "from <someone>" tail.
  await expect(targetOpen).not.toContainText("needs a hand from");
  await expect(targetOpen).toContainText("Bring a bottle");
  await expect(targetOpen).toHaveClass(/border-danger/);
  await expect(targetOpen).toHaveClass(/animate-help-ping/);
  await target.screenshot({ path: shot("card-open.png") });

  await targetOpen
    .getByRole("button", { name: "On my way", exact: true })
    .click();

  const targetAck = helpCard(target, "On the way");
  await expect(targetAck).toBeVisible();
  await expect(targetAck).toContainText("Someone is on the way");
  // Neither sender nor admin: nothing left for this viewer to do.
  await expect(targetAck.getByRole("button")).toHaveCount(0);
  await expect(targetAck).toHaveClass(/border-line/);
  await expect(targetAck).not.toHaveClass(/animate-help-ping/);
  await expect(targetAck.locator("svg")).not.toHaveAttribute(
    "class",
    /animate-help-wave/,
  );
  // The card cross-fades red → calm over 300 ms (transition-colors); a shot
  // taken straight after the assertions above catches it mid-fade (a muddy
  // brown hand, a rose border) and misrepresents the settled state.
  await target.waitForTimeout(500);
  await target.screenshot({ path: shot("card-acknowledged.png") });

  // ---- 6. Sender: the card goes calm, then Done clears it ---------------
  await refetchHome(page);
  const senderAck = helpCard(page, "On the way");
  await expect(senderAck).toBeVisible();
  await expect(senderAck).toContainText("Someone is on the way");
  await expect(senderAck).not.toHaveClass(/animate-help-ping/);
  await senderAck.getByRole("button", { name: "Done", exact: true }).click();

  await expect(page.getByText("On the way", { exact: true })).toBeHidden();
  await expect(page.getByText("Help requested", { exact: true })).toBeHidden();

  await ctx.close();
});
