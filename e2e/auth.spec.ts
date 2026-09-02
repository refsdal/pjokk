import { expect, test } from "@playwright/test";
import { apiSignIn, apiSignup, freshEmail, uiSignIn } from "./helpers";

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
