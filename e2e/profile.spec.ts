import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// A 1×1 red PNG — enough for the on-device crop/resize to produce a JPEG
// the server accepts.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

test("a nickname replaces the full name on timeline rows", async ({ page, request }) => {
  await freshFamily(page, request, "profile");

  await page.goto("/profile");
  await page.getByLabel("Full name").fill("Anders Olsen");
  await page.getByLabel("Nickname").fill("Pappa");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Profile saved")).toBeVisible();

  await page.goto("/home");
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/1 feeds/)).toBeVisible({ timeout: 10_000 });

  await page.goto("/timeline");
  await expect(page.getByText("by Pappa").first()).toBeVisible();
});

test("uploading a photo puts it on the Home chip", async ({ page, request }) => {
  await freshFamily(page, request, "photo");

  await page.goto("/profile");
  await page.getByLabel("Change photo").setInputFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: PNG_1x1,
  });
  await expect(page.getByText("Photo updated")).toBeVisible({ timeout: 10_000 });

  await page.goto("/home");
  const chip = page.getByRole("button", { name: "Account", exact: true });
  await expect(chip.locator("img")).toBeVisible();

  await page.goto("/profile");
  await page.getByRole("button", { name: "Remove photo" }).click();
  await expect(page.getByText("Photo removed")).toBeVisible();
  await page.goto("/home");
  await expect(page.getByRole("button", { name: "Account", exact: true }).locator("img")).toHaveCount(0);
});

test("the account sheet lists the family and signs out", async ({ page, request }) => {
  await freshFamily(page, request, "account");

  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByText("The account family")).toBeVisible();
  await expect(page.getByText("Your profile")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
});

test.describe("avatar fallback", () => {
  // The avatar <img> is fetched through the app's own service worker
  // (Workbox runtime caching, per CLAUDE.md's PWA section) — a request made
  // there runs in the SW's own execution context, which `page.route()` does
  // not see at all (confirmed: a route on `**/api/users/**`, even matching
  // as broadly as possible, saw zero hits while `page.on("response")` still
  // reported the request succeeding). So the abort below would silently do
  // nothing with the service worker active. Blocking it for this test is
  // the deliberate substitute for the brief's "if the service worker
  // defeats route.abort()" contingency — `setOffline(true)` is ruled out
  // (it would take the whole app offline), but the SW is not otherwise part
  // of what this test is proving, and turning it off restores plain
  // page-level fetches that `page.route()` can actually intercept.
  test.use({ serviceWorkers: "block" });

  test("an avatar that fails to load falls back to the initial", async ({ page, request }) => {
    await freshFamily(page, request, "fallback");

    // Abort every avatar fetch from BEFORE the upload even happens, not
    // just before the later /home visit. Uploading the photo makes the
    // Profile screen's own Avatar (it renders the photo too, size 20)
    // re-render with the new avatarUrl immediately and fetch it right there
    // on /profile — if that first fetch were allowed to succeed, the plain
    // HTTP cache (same URL, same `v=` cache-busting hash both times) would
    // serve /home's later request for the identical URL without ever
    // touching the network, and this route would never see it. Aborting
    // from the start means the URL never succeeds even once, so there is
    // nothing to cache.
    await page.route("**/api/users/*/avatar*", (route) => route.abort());

    await page.goto("/profile");
    await page.getByLabel("Change photo").setInputFiles({
      name: "me.png",
      mimeType: "image/png",
      buffer: PNG_1x1,
    });
    await expect(page.getByText("Photo updated")).toBeVisible({ timeout: 10_000 });

    await page.goto("/home");
    const chip = page.getByRole("button", { name: "Account", exact: true });
    // Assert the fallback text FIRST, not the absent <img>: right after
    // navigation the <img> is present (avatarUrl is known) and briefly has
    // no text while its request is in flight, which would make a naive
    // `toHaveCount(0)` on the <img> pass instantly on that empty state
    // rather than on the onError fallback this test exists to prove.
    // Waiting for the fallback text lets the assertion retry through the
    // loading state and through the aborted request's onError firing; the
    // two are mutually exclusive in Avatar's render (an <img> or the
    // initial, never neither), so once the text is there, the <img> is
    // provably gone too.
    //
    // The fresh account has no display name (freshFamily signs up through
    // the API, which sets none), so the fallback initial is "?" — assert
    // generically that it renders a single non-whitespace character,
    // matching the Avatar component's initialOf() contract, rather than
    // hardcoding "?" in case the fixture ever grows a display name.
    await expect(chip).toHaveText(/^\S$/, { timeout: 10_000 });
    await expect(chip.locator("img")).toHaveCount(0);
  });
});
