import type { Browser, TestInfo } from "@playwright/test";
import { asDevice, expect, seedDayMode, test } from "./fixtures";
import { apiSignIn, apiSignup, freshEmail, makeSysadmin } from "./helpers";

// First end-to-end coverage of the operator console. /admin had none at all
// before this spec, which is a poor place for a gap: it is the only surface
// in the app where one mistake destroys another family's data.
//
// The walk is the support story the console exists for — create a family for
// someone who has no account yet, then staff it — plus the two guards that
// are easy to regress: the role gate, and the refusal to strand a family
// without an admin.

/** A signed-in system admin on /admin. */
async function operator(page: import("@playwright/test").Page, request: import("@playwright/test").APIRequestContext) {
  const email = freshEmail("operator");
  await apiSignup(request, email);
  await makeSysadmin(email);
  await apiSignIn(page, email);
  return email;
}

test("a non-admin cannot reach the console", async ({ page, request }) => {
  const email = freshEmail("ordinary");
  await apiSignup(request, email);
  await apiSignIn(page, email);

  await page.goto("/admin/families");
  // The client-side gate sends them away; the server refuses every route
  // behind it regardless (internal/api tier tests).
  await expect(page).not.toHaveURL(/\/admin/, { timeout: 10_000 });
});

test("creates a family with an invite link and staffs it", async ({
  page,
  request,
}) => {
  await operator(page, request);

  // Someone who will be added later. Created first so the add-member step
  // has a real account to find — that route never creates one.
  const caretaker = freshEmail("caretaker");
  await apiSignup(request, caretaker);

  await page.goto("/admin/families");
  await expect(page.getByPlaceholder("Search families")).toBeVisible();

  // --- Create, with no admin email: an empty family plus an admin code.
  await page.getByRole("button", { name: "New" }).click();
  const family = `E2E family ${Date.now()}`;
  await page.getByPlaceholder("Family name").fill(family);
  await page.getByRole("button", { name: "Create with invite link" }).click();

  await expect(page.getByText("Nobody runs this family yet")).toBeVisible();
  await expect(page.getByRole("img", { name: "Invite QR code" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  // --- It shows in the list, badged: nobody can administer it yet.
  await page.getByPlaceholder("Search families").fill(family);
  const row = page.getByRole("link", { name: new RegExp(family) });
  await expect(row).toBeVisible();
  await expect(row.getByText("no admin")).toBeVisible();

  // --- Detail page.
  await row.click();
  await expect(page).toHaveURL(/\/admin\/families\/[^/]+$/);
  await expect(page.getByRole("heading", { name: family })).toBeVisible();
  await expect(page.getByText("Nobody is in this family")).toBeVisible();

  // --- Add the caretaker as an admin, which repairs the stranded family.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByPlaceholder("Their email").fill(caretaker);
  await page.getByRole("button", { name: "Admin", exact: true }).click();
  await page.getByRole("button", { name: "Add to family" }).click();

  // By row, not by text: an account created through the HTTP signup path
  // has no display name, so the row shows the address on both its lines.
  const memberRow = page.getByRole("button").filter({ hasText: caretaker });
  await expect(memberRow).toBeVisible();

  // --- The last-admin guard now applies to them, and says so.
  await memberRow.click();
  await expect(
    page.getByText("This is the family's last admin"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Make member" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Remove from family" }),
  ).toBeDisabled();
});

test("renames a family and mints an invite for it", async ({
  page,
  request,
}) => {
  await operator(page, request);

  const owner = freshEmail("owner");
  await apiSignup(request, owner);

  await page.goto("/admin/families");
  await page.getByRole("button", { name: "New" }).click();
  const family = `Rename me ${Date.now()}`;
  await page.getByPlaceholder("Family name").fill(family);
  await page.getByPlaceholder("Admin's email (optional)").fill(owner);
  await page.getByRole("button", { name: "Create family" }).click();
  await expect(page.getByText("Family admin:")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  await page.getByPlaceholder("Search families").fill(family);
  await page.getByRole("link", { name: new RegExp(family) }).click();

  // --- Rename, and keep the slug: it is an identifier something may hold.
  const slug = await page.locator("p.font-mono").first().textContent();
  await page.getByRole("button", { name: "Rename family" }).click();
  const renamed = `${family} renamed`;
  await page.getByRole("textbox").first().fill(renamed);
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("heading", { name: renamed })).toBeVisible();
  await expect(page.locator("p.font-mono").first()).toHaveText(slug ?? "");

  // --- Mint a member code for the family the operator is not in.
  await page.getByRole("button", { name: "Mint" }).click();
  await page.getByRole("button", { name: "Mint member code" }).click();
  await expect(page.getByRole("img", { name: "Invite QR code" })).toBeVisible();
});

// --- The user page (docs/superpowers/specs/2026-09-11-admin-user-support-design.md)

/** Another browser, its own client, signed in as `email`. */
async function signedInElsewhere(browser: Browser, testInfo: TestInfo, device: number, email: string) {
  const context = await browser.newContext(asDevice(testInfo, device));
  await seedDayMode(context);
  const page = await context.newPage();
  await apiSignIn(page, email);
  return { context, page };
}

test("finds a person, signs out one of their sessions and changes their email", async ({
  page,
  request,
  browser,
}, testInfo) => {
  await operator(page, request);
  // Signed in twice: signup signs them in (the `request` client holds that
  // session), and then on a phone of their own.
  const person = freshEmail("person");
  await apiSignup(request, person);
  const phone = await signedInElsewhere(browser, testInfo, 1, person);

  await page.goto("/admin/users");
  await page.getByPlaceholder("Search users").fill(person);
  await page.getByRole("link", { name: new RegExp(person) }).click();
  await expect(page).toHaveURL(/\/admin\/users\/[^/]+$/);

  const sessions = page.getByTestId("admin-session");
  await expect(sessions).toHaveCount(2);
  await sessions.first().getByRole("button", { name: "Sign out" }).click();
  await sessions.first().getByRole("button", { name: "Tap again to confirm" }).click();
  await expect(page.getByTestId("admin-session")).toHaveCount(1);

  // Exactly one of the two is signed out; the other carries on.
  const statuses = await Promise.all(
    [request, phone.page.request].map(async (r) => (await r.get("/api/me")).status()),
  );
  expect(statuses.sort()).toEqual([200, 401]);

  // A new login address: shown on the page, and in its history.
  const renamed = freshEmail("renamed");
  await page.getByRole("button", { name: "Change email" }).click();
  await page.getByLabel("New email").fill(renamed);
  await page.getByRole("dialog").getByRole("button", { name: "Change email" }).click();
  await expect(page.getByText(renamed).first()).toBeVisible();
  await expect(page.getByText("user.email.change")).toBeVisible();

  await phone.context.close();
});

test("an operator whose role is revoked loses the console at once", async ({
  page,
  request,
  browser,
}, testInfo) => {
  await operator(page, request);
  const second = freshEmail("operator");
  await apiSignup(request, second);
  await makeSysadmin(second);
  const other = await signedInElsewhere(browser, testInfo, 1, second);
  await other.page.goto("/admin/users");
  await expect(other.page.getByPlaceholder("Search users")).toBeVisible();

  await page.goto("/admin/users");
  await page.getByPlaceholder("Search users").fill(second);
  await page.getByRole("link", { name: new RegExp(second) }).click();
  await page.getByRole("button", { name: "Revoke system admin" }).click();
  await page.getByRole("button", { name: "Tap again to confirm" }).click();
  await expect(page.getByText("System admin revoked")).toBeVisible();

  // No sign-out needed: the role is re-read on every request.
  await other.page.goto("/admin/users");
  await expect(other.page).not.toHaveURL(/\/admin/, { timeout: 10_000 });
  await other.context.close();
});

