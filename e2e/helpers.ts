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
 * (5/10s per IP, a fixed window keyed by path — see
 * credential-password/handlers.go's RateLimitRules) — legitimate in
 * production, but a suite creating many accounts in a few seconds trips it.
 * Real users never do; the fixture backs off rather than the app being
 * weakened. The window only clears 10s after the *last accepted* request to
 * that path (a 429 response does not touch it), so once capped, nothing
 * shorter than a full 10s wait gets back in — 8 attempts at 1.5s gives ~12s
 * of headroom past that floor rather than landing right on it. Since every
 * test is its own client (fixtures.ts), that window is per test now, and
 * the 20-per-10-minutes limiter above it is no longer a suite-wide budget.
 */
async function postWithBackoff(
  request: APIRequestContext,
  url: string,
  data: unknown,
): Promise<import("@playwright/test").APIResponse> {
  let res = await request.post(url, { data });
  for (let attempt = 0; res.status() === 429 && attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await request.post(url, { data });
  }
  return res;
}

/**
 * Creates an account through the API. Most fixtures don't want to drive the
 * real signup UI (auth.spec.ts does that once, deliberately) so, like any
 * fixture, this goes straight to the endpoint — which only exists because
 * the e2e stack runs with OPEN_SIGNUP=1; it also stands in for a brand-new
 * OAuth account in fixtures that model an invitee (real OAuth can't run in
 * CI, and OAuth account creation is open regardless of OPEN_SIGNUP — see
 * DECISIONS.md 2026-09-02). Sign-UP takes "email"; sign-IN takes
 * "credential" — Limen's asymmetry, easy to trip over. The account gets a
 * null display name (the HTTP signup path has no name field); every screen
 * must cope with that anyway.
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
 * suite's pressure on the auth-signin rate limiters (see postWithBackoff
 * above) low. Each test has its own client address (fixtures.ts), so one
 * test's sign-ins never count against another's.
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
  // Where the app lands once the baby exists. /home, unless the device is a
  // kiosk (e2e/kiosk.spec.ts), which redirects on to /kiosk at once.
  landing: RegExp = /\/home/,
): Promise<void> {
  await expect(page.getByText("Set up your family")).toBeVisible();
  await page.getByPlaceholder(/Family name/).fill(family);
  await page.getByRole("button", { name: "Create family" }).click();

  await expect(page.getByText("Who are we tracking?")).toBeVisible();
  await page.getByPlaceholder("Baby's name").fill(baby);
  await page.getByLabel("Birth date").fill("2026-06-15");
  await page.getByRole("button", { name: "Add baby" }).click();

  await expect(page).toHaveURL(landing, { timeout: 10_000 });
}

/** Full fixture: fresh account signed in with a family and a baby, on Home
 *  (or wherever `landing` says a kiosk device ends up). */
export async function freshFamily(
  page: Page,
  request: APIRequestContext,
  tag: string,
  landing: RegExp = /\/home/,
): Promise<{ email: string }> {
  const email = freshEmail(tag);
  await apiSignup(request, email);
  await apiSignIn(page, email);
  await page.goto("/");
  await uiCreateFamily(page, `The ${tag} family`, `Baby ${tag}`, landing);
  return { email };
}

/**
 * Promotes an account to the SYSTEM admin role — the one that opens /admin,
 * which has nothing to do with the per-family admin role.
 *
 * It writes the column directly, through the stack's Postgres container,
 * exactly as the Go suite's makeSysadmin does and for the same reason:
 * there is deliberately no endpoint for this. The first operator is
 * bootstrapped by whoever runs the deployment, and an HTTP route that
 * minted system admins would be a far worse thing to own than a test helper
 * that shells out.
 *
 * The container name is the one scripts/e2e-stack.sh creates; override it
 * with E2E_PG_CONTAINER when running against a stack started some other
 * way. A failure here is loud on purpose — a silently skipped admin spec is
 * worth less than no admin spec, because it looks like coverage.
 */
export async function makeSysadmin(email: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const container = process.env.E2E_PG_CONTAINER ?? "pjokk-e2e-pg";
  await run("docker", [
    "exec",
    container,
    "psql",
    "-U",
    "pjokk",
    "-d",
    "pjokk",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `UPDATE "users" SET "role" = 'admin' WHERE "email" = '${email}'`,
  ]);
}
