import { asDevice, expect, seedDayMode, test } from "./fixtures";
import { apiSignIn, freshFamily } from "./helpers";

// The language choice is the person's (DECISIONS 2026-09-11): picked on
// one device, it is saved to the server and the next device they sign in
// on follows it. The server also keeps what the choice resolves to, which
// push notifications are written in (internal/api and internal/jobs tests
// cover the pushes themselves; a real push cannot be raised here).

async function me(page: import("@playwright/test").Page) {
  return (await page.request.get("/api/me")).json();
}

test("a language picked on one device follows the person to another", async ({
  page,
  request,
  browser,
}, testInfo) => {
  const { email } = await freshFamily(page, request, "language");

  // The first app to meet the person uploads its own choice: "auto", which
  // resolves to English in the test browser.
  await expect
    .poll(async () => {
      const m = await me(page);
      return `${m.languageMode}/${m.language}`;
    })
    .toBe("auto/en");

  await page.goto("/settings");
  await page.getByRole("button", { name: "Norsk", exact: true }).click();
  await expect(page.getByText("Språk", { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const m = await me(page);
      return `${m.languageMode}/${m.language}`;
    })
    .toBe("nb/nb");

  // A second device that has never been told anything: it signs in and
  // the app is Norwegian.
  const ctx = await browser.newContext(asDevice(testInfo, 1));
  await seedDayMode(ctx);
  const phone = await ctx.newPage();
  await apiSignIn(phone, email);
  await phone.goto("/home");
  await expect(
    phone.getByRole("button", { name: "Måltid", exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  // Back to Auto there: stored for the person, and resolved on the device.
  await phone.goto("/settings");
  await phone.getByRole("button", { name: "Auto", exact: true }).first().click();
  await expect
    .poll(async () => {
      const m = await me(phone);
      return `${m.languageMode}/${m.language}`;
    })
    .toBe("auto/en");
  await ctx.close();
});
