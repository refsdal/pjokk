import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// Issue #52 against the real artifact: a weekly event entered once shows
// up on every week of the upcoming list and carries an RRULE in the .ics
// feed a calendar app subscribes to; Settings mints the feed link; and
// the timeline's search finds an entry by its note or its medicine name.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/calendar-shots";
const shot = (name: string) => join(SHOT_DIR, name);

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
}

test("a weekly event repeats in the calendar and the ICS feed", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "recurring");
  const sheet = page.getByRole("dialog");

  await page.goto("/calendar");
  await page.getByRole("button", { name: "Add event" }).click();
  await sheet.getByPlaceholder("Title").fill("Physio");
  await sheet.getByRole("button", { name: "Doctor", exact: true }).click();
  await sheet.getByRole("button", { name: "Weekly", exact: true }).click();
  await settle(page);
  await page.screenshot({ path: shot("1-event-sheet-weekly.png") });
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();

  // One row per week in the 90-day upcoming list, each marked as repeating.
  const rows = page.getByRole("button", { name: /^Physio/ });
  await expect(rows.first()).toBeVisible({ timeout: 10_000 });
  expect(await rows.count()).toBeGreaterThan(10);
  await expect(rows.first().getByLabel("Repeats")).toBeVisible();
  await settle(page);
  await page.screenshot({ path: shot("2-calendar-upcoming-weekly.png") });

  // Tapping an occurrence edits that one by default; All events edits the
  // series and says so.
  await rows.nth(2).click();
  await expect(
    sheet.getByRole("button", { name: "This event", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await sheet.getByRole("button", { name: "All events", exact: true }).click();
  await expect(
    sheet.getByText("Changes apply to every occurrence in the series."),
  ).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Weekly", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // The feed: a read-only key in the query string, the series as an RRULE.
  const key = await (
    await page.request.post("/api/keys", {
      data: { name: "Calendar subscription", readOnly: true },
    })
  ).json();
  const ics = await page.request.get(`/api/calendar.ics?key=${key.key}`);
  expect(ics.status()).toBe(200);
  const body = await ics.text();
  expect(body).toContain("BEGIN:VCALENDAR");
  expect(body).toContain("SUMMARY:Physio");
  expect(body).toContain("RRULE:FREQ=WEEKLY");
  // (No-key → 401 is asserted in internal/api/ics_test.go; every request
  // context here carries the session.)

  // Settings mints the link and shows it once.
  await page.goto("/settings");
  await page.getByRole("button", { name: "Create calendar link" }).click();
  const link = page.getByText(/\/api\/calendar\.ics\?key=pjk_/);
  await expect(link).toBeVisible({ timeout: 10_000 });
  await link.scrollIntoViewIfNeeded();
  await settle(page);
  await page
    .getByText("Calendar subscription", { exact: true })
    .locator("xpath=following-sibling::*[1]")
    .screenshot({ path: shot("3-settings-calendar-link.png") });
});

test("the timeline search finds entries by note and by medicine name", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "search");
  const babies = await (await page.request.get("/api/babies")).json();
  const babyId = babies[0].id as string;
  const h = 3600_000;
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const post = async (path: string, data: Record<string, unknown>) => {
    const res = await page.request.post(path, { data: { babyId, ...data } });
    expect(res.status(), await res.text()).toBe(201);
  };
  await post("/api/feeds", { time: iso(5 * h), type: "solids", food: "Avocado", notes: "small reaction on the cheek" });
  await post("/api/feeds", { time: iso(4 * h), type: "bottle", amountMl: 120 });
  await post("/api/medicine", { time: iso(3 * h), name: "Ibuprofen", amount: 2.5, unit: "ml" });

  await page.goto("/timeline");
  await expect(page.getByRole("button", { name: /^Bottle/ })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const field = page.getByPlaceholder("Search notes, medicines, milestones…");
  await field.fill("reaction");
  await expect(page.getByRole("button", { name: /^Bottle/ })).toBeHidden({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /^Solids/ })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: shot("4-timeline-search.png") });

  await field.fill("ibuprofen");
  await expect(page.getByRole("button", { name: /^Ibuprofen/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /^Solids/ })).toBeHidden();

  await field.fill("zzz");
  await expect(page.getByText("No entries match your search.")).toBeVisible({ timeout: 10_000 });
});

// One occurrence of a series, deleted or changed on its own
// (docs/superpowers/specs/2026-09-11-calendar-occurrence-exceptions-design.md).
test("one occurrence of a weekly event is deleted or changed on its own", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "occurrence");
  const sheet = page.getByRole("dialog");

  await page.goto("/calendar");
  await page.getByRole("button", { name: "Add event" }).click();
  await sheet.getByPlaceholder("Title").fill("Swim");
  await sheet.getByRole("button", { name: "Weekly", exact: true }).click();
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();

  const rows = page.getByRole("button", { name: /^Swim/ });
  await expect(rows.first()).toBeVisible({ timeout: 10_000 });
  const before = await rows.count();

  // Delete the second occurrence only.
  await rows.nth(1).click();
  await expect(
    sheet.getByRole("button", { name: "This event", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await sheet.getByRole("button", { name: "Delete this event" }).click();
  await sheet.getByRole("button", { name: "Tap again to confirm" }).click();
  await expect(sheet).toBeHidden();
  await expect(rows).toHaveCount(before - 1);

  // Change the (new) second one only: it leaves the series as its own event.
  await rows.nth(1).click();
  await sheet.getByPlaceholder("Title").fill("Swim at the lake");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  const lake = page.getByRole("button", { name: /^Swim at the lake/ });
  await expect(lake).toHaveCount(1);
  await expect(lake.getByLabel("Repeats")).toHaveCount(0);
  await expect(rows).toHaveCount(before - 1);

  // The feed leaves both out of the series, and lists the changed one.
  const key = await (
    await page.request.post("/api/keys", {
      data: { name: "Calendar subscription", readOnly: true },
    })
  ).json();
  const body = await (await page.request.get(`/api/calendar.ics?key=${key.key}`)).text();
  expect((body.match(/^EXDATE/gm) ?? []).length).toBe(2);
  expect(body).toContain("SUMMARY:Swim at the lake");
});
