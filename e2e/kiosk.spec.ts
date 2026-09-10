import { createHash } from "node:crypto";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// Kiosk mode (docs/superpowers/specs/2026-09-08-kiosk-mode-design.md).
// Runs on the mobile and tablet projects. The flag and the PIN hash are
// seeded the way lib/kiosk.ts stores them, so the app boots straight into
// the care station.
const PIN = "2580";
const HASH = createHash("sha256").update(`pjokk-kiosk:${PIN}`).digest("hex");

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ({ hash, len }) => {
      try {
        localStorage.setItem("pjokk.kiosk.on", "1");
        localStorage.setItem("pjokk.kiosk.pin", hash);
        localStorage.setItem("pjokk.kiosk.pinlen", String(len));
      } catch {
        // storage unavailable
      }
    },
    { hash: HASH, len: PIN.length },
  );
});

test("a kiosk device lands on the care station and logs a diaper with undo", async ({ page, request }) => {
  await freshFamily(page, request, "kiosk-diaper", /\/kiosk/);
  await expect(page).toHaveURL(/\/kiosk/);
  await expect(page.getByTestId("kiosk-clock")).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);

  const diaper = page.getByTestId("kiosk-diaper");
  await diaper.getByRole("button", { name: "Wet" }).click();
  await expect(page.getByText("Wet diaper logged")).toBeVisible();
  await expect(diaper.getByText("under a minute")).toBeVisible({ timeout: 10_000 });
  await expect(diaper.getByText(/^1 wet/)).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Wet diaper logged")).toBeHidden();
  await expect(diaper.getByText(/^0 wet/)).toBeVisible({ timeout: 10_000 });
});

test("sleep and wake from the card", async ({ page, request }) => {
  // The card types a sleep from the night-mode schedule (#43), and only a
  // nap is counted below: a schedule with no night keeps it one at any hour.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pjokk.night.schedule", JSON.stringify({ startHour: 0, endHour: 0 }));
    } catch {
      // storage unavailable
    }
  });
  await freshFamily(page, request, "kiosk-sleep", /\/kiosk/);
  const card = page.getByTestId("kiosk-sleep");
  await card.getByRole("button", { name: "Sleep" }).click();
  await expect(card).toHaveAttribute("data-tone", "live", { timeout: 10_000 });
  await card.getByRole("button", { name: "Wake" }).click();
  await expect(card).toHaveAttribute("data-tone", "normal", { timeout: 10_000 });
  await expect(card.getByText(/^1 nap/)).toBeVisible();
});

test("resume from the card after a mistaken wake", async ({ page, request }) => {
  await freshFamily(page, request, "kiosk-resume", /\/kiosk/);
  const card = page.getByTestId("kiosk-sleep");
  await card.getByRole("button", { name: "Sleep" }).click();
  await expect(card).toHaveAttribute("data-tone", "live", { timeout: 10_000 });
  await card.getByRole("button", { name: "Wake" }).click();
  await expect(card).toHaveAttribute("data-tone", "normal", { timeout: 10_000 });
  await card.getByRole("button", { name: "Resume" }).click();
  await expect(card).toHaveAttribute("data-tone", "live", { timeout: 10_000 });
  await expect(card.getByRole("button", { name: "Wake" })).toBeVisible();
});

test("nursing timer from the card", async ({ page, request }) => {
  await freshFamily(page, request, "kiosk-breast", /\/kiosk/);
  const card = page.getByTestId("kiosk-feed");
  await card.getByRole("button", { name: "Breast L" }).click();
  await expect(card).toHaveAttribute("data-tone", "live", { timeout: 10_000 });
  await card.getByRole("button", { name: "Stop" }).click();
  await expect(card).toHaveAttribute("data-tone", "normal", { timeout: 10_000 });
  await expect(card.getByText("under a minute")).toBeVisible();
});

test("/home redirects to /kiosk while the flag is on; the PIN leaves", async ({ page, request }) => {
  await freshFamily(page, request, "kiosk-leave", /\/kiosk/);
  await page.goto("/home");
  await expect(page).toHaveURL(/\/kiosk/);

  const name = page.getByRole("button", { name: "Hold to leave kiosk mode" });
  const box = (await name.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1700);
  await page.mouse.up();
  const pad = page.getByRole("dialog", { name: "Leave kiosk mode" });
  await expect(pad).toBeVisible();
  for (const d of "1111") await pad.getByRole("button", { name: d, exact: true }).click();
  await expect(pad.getByText("Wrong PIN")).toBeVisible();
  for (const d of PIN) await pad.getByRole("button", { name: d, exact: true }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 10_000 });
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

test("night keeps the cards on the amber palette without totals", async ({ page, request, context }) => {
  await context.addInitScript(() => {
    try {
      localStorage.setItem("pjokk.night.mode", "on");
    } catch {
      // storage unavailable
    }
  });
  await freshFamily(page, request, "kiosk-night", /\/kiosk/);
  await expect(page.locator("html")).toHaveClass(/kiosk/);
  await expect(page.locator("html")).toHaveClass(/night/);
  await expect(page.getByTestId("kiosk-sleep")).toBeVisible();
  await expect(page.getByText(/feeds · .* ml$/)).toHaveCount(0);
});

test("Settings turns kiosk on with a PIN", async ({ page, request, context }) => {
  await context.addInitScript(() => {
    try {
      localStorage.removeItem("pjokk.kiosk.on");
      localStorage.removeItem("pjokk.kiosk.pin");
      localStorage.removeItem("pjokk.kiosk.pinlen");
    } catch {
      // storage unavailable
    }
  });
  await freshFamily(page, request, "kiosk-settings");
  await page.goto("/settings");
  await page.getByRole("button", { name: "Turn on kiosk mode" }).click();
  await page.getByLabel("PIN", { exact: true }).fill("1234");
  await page.getByLabel("Repeat PIN").fill("1234");
  await page.getByRole("button", { name: "Start kiosk" }).click();
  await expect(page).toHaveURL(/\/kiosk/);
});
