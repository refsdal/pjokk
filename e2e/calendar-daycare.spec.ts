import { join } from "node:path";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// Barnehage on the calendar (issue #110): a category of its own, a "closed
// that day" flag, and Home saying so the evening before — a closed day
// found out at the gate is the failure this exists to prevent.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/calendar-daycare-shots";
const shot = (name: string) => join(SHOT_DIR, name);

const pad = (n: number) => String(n).padStart(2, "0");
const dateInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

test("a planning day marked closed shows on Home the day before", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "closedday");
  const closed = page.getByTestId("closed-day");
  await expect(closed).toHaveCount(0);

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  await page.goto("/calendar");
  await page.getByRole("button", { name: "Add event" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByPlaceholder("Title").fill("Planning day");
  // The chip only exists for the barnehage category.
  await expect(sheet.getByRole("button", { name: "Closed that day" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Daycare", exact: true }).click();
  const chip = sheet.getByRole("button", { name: "Closed that day" });
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  // A closed day is a whole day.
  await expect(sheet.getByRole("button", { name: "All day", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await sheet.locator('input[type="date"]').first().fill(dateInput(tomorrow));
  await sheet.screenshot({ path: shot("sheet.png") });
  await sheet.getByRole("button", { name: "Save" }).click();

  await page.goto("/home");
  await expect(closed).toContainText("Daycare is closed tomorrow", { timeout: 10_000 });
  await expect(closed).toContainText("Planning day");
  await page.screenshot({ path: shot("home.png") });

  // An ordinary barnehage event the same day says nothing on Home.
  const meeting = await page.request.post("/api/calendar/events", {
    data: {
      title: "Parent meeting",
      category: "daycare",
      startTime: new Date(tomorrow.setHours(18, 0, 0, 0)).toISOString(),
    },
  });
  expect(meeting.status()).toBe(201);
  await page.reload();
  await expect(closed).toContainText("Planning day", { timeout: 10_000 });
  await expect(closed).not.toContainText("Parent meeting");
});

// The pick-up rota (issue #125): one tap under the Daycare category fills an
// ordinary event that repeats Monday to Friday.
test("the pick-up preset makes a weekday series", async ({ page, request }) => {
  await freshFamily(page, request, "pickup");
  await page.goto("/calendar");
  await page.getByRole("button", { name: "Add event" }).click();
  const sheet = page.getByRole("dialog");
  // The preset belongs to the category, and only shows there.
  await expect(sheet.getByRole("button", { name: "Pick-up, weekdays" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Daycare", exact: true }).click();
  await sheet.getByRole("button", { name: "Pick-up, weekdays" }).click();
  await expect(sheet.getByPlaceholder("Title")).toHaveValue("Pick-up");
  await expect(sheet.locator('input[type="time"]').first()).toHaveValue("15:30");
  await expect(sheet.getByRole("button", { name: "Weekdays", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await sheet.screenshot({ path: shot("pickup-sheet.png") });
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();

  // One row, and over the next fortnight it lists on weekdays only: ten
  // occurrences, never a Saturday or a Sunday.
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  // From next Monday, so the window is exactly two whole weeks.
  from.setDate(from.getDate() + ((8 - from.getDay()) % 7 || 7));
  const to = new Date(from);
  to.setDate(from.getDate() + 14);
  const res = await page.request.get(
    `/api/calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`,
  );
  const events = (await res.json()) as { title: string; startTime: string; recurrence: string }[];
  const pickups = events.filter((e) => e.title === "Pick-up");
  expect(pickups).toHaveLength(10);
  expect(new Set(pickups.map((e) => e.recurrence))).toEqual(new Set(["weekdays"]));
  for (const e of pickups) {
    const day = new Date(e.startTime).getDay();
    expect([0, 6], `${e.startTime} is a weekend`).not.toContain(day);
  }
});
