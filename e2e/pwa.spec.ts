import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// The PWA affordances of issue #51, against the real artifact: the manifest
// declares the three shortcuts, and their deep links (also what a push
// action opens) land straight in the named sheet, with the param dropped
// from the URL afterwards. The badge and the notification buttons are not
// observable here (no install, no push service); lib/badge.ts is unit
// tested and push-sw.js maps the payload the server's tests assert.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/pwa-shots";
const shot = (name: string) => join(SHOT_DIR, name);

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
}

test("the manifest lists Feed / Diaper / Sleep shortcuts", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  const manifest = await res.json();
  expect(manifest.shortcuts.map((s: { url: string }) => s.url)).toEqual([
    "/home?log=feed",
    "/home?log=diaper",
    "/home?log=sleep",
  ]);
  for (const s of manifest.shortcuts) {
    expect(s.icons[0].src).toMatch(/icon-192\.png$/);
  }
});

test("?log= opens the named sheet and then leaves the URL clean", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "pwa");
  const sheet = page.getByRole("dialog");

  await page.goto("/home?log=feed");
  await expect(sheet.getByRole("button", { name: "Bottle", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page).toHaveURL(/\/home$/);
  await settle(page);
  await page.screenshot({ path: shot("1-shortcut-feed.png") });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await page.goto("/home?log=diaper");
  await expect(sheet.getByRole("button", { name: "Wet", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await settle(page);
  await page.screenshot({ path: shot("2-shortcut-diaper.png") });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // The push action for a medicine reminder uses the same door.
  await page.goto("/home?log=medicine");
  await expect(sheet.getByPlaceholder("Medicine name")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page).toHaveURL(/\/home$/);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // A reload after the sheet was opened does not reopen it.
  await page.reload();
  await expect(page.getByRole("button", { name: "Feed", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(sheet).toBeHidden();
});
