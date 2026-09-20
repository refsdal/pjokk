import type { APIRequestContext, Browser, Page, TestInfo } from "@playwright/test";
import { asDevice, expect, seedDayMode, test } from "./fixtures";
import {
  apiSignIn,
  apiSignup,
  freshEmail,
  freshFamily,
  skipGettingStarted,
} from "./helpers";

// What's new, and a first run (spec
// docs/superpowers/specs/2026-09-20-whats-new-and-first-run-design.md).
// The invariant under test: a caretaker who has already onboarded is never
// interrupted, dismissal is one tap, and dismissing loses nothing.

// A fresh account is already at whats_new_seq = 0 and seq starts at 1, so
// every entry is unseen and the line shows with no setup. (An earlier draft
// had a `rewind` helper here; it asserted that precondition rather than
// establishing anything, so it was dropped by controller ruling.)

// Seeding the "has unseen entries" state: a FOUNDER is caught up at family
// creation (Welcome sets whatsNewSeq, so a brand-new founder is never told
// about versions they never missed), and the server's GREATEST guard means
// a marker can never be rewound. GettingStarted's own finish() — reached by
// BOTH its Skip button and its Done button — catches up whatsNewSeq for any
// genuine first run too (spec §8: "a new account is never shown release
// notes for versions it never missed"), which is symmetrical with Welcome
// and correct: someone who has never been away has nothing to have missed.
// So tapping the UI's Skip button does NOT leave an invitee at seq = 0 —
// verified against apps/frontend/src/screens/GettingStarted.tsx's finish(),
// which sends { onboarded: true, whatsNewSeq: highestSeq(...) } whenever
// isFirstRun is true, Skip included.
//
// The account that legitimately sits at whats_new_seq = 0 WITH a family is
// therefore reached the same way every other fixture reaches "already
// onboarded": the API-only skipGettingStarted (onboarded, and nothing
// else) — just applied to the invitee instead of the founder. This still
// proves the redirect (the invitee genuinely lands on /getting-started
// first) without going through the button whose whole job is to catch the
// marker up, which is exactly the behaviour test 4 below exercises instead.
async function invitedCaretaker(
  page: Page,
  request: APIRequestContext,
  browser: Browser,
  testInfo: TestInfo,
  tag: string,
): Promise<Page> {
  await freshFamily(page, request, tag);
  await page.goto("/settings/family");
  await page.getByRole("button", { name: "New invite link" }).click();
  const link = await page.getByText(/\/join\//).first().textContent();
  const code = link!.trim().split("/join/")[1]?.trim();

  const ctx = await browser.newContext(asDevice(testInfo, 1));
  await seedDayMode(ctx);
  const invitee = await ctx.newPage();
  const email = freshEmail(`${tag}-invitee`);
  await apiSignup(request, email);
  await apiSignIn(invitee, email);
  await invitee.goto(`/join/${code}`);
  // The invitee genuinely lands on the first-run tour...
  await expect(invitee).toHaveURL(/\/getting-started/, { timeout: 10_000 });
  // ...but reach "onboarded" the API way, which leaves whatsNewSeq at 0,
  // rather than tapping Skip, which would catch it up (see comment above).
  await skipGettingStarted(invitee);
  await invitee.goto("/home");
  await expect(invitee).toHaveURL(/\/home/, { timeout: 10_000 });
  return invitee;
}

test("the line appears on Home, opens the list, and one tap dismisses it", async ({
  page,
  request,
  browser,
}, testInfo) => {
  const invitee = await invitedCaretaker(page, request, browser, testInfo, "whats-new");

  const line = invitee.getByTestId("whats-new-line");
  await expect(line).toBeVisible();

  // The log grid must not have moved: the row lives below it.
  await expect(
    invitee.getByRole("button", { name: "Feed", exact: true }),
  ).toBeVisible();

  await invitee.getByTestId("whats-new-dismiss").click();
  await expect(line).toBeHidden();
  // Dismissing must not navigate anywhere.
  await expect(invitee).toHaveURL(/\/home/);

  // And it must stay gone across a reload — the marker is on the server,
  // not this device.
  await invitee.reload();
  await expect(invitee.getByTestId("whats-new-line")).toBeHidden();
});

test("dismissing loses nothing: the list still has every entry", async ({
  page,
  request,
  browser,
}, testInfo) => {
  const invitee = await invitedCaretaker(page, request, browser, testInfo, "whats-new-list");
  await invitee.getByTestId("whats-new-dismiss").click();
  await expect(invitee.getByTestId("whats-new-line")).toBeHidden();

  await invitee.goto("/whats-new");
  await expect(invitee.getByTestId("whats-new-list")).toBeVisible();
  await expect(invitee.getByTestId("whats-new-entry-1")).toBeVisible();
});

test("the line is absent in night mode", async ({
  page,
  request,
  browser,
}, testInfo) => {
  const invitee = await invitedCaretaker(page, request, browser, testInfo, "whats-new-night");
  await expect(invitee.getByTestId("whats-new-line")).toBeVisible();

  // NightHome is a separate subtree: three actions and nothing else.
  await invitee.context().addInitScript(() => {
    localStorage.setItem("pjokk.night.mode", "on");
  });
  await invitee.reload();
  await expect(invitee.getByTestId("whats-new-line")).toBeHidden();
  await expect(
    invitee.getByRole("button", { name: "Feed", exact: true }),
  ).toBeVisible();
});

// The finish-the-tour race (the redirect loop) was only ever proven through
// Skip. Done runs the same finish() and is what most people will tap, so it
// gets its own pass — including the assertion that lands them on Home and
// STAYS there rather than bouncing back into the tour.
test("finishing the tour with Done lands on Home and stays there", async ({
  page,
  request,
  browser,
}, testInfo) => {
  await freshFamily(page, request, "first-run-done");
  await page.goto("/settings/family");
  await page.getByRole("button", { name: "New invite link" }).click();
  const link = await page.getByText(/\/join\//).first().textContent();
  const code = link!.trim().split("/join/")[1]?.trim();

  const ctx = await browser.newContext(asDevice(testInfo, 1));
  await seedDayMode(ctx);
  const invitee = await ctx.newPage();
  const email = freshEmail("first-run-done-invitee");
  await apiSignup(request, email);
  await apiSignIn(invitee, email);
  await invitee.goto(`/join/${code}`);

  await expect(invitee).toHaveURL(/\/getting-started/, { timeout: 10_000 });
  // Page through to the last card, then Done.
  for (let i = 0; i < 3; i++) {
    await invitee.getByTestId("getting-started-next").click();
  }
  await invitee.getByTestId("getting-started-done").click();
  await expect(invitee).toHaveURL(/\/home/, { timeout: 10_000 });
  // The bounce this guards against is a redirect landing a beat later, so
  // assert Home is still Home after the mount refetch has had time to run.
  await expect(
    invitee.getByRole("button", { name: "Feed", exact: true }),
  ).toBeVisible();
  await invitee.waitForTimeout(1500);
  await expect(invitee).toHaveURL(/\/home/);
});
