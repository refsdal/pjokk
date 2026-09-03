import { expect, seedDayMode, test } from "./fixtures";
import { PASSWORD, apiSignIn, apiSignup, freshEmail, freshFamily, uiSignIn } from "./helpers";

// The seam no other suite sees: the limen-auth client driving the real
// login screen against the real backend.

test("signs in through the login screen and lands on Welcome", async ({ page, request }) => {
  const email = freshEmail("auth");
  await apiSignup(request, email);

  await uiSignIn(page, email);
  await expect(page.getByText("Set up your family")).toBeVisible();
});

test("rejects a wrong password on the login screen", async ({ page, request }) => {
  const email = freshEmail("auth-bad");
  await apiSignup(request, email);

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("Wrong-password-1");
  await page.getByRole("button", { name: "Sign in with email" }).click();

  await expect(page.getByText("Sign-in failed").or(page.getByText(/invalid/i)).first()).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("signs out from Welcome", async ({ page, request }) => {
  const email = freshEmail("auth-out");
  await apiSignup(request, email);
  await apiSignIn(page, email);
  await page.goto("/"); // lands on Welcome (no family yet)
  await expect(page.getByText("Set up your family")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

  // The session really died: a protected screen bounces back to login. The
  // SPA's client-side redirect aborts the navigation itself (ERR_ABORTED) —
  // that abort IS the evidence, so swallow it and assert where we landed.
  await page.goto("/home").catch(() => {});
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
});

test("a returning user with a family signs in and lands on Home with their data", async ({ page, request, browser }) => {
  // Set up an established account: family, baby, and a logged feed.
  const { email } = await freshFamily(page, request, "returning");
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/1 feeds/)).toBeVisible({ timeout: 10_000 });

  // A brand-new context is a genuine returning session on a fresh device:
  // no cookies, no persisted query cache, no service worker. Signing in
  // through the login SCREEN must land on Home — not Welcome, the family
  // already exists — with the baby and the earlier feed present. This is
  // the complement to the new-user tests above, and the case the
  // identity-caching regressions would have broken.
  const ctx = await browser.newContext();
  await seedDayMode(ctx);
  const returning = await ctx.newPage();
  await returning.goto("/login");
  await returning.getByPlaceholder("Email").fill(email);
  await returning.getByPlaceholder("Password").fill(PASSWORD);
  await returning.getByRole("button", { name: "Sign in with email" }).click();

  await expect(returning).toHaveURL(/\/home/, { timeout: 10_000 });
  await expect(returning.getByText("Baby returning").first()).toBeVisible();
  await expect(returning.getByText(/1 feeds/)).toBeVisible();
  await ctx.close();
});

// The e2e stack runs OPEN_SIGNUP=1, so the login screen's credential
// "Create account" toggle is present (issue #27) — the founder-bootstrap
// path, distinct from the OAuth-account-creation path invite.spec.ts covers.
test("the login screen creates an account when signup is open", async ({ page }) => {
  const email = freshEmail("uisignup");
  await page.goto("/login");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /Create account/ }).click();
  await expect(page).toHaveURL(/\/(welcome|home)/, { timeout: 10_000 });
});
