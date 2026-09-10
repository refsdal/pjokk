import { expect, test } from "./fixtures";
import {
  chooseCaretaker,
  enrolKiosk,
  freshFamily,
  holdToLeave,
  KIOSK_PIN,
} from "./helpers";

// Kiosk mode on an enrolled family device (docs/superpowers/specs/
// 2026-09-08-kiosk-mode-design.md and 2026-09-10-kiosk-devices-design.md).
// Runs on the mobile and tablet projects. Each test founds a family, then
// turns its own browser into that family's kiosk with a one-time code —
// which signs the founder out of it, as a real set-up does — and says who
// is logging before it logs.

test("a kiosk device lands on the care station and logs a diaper with undo", async ({ page, request }) => {
  await freshFamily(page, request, "kiosk-diaper");
  await enrolKiosk(page);
  await expect(page.getByTestId("kiosk-clock")).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await chooseCaretaker(page);

  const diaper = page.getByTestId("kiosk-diaper");
  await diaper.getByRole("button", { name: "Wet" }).click();
  await expect(page.getByText("Wet diaper logged")).toBeVisible();
  await expect(diaper.getByText("under a minute")).toBeVisible({ timeout: 10_000 });
  await expect(diaper.getByText(/^1 wet/)).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Wet diaper logged")).toBeHidden();
  await expect(diaper.getByText(/^0 wet/)).toBeVisible({ timeout: 10_000 });
});

test("an action with nobody chosen asks who is logging", async ({ page, request }) => {
  await freshFamily(page, request, "kiosk-who");
  await enrolKiosk(page);
  await expect(page.getByTestId("kiosk-caretakers").getByText("Who's logging?")).toBeVisible();

  await page.getByTestId("kiosk-diaper").getByRole("button", { name: "Wet" }).click();
  const prompt = page.getByRole("dialog", { name: "Who's logging?" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button").first().click();
  await expect(page.getByText("Wet diaper logged")).toBeVisible();
  await expect(
    page.getByTestId("kiosk-caretakers").getByRole("button", { pressed: true }),
  ).toHaveCount(1);
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
  await freshFamily(page, request, "kiosk-sleep");
  await enrolKiosk(page);
  await chooseCaretaker(page);
  const card = page.getByTestId("kiosk-sleep");
  await card.getByRole("button", { name: "Sleep" }).click();
  await expect(card).toHaveAttribute("data-tone", "live", { timeout: 10_000 });
  await card.getByRole("button", { name: "Wake" }).click();
  await expect(card).toHaveAttribute("data-tone", "normal", { timeout: 10_000 });
  await expect(card.getByText(/^1 nap/)).toBeVisible();
});

test("resume from the card after a mistaken wake", async ({ page, request }) => {
  await freshFamily(page, request, "kiosk-resume");
  await enrolKiosk(page);
  await chooseCaretaker(page);
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
  await freshFamily(page, request, "kiosk-breast");
  await enrolKiosk(page);
  await chooseCaretaker(page);
  const card = page.getByTestId("kiosk-feed");
  await card.getByRole("button", { name: "Breast L" }).click();
  await expect(card).toHaveAttribute("data-tone", "live", { timeout: 10_000 });
  await card.getByRole("button", { name: "Stop" }).click();
  await expect(card).toHaveAttribute("data-tone", "normal", { timeout: 10_000 });
  await expect(card.getByText("under a minute")).toBeVisible();
});

test("/home redirects to /kiosk on a device; the PIN un-enrols it", async ({ page, request }) => {
  await freshFamily(page, request, "kiosk-leave");
  await enrolKiosk(page);
  await page.goto("/home");
  await expect(page).toHaveURL(/\/kiosk/);

  const pad = await holdToLeave(page);
  for (const d of "1111") await pad.getByRole("button", { name: d, exact: true }).click();
  await expect(pad.getByText("Wrong PIN")).toBeVisible();
  for (const d of KIOSK_PIN) await pad.getByRole("button", { name: d, exact: true }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

  // Un-enrolled, and nobody's session is left behind: the app is signed out.
  await page.goto("/home");
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
});

test("night keeps the cards on the amber palette without totals", async ({ page, request, context }) => {
  await context.addInitScript(() => {
    try {
      localStorage.setItem("pjokk.night.mode", "on");
    } catch {
      // storage unavailable
    }
  });
  await freshFamily(page, request, "kiosk-night");
  await enrolKiosk(page);
  await expect(page.locator("html")).toHaveClass(/kiosk/);
  await expect(page.locator("html")).toHaveClass(/night/);
  await expect(page.getByTestId("kiosk-sleep")).toBeVisible();
  await expect(page.getByText(/feeds · .* ml$/)).toHaveCount(0);
});
