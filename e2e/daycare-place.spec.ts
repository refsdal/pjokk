import { join } from "node:path";
import type { Page } from "@playwright/test";
import { asDevice, expect, seedDayMode, test } from "./fixtures";
import {
  apiSignIn,
  apiSignup,
  freshEmail,
  freshFamily,
  skipGettingStarted,
} from "./helpers";

// The barnehage as a place, and who collects her (spec 2026-09-17-daycare-
// place-and-pickup-plan): a parent sets the place and the week up in
// Settings; while she is there the banner says the plan, and the day sheet
// says how to reach the place and lets anyone say who collects today.
//
// The place closes at 23:59 so the banner's "closes soon" turn cannot
// happen during a run (it could between 23:44 and midnight, local).

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/daycare-place-shots";
const shot = (name: string) => join(SHOT_DIR, name);

async function firstBabyId(page: Page): Promise<string> {
  const babies = await (await page.request.get("/api/babies")).json();
  return babies[0].id as string;
}

test("set up the place and the week, then see the plan while she is there", async ({
  browser,
  page,
  request,
}, testInfo) => {
  await freshFamily(page, request, "place");
  await page.request.patch("/api/me", { data: { name: "Anne Admin" } });

  // The partner joins via an invite, as who-did-it.spec.ts does.
  await page.goto("/settings/family");
  await page.getByRole("button", { name: "New invite link" }).click();
  const link = await page.getByText(/\/join\//).first().textContent();
  const code = link!.trim().split("/join/")[1]?.trim();
  expect(code, `code from ${link}`).toBeTruthy();
  const partnerEmail = freshEmail("partner");
  await apiSignup(request, partnerEmail);
  const ctx = await browser.newContext(asDevice(testInfo, 1));
  await seedDayMode(ctx);
  const partner = await ctx.newPage();
  await apiSignIn(partner, partnerEmail);
  await partner.request.patch("/api/me", { data: { name: "Bo Partner" } });
  await skipGettingStarted(partner);
  await partner.goto(`/join/${code}`);
  await expect(partner).toHaveURL(/\/home/, { timeout: 10_000 });

  // Settings → Family → Daycare: the place.
  await page.goto("/settings/family");
  await page.getByRole("link", { name: "Daycare" }).click();
  await expect(page).toHaveURL(/\/settings\/family\/daycare/);
  await page.getByTestId("add-daycare-place").click();
  const form = page.getByTestId("daycare-place-form");
  await form.getByLabel("Name of the barnehage").fill("Solsikken barnehage");
  await form.getByLabel("Address").fill("Storgata 1, 0155 Oslo");
  await form.getByLabel("Phone").fill("+47 22 00 00 00");
  await form.getByLabel("Opens").fill("07:30");
  await form.getByLabel("Closes").fill("23:59");
  await form.getByRole("button", { name: "15 min" }).click();
  await form.getByRole("button", { name: "Save", exact: true }).click();

  // Saved, and her week appears because she goes there.
  const babyId = await firstBabyId(page);
  const week = page.getByTestId(`pickup-plan-${babyId}`);
  await expect(week).toBeVisible({ timeout: 10_000 });
  await week.getByLabel("Monday: Pick-up").fill("15:30");
  await week
    .getByRole("group", { name: "Monday: Who" })
    .getByRole("button", { name: /Anne/ })
    .click();
  await page.getByRole("button", { name: "Save plan" }).click();
  await expect
    .poll(async () => {
      const plan = await (
        await page.request.get(`/api/babies/${babyId}/pickup-plan`)
      ).json();
      return plan.days.length;
    })
    .toBe(1);
  await page.screenshot({ path: shot("settings.png"), fullPage: true });

  // The rest of the week through the API, so the run reads the same on any
  // weekday: Anne collects at 15:30, Monday to Friday.
  const me = await (await page.request.get("/api/me")).json();
  const put = await page.request.put(`/api/babies/${babyId}/pickup-plan`, {
    data: {
      days: [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        minute: 15 * 60 + 30,
        userId: me.userId,
      })),
    },
  });
  expect(put.ok(), `seed the week: ${put.status()}`).toBeTruthy();

  // The member reads the page and cannot edit it.
  await partner.goto("/settings/family/daycare");
  await expect(partner.getByText("Solsikken barnehage")).toBeVisible({
    timeout: 10_000,
  });
  await expect(partner.getByTestId("daycare-place-form")).toHaveCount(0);
  await expect(partner.getByTestId("add-daycare-place")).toHaveCount(0);
  await expect(partner.getByRole("button", { name: "Save plan" })).toHaveCount(0);

  // Dropped off. The banner's quiet line is the plan (on a weekend the grid
  // is silent and the line is the closing time).
  const dropped = await page.request.post("/api/daycare", {
    data: { babyId, startTime: new Date(Date.now() - 60_000).toISOString() },
  });
  expect(dropped.ok(), `drop off: ${dropped.status()}`).toBeTruthy();
  await page.goto("/home");
  const note = page.getByTestId("banner-note");
  await expect(note).toHaveText(/Pick-up 15:30 · Anne|Closes 23:59/, {
    timeout: 10_000,
  });

  // The day sheet: how to reach the place, and who collects TODAY. The
  // partner says it is them — any member may.
  await partner.goto("/home");
  await partner.getByRole("button", { name: "Edit daycare day" }).click();
  const sheet = partner.getByRole("dialog");
  const block = sheet.getByTestId("daycare-place-block");
  await expect(block.getByText("Solsikken barnehage")).toBeVisible();
  await expect(block.getByRole("link", { name: "Call" })).toHaveAttribute(
    "href",
    "tel:+4722000000",
  );
  await expect(block.getByRole("link", { name: "Directions" })).toHaveAttribute(
    "href",
    /google\.com\/maps\/search/,
  );
  const bo = sheet
    .getByTestId("collecting-chips")
    .getByRole("button", { name: /Bo/ });
  await bo.click();
  await expect(bo).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
  await sheet.screenshot({ path: shot("day-sheet.png") });
  await ctx.close();

  // The other parent's Home follows on its next read. Inside the 15 min
  // lead before the 23:59 closing time the line is the closing time
  // instead (daycareBannerLine), as the first assertion above allows —
  // CI has run in that window.
  await page.reload();
  await expect(note).toHaveText(/Pick-up( 15:30)? · Bo|Closes 23:59/, {
    timeout: 10_000,
  });
  await page.screenshot({ path: shot("home.png") });
});
