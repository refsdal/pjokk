import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// The responsive shell (docs/superpowers/specs/2026-09-08-responsive-shell-
// design.md). Runs on all three projects (playwright.config.ts); each test
// says which tier it is about. The tier is decided by the viewport, never
// the device, so the checks read the viewport rather than the project name.

const rail = (page: Page) => page.getByRole("navigation", { name: "Main" });

test("navigation is a bottom bar on the phone and a left rail from 768 px", async ({ page, request }) => {
  await freshFamily(page, request, "layout-nav");
  const box = await rail(page).boundingBox();
  const vp = page.viewportSize()!;
  expect(box).not.toBeNull();
  if (vp.width < 768) {
    // Bottom bar: full width, at the bottom edge.
    expect(box!.width).toBeGreaterThan(vp.width - 2);
    expect(box!.y + box!.height).toBeGreaterThan(vp.height - 2);
  } else {
    // Rail: 88 px wide, full height, at the left edge.
    expect(box!.x).toBe(0);
    expect(Math.round(box!.width)).toBe(88);
    expect(box!.height).toBeGreaterThan(vp.height - 2);
  }
});

test("Feed opens as a 420 px right panel from 768 px, with Save in view", async ({ page, request }) => {
  test.skip(page.viewportSize()!.width < 768, "regular and wide tiers only");
  await freshFamily(page, request, "layout-panel");
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Feed" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-direction", "right");
  const vp = page.viewportSize()!;
  // vaul slides the panel in over 0.5 s; poll until it has settled on the
  // right edge rather than measure it mid-animation.
  await expect
    .poll(async () => {
      const box = (await dialog.boundingBox())!;
      return [Math.round(box.width), Math.round(box.x + box.width)];
    })
    .toEqual([420, vp.width]);
  await expect(page.getByRole("button", { name: "Save" })).toBeInViewport();
  // The status cards stay readable beside the panel.
  await expect(page.getByText("Last feed")).toBeVisible();
});

test("the More actions unfold on Home from 768 px and stay a sheet on the phone", async ({ page, request }) => {
  await freshFamily(page, request, "layout-more");
  const unfolded = page.getByTestId("home-actions-unfolded");
  const more = page.getByRole("button", { name: "More", exact: true });
  if (page.viewportSize()!.width < 768) {
    await expect(more).toBeVisible();
    await expect(unfolded).toBeHidden();
  } else {
    await expect(more).toBeHidden();
    await expect(unfolded).toBeVisible();
    await expect(unfolded.getByRole("button")).toHaveCount(11);
    await unfolded.getByRole("button", { name: "Medicine" }).click();
    await expect(page.getByRole("dialog", { name: "Medicine" })).toBeVisible();
  }
});

test("wide: Home shows Recent and a row opens its edit sheet", async ({ page, request }) => {
  test.skip(page.viewportSize()!.width < 1280, "wide tier only");
  await freshFamily(page, request, "layout-recent");
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await page.getByRole("button", { name: "Save" }).click();
  const recent = page.getByTestId("home-recent");
  await expect(recent).toBeVisible();
  const row = recent.getByRole("button", { name: /Bottle/ }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(page.getByRole("dialog", { name: "Edit feed" })).toBeVisible();
});

test("a sheet survives a resize across 768 px and reopens in the new direction", async ({ page, request }) => {
  test.skip(page.viewportSize()!.width < 1280, "starts at the wide tier");
  await freshFamily(page, request, "layout-resize");
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Feed" });
  await expect(dialog).toHaveAttribute("data-direction", "right");
  const amount = dialog.getByRole("textbox", { name: "ml" });
  const before = Number(await amount.inputValue());
  const stepped = before + (before < 50 ? 5 : 10);
  await dialog.getByRole("button", { name: "increase ml" }).click();
  await expect(amount).toHaveValue(String(stepped));

  await page.setViewportSize({ width: 600, height: 900 });
  // Still open, still a right panel (latched), value intact.
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-direction", "right");
  await expect(amount).toHaveValue(String(stepped));

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Feed" })).toHaveAttribute("data-direction", "bottom");
});

test("F opens Feed, not while typing; Escape closes", async ({ page, request }) => {
  await freshFamily(page, request, "layout-keys");
  // Home is interactive once its buttons are — the key listener is attached
  // in the same commit, and the wide tier has the most to mount first.
  await expect(page.getByRole("button", { name: "Feed", exact: true })).toBeVisible();
  await page.keyboard.press("f");
  const dialog = page.getByRole("dialog", { name: "Feed" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.keyboard.press("d");
  const diaper = page.getByRole("dialog", { name: "Diaper" });
  await expect(diaper).toBeVisible();
  // Typing into the note must not open another sheet.
  await diaper.getByPlaceholder("Note (optional)").fill("f");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(diaper).toBeHidden();
});

test("night mode keeps three actions in the bottom half, right-aligned from 768 px", async ({ page, request, context }) => {
  // fixtures.ts seeds night "off"; a later init script wins.
  await context.addInitScript(() => {
    try {
      localStorage.setItem("pjokk.night.mode", "on");
    } catch {
      // storage unavailable
    }
  });
  await freshFamily(page, request, "layout-night");
  const vp = page.viewportSize()!;
  for (const name of ["Sleep", "Feed", "Diaper"]) {
    const box = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(box.y).toBeGreaterThan(vp.height / 2);
    if (vp.width >= 768) {
      expect(box.x + box.width).toBeGreaterThan(vp.width - 60);
      expect(box.width).toBeLessThanOrEqual(448);
    }
  }
});
