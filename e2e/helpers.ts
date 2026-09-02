import { expect, type APIRequestContext, type Page } from "@playwright/test";

// One password for every synthetic account; must satisfy Limen's policy
// (min 8, an uppercase letter, a digit).
export const PASSWORD = "E2e-password-1";

let counter = 0;

/** A unique email per call so specs never collide on accounts. */
export function freshEmail(tag: string): string {
  counter += 1;
  return `${tag}-${Date.now()}-${counter}@e2e.test`;
}

/**
 * POSTs with a bounded retry on 429. Limen rate-limits signup/signin
 * (~5/10s per IP) — legitimate in production, but a suite creating many
 * accounts in a few seconds trips it. Real users never do; the fixture
 * backs off rather than the app being weakened.
 */
async function postWithBackoff(
  request: APIRequestContext,
  url: string,
  data: unknown,
): Promise<import("@playwright/test").APIResponse> {
  let res = await request.post(url, { data });
  for (let attempt = 0; res.status() === 429 && attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await request.post(url, { data });
  }
  return res;
}

/**
 * Creates an account through the API. The SPA has no signup UI (accounts
 * come from Google sign-in or the invite flow — issue #27), so like any
 * fixture this goes straight to the endpoint — which only exists because
 * the e2e stack runs with OPEN_SIGNUP=1. Sign-UP takes "email"; sign-IN
 * takes "credential" — Limen's asymmetry, easy to trip over. The account
 * gets a null display name (the HTTP signup path has no name field);
 * every screen must cope with that anyway.
 */
export async function apiSignup(
  request: APIRequestContext,
  email: string,
): Promise<void> {
  const res = await postWithBackoff(request, "/api/auth/signup/credential", {
    email,
    password: PASSWORD,
  });
  expect(res.ok(), `signup for ${email}: ${res.status()}`).toBeTruthy();
}

/**
 * Signs in via the API: the response's session cookie lands in the page's
 * browser context (page.request shares the cookie jar). Fixtures use this —
 * the login SCREEN is exercised by auth.spec.ts alone, which also keeps the
 * suite's pressure on the auth-signin rate limiter (20/10min per IP) low.
 * Recreating the e2e stack resets the limiter (its counters live in
 * Postgres).
 */
export async function apiSignIn(page: Page, email: string): Promise<void> {
  const res = await postWithBackoff(page.request, "/api/auth/signin/credential", {
    credential: email,
    password: PASSWORD,
  });
  expect(res.ok(), `api sign-in for ${email}: ${res.status()}`).toBeTruthy();
}

/** Signs in through the real login screen and waits until the app routes on. */
export async function uiSignIn(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in with email" }).click();
  // A fresh account lands on Welcome; an account with a family lands on Home.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
}

/** Welcome flow: create the family, then the first baby, then land on Home. */
export async function uiCreateFamily(
  page: Page,
  family: string,
  baby: string,
): Promise<void> {
  await expect(page.getByText("Set up your family")).toBeVisible();
  await page.getByPlaceholder(/Family name/).fill(family);
  await page.getByRole("button", { name: "Create family" }).click();

  await expect(page.getByText("Who are we tracking?")).toBeVisible();
  await page.getByPlaceholder("Baby's name").fill(baby);
  await page.getByLabel("Birth date").fill("2026-06-15");
  await page.getByRole("button", { name: "Add baby" }).click();

  await expect(page).toHaveURL(/\/home/, { timeout: 10_000 });
}

/** Full fixture: fresh account signed in with a family and a baby, on Home. */
export async function freshFamily(
  page: Page,
  request: APIRequestContext,
  tag: string,
): Promise<{ email: string }> {
  const email = freshEmail(tag);
  await apiSignup(request, email);
  await apiSignIn(page, email);
  await page.goto("/");
  await uiCreateFamily(page, `The ${tag} family`, `Baby ${tag}`);
  return { email };
}
