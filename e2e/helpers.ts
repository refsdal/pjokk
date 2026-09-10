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
  try {
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
  } catch (cause) {
    // The one thing about this helper that a green local run cannot check:
    // the container is named by whoever started the stack, and CI does not
    // use scripts/e2e-stack.sh. Say so rather than surfacing docker's
    // "No such container", which reads like a broken test.
    throw new Error(
      `makeSysadmin could not reach Postgres in container "${container}". ` +
        "Set E2E_PG_CONTAINER to the name the running stack uses " +
        "(scripts/e2e-stack.sh: pjokk-e2e-pg; .github/workflows/ci.yml: pg).",
      { cause },
    );
  }
}

// --- Kiosk devices (docs/superpowers/specs/2026-09-10-kiosk-devices-design.md)

export const KIOSK_PIN = "2580";

/**
 * The tablet's half of enrolment: /kiosk/setup with a one-time code and a
 * PIN, landing on the care station. A browser that is signed in is signed
 * out by the set-up, exactly as a real one is.
 */
export async function redeemKioskCode(
  page: Page,
  code: string,
  pin = KIOSK_PIN,
): Promise<void> {
  await page.goto(`/kiosk/setup?code=${code}`);
  await page.getByLabel("PIN", { exact: true }).fill(pin);
  await page.getByLabel("Repeat PIN").fill(pin);
  await page.getByRole("button", { name: "Start kiosk" }).click();
  await expect(page).toHaveURL(/\/kiosk$/, { timeout: 10_000 });
}

/**
 * Turns the page's own browser into a kiosk device of the family it is
 * signed in to: mints a one-time code as that family's admin (page.request
 * shares the page's cookies), then redeems it here.
 */
export async function enrolKiosk(page: Page, pin = KIOSK_PIN): Promise<void> {
  const res = await page.request.post("/api/devices", {
    data: { name: "Kitchen tablet" },
  });
  expect(res.ok(), `create device: ${res.status()}`).toBeTruthy();
  const { code } = (await res.json()) as { code: string };
  await redeemKioskCode(page, code, pin);
}

/** Says who is logging on the kiosk's caretaker row (the first face by default). */
export async function chooseCaretaker(page: Page, name?: string): Promise<void> {
  const row = page.getByTestId("kiosk-caretakers");
  const face = name
    ? row.getByRole("button", { name })
    : row.getByRole("button").first();
  await face.click();
  await expect(face).toHaveAttribute("aria-pressed", "true");
}

/** Press-and-hold the baby's name until the leave pad opens; returns the pad. */
export async function holdToLeave(page: Page) {
  // A page behind another has its timers throttled, and the hold is a
  // 1.5 s timer: bring the tablet forward first (devices.spec.ts drives two).
  await page.bringToFront();
  const name = page.getByRole("button", { name: "Hold to leave kiosk mode" });
  // A tap on a lower card scrolls a phone-sized kiosk; the band scrolls with
  // it, and a raw mouse press at an off-screen box lands on nothing.
  await name.scrollIntoViewIfNeeded();
  const box = await name.boundingBox();
  if (!box) throw new Error("the baby's name is not on screen");
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  // Hold until the pad is up rather than for a fixed time: the hold is a
  // 1.5 s timer, and a throttled timer can fire after a fixed release.
  await page.mouse.down();
  const pad = page.getByRole("dialog", { name: "Leave kiosk mode" });
  await expect(pad).toBeVisible({ timeout: 5000 });
  await page.mouse.up();
  return pad;
}
