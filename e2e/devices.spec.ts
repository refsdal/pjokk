import type { Browser, TestInfo } from "@playwright/test";
import { asDevice, expect, seedDayMode, test } from "./fixtures";
import { freshFamily, holdToLeave, KIOSK_PIN, redeemKioskCode } from "./helpers";

// Kiosk devices from both sides (docs/superpowers/specs/
// 2026-09-10-kiosk-devices-design.md): a family admin adds a device in
// Settings, a second browser — the tablet, its own client — enrols with the
// code, and whatever it logs is credited to whoever it says is logging.

async function newTablet(browser: Browser, testInfo: TestInfo) {
  const context = await browser.newContext(asDevice(testInfo, 1));
  await seedDayMode(context);
  return { context, page: await context.newPage() };
}

test("an admin adds a device; the tablet enrols and logs as a caretaker", async ({ page, request, browser }, testInfo) => {
  await freshFamily(page, request, "devices-enrol");
  const named = await page.request.patch("/api/me", { data: { name: "Anne Admin" } });
  expect(named.ok(), `name the admin: ${named.status()}`).toBeTruthy();

  await page.goto("/settings");
  await page.getByRole("button", { name: "Add device" }).click();
  await page.getByRole("button", { name: "Create device" }).click();
  const codeText = page.getByTestId("device-code");
  await expect(codeText).toHaveText(/^[A-Z2-9]{8}$/);
  const code = ((await codeText.textContent()) ?? "").trim();

  const tablet = await newTablet(browser, testInfo);
  const kiosk = tablet.page;
  await kiosk.goto("/login");
  await kiosk.getByRole("link", { name: "Set up as kiosk" }).click();
  await kiosk.getByLabel("Code").fill(code);
  await kiosk.getByLabel("PIN", { exact: true }).fill(KIOSK_PIN);
  await kiosk.getByLabel("Repeat PIN").fill(KIOSK_PIN);
  await kiosk.getByRole("button", { name: "Start kiosk" }).click();
  await expect(kiosk).toHaveURL(/\/kiosk$/, { timeout: 10_000 });

  await kiosk.getByTestId("kiosk-diaper").getByRole("button", { name: "Wet" }).click();
  await kiosk
    .getByRole("dialog", { name: "Who's logging?" })
    .getByRole("button", { name: "Anne" })
    .click();
  await expect(kiosk.getByText("Wet diaper logged")).toBeVisible();

  // The admin's own timeline credits the tablet's entry to its caretaker.
  await page.goto("/timeline");
  await expect(page.getByText(/by Anne Admin/).first()).toBeVisible({ timeout: 10_000 });
  await page.goto("/settings");
  await expect(page.getByText(/Set up .* · Last used/)).toBeVisible();

  // Leaving with the PIN un-enrols the tablet.
  const pad = await holdToLeave(kiosk);
  for (const d of KIOSK_PIN) await pad.getByRole("button", { name: d, exact: true }).click();
  await expect(kiosk).toHaveURL(/\/login/, { timeout: 10_000 });
  await tablet.context.close();
});

test("revoking a device in Settings drops the tablet to sign-in", async ({ page, request, browser }, testInfo) => {
  await freshFamily(page, request, "devices-revoke");
  const res = await page.request.post("/api/devices", { data: { name: "Nursery tablet" } });
  expect(res.ok(), `create device: ${res.status()}`).toBeTruthy();
  const { code } = (await res.json()) as { code: string };

  const tablet = await newTablet(browser, testInfo);
  await redeemKioskCode(tablet.page, code);
  await expect(tablet.page.getByTestId("kiosk-clock")).toBeVisible();

  await page.goto("/settings");
  await page.getByRole("button", { name: /Nursery tablet/ }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Revoke" }).click();
  await sheet.getByRole("button", { name: "Tap again to confirm" }).click();
  await expect(page.getByText("Device revoked")).toBeVisible();

  // The tablet finds out on its next request.
  await tablet.page.reload();
  await expect(tablet.page).toHaveURL(/\/login/, { timeout: 10_000 });
  await expect(tablet.page.getByText("This tablet is no longer a kiosk")).toBeVisible();
  await tablet.context.close();
});
