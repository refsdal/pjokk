import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

test("starts a sleep session, sees the banner, wakes", async ({ page, request }) => {
  await freshFamily(page, request, "sleep");

  await page.getByRole("button", { name: "Sleep", exact: true }).click();
  // Starting a session is "Start sleep"; "Save" belongs to the edit sheet.
  await page.getByRole("button", { name: "Start sleep" }).click();

  // The active-session banner takes over Home.
  await expect(page.getByText("Sleeping").first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Wake" }).click();

  await expect(page.getByText("Sleeping")).toHaveCount(0, { timeout: 10_000 });
  // Awake now: the card reads the wake window as a duration, not "N ago",
  // and counts the session that just ended among today's naps.
  await expect(page.getByText("Awake", { exact: true })).toBeVisible();
  await expect(page.getByText("under a minute")).toBeVisible();
  await expect(page.getByText(/^1 nap · /)).toBeVisible();
});

test("tapping the sleep banner opens the edit sheet for the running session", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "sleep-edit");

  await page.getByRole("button", { name: "Sleep", exact: true }).click();
  await page.getByRole("button", { name: "Start sleep" }).click();
  await expect(page.getByText("Sleeping").first()).toBeVisible({ timeout: 10_000 });

  // The banner body is its own control, next to Wake — the same edit sheet
  // a timeline row opens, for fixing a start time logged late.
  await page.getByRole("button", { name: "Edit sleep" }).click();
  await expect(page.getByRole("heading", { name: "Edit sleep" })).toBeVisible();
  // A running session has no end time to edit; the sheet says so.
  await expect(page.getByText("Still sleeping")).toBeVisible();
  await page.getByPlaceholder("Note (optional)").fill("nap after lunch");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  // Saving edits the session rather than starting a second one: the banner
  // is still there, and Wake still ends it.
  await expect(page.getByRole("heading", { name: "Edit sleep" })).toHaveCount(0);
  await expect(page.getByText("Sleeping").first()).toBeVisible();
  await page.getByRole("button", { name: "Wake" }).click();
  await expect(page.getByText("Sleeping")).toHaveCount(0, { timeout: 10_000 });

  // The note landed on the one and only sleep entry: the timeline row (notes
  // render there as an icon, not text) opens the same sheet with it filled.
  await page.goto("/timeline");
  // The row, not the "Sleep" filter chip: the row's name carries its detail.
  // The sheet defaults the session's type from the clock (#43), so the row
  // is "Nap · …" by day and "Night sleep · …" inside the night window.
  await page.getByRole("button", { name: /^(Nap|Night sleep) · / }).first().click();
  await expect(page.getByRole("heading", { name: "Edit sleep" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByPlaceholder("Note (optional)")).toHaveValue("nap after lunch");
});

async function firstBabyId(page: import("@playwright/test").Page): Promise<string> {
  const babies = await (await page.request.get("/api/babies")).json();
  return babies[0].id as string;
}

async function logSleep(
  page: import("@playwright/test").Page,
  babyId: string,
  endMinutesAgo: number,
  type: "nap" | "night",
) {
  const end = new Date(Date.now() - endMinutesAgo * 60_000);
  const start = new Date(end.getTime() - 60 * 60_000);
  const res = await page.request.post("/api/sleep", {
    data: { babyId, startTime: start.toISOString(), endTime: end.toISOString(), type },
  });
  expect(res.status(), await res.text()).toBe(201);
}

test("Resume on the awake card reopens a sleep ended by mistake, as one session", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "sleep-resume");

  await page.getByRole("button", { name: "Sleep", exact: true }).click();
  await page.getByRole("button", { name: "Start sleep" }).click();
  await expect(page.getByText("Sleeping").first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Wake" }).click();
  await expect(page.getByText("Awake", { exact: true })).toBeVisible({ timeout: 10_000 });

  // Straight after a wake the awake card offers Resume.
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByText("Sleeping").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);

  // One session, not two: Resume cleared the end time of the same row.
  const babyId = await firstBabyId(page);
  await expect
    .poll(async () => {
      const sleeps = await (await page.request.get(`/api/sleep?babyId=${babyId}`)).json();
      return sleeps.map((s: { endTime: string | null }) => s.endTime);
    })
    .toEqual([null]);
});

test("past the window, only the newest sleep's edit sheet offers Resume", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "sleep-resume-edit");
  const babyId = await firstBabyId(page);
  await logSleep(page, babyId, 120, "nap");
  await page.reload();

  // Two hours on, the awake card no longer offers it...
  await expect(page.getByText("Awake", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);

  // ...but the edit sheet of the newest sleep does.
  await page.goto("/timeline");
  await page.getByRole("button", { name: /^Nap · / }).first().click();
  await expect(page.getByRole("heading", { name: "Edit sleep" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Resume sleep" }).click();
  await expect(page.getByRole("heading", { name: "Edit sleep" })).toHaveCount(0);

  // Back to Home through the tab bar, as a parent would. Not page.goto: a
  // full reload tens of milliseconds after the mutation restores the
  // IndexedDB snapshot the persister has not yet rewritten, which is about
  // the persister's throttle, not about Resume.
  await page.getByRole("link", { name: "Home" }).click();
  await expect(page.getByText("Sleeping").first()).toBeVisible({ timeout: 10_000 });
});

test("in night mode, the Sleep row splits into Resume and Sleep after a wake", async ({
  page,
  request,
  context,
}) => {
  await freshFamily(page, request, "sleep-resume-night");
  const babyId = await firstBabyId(page);
  await logSleep(page, babyId, 5, "night");
  // Added after the fixture's day-mode seed, so it runs later and wins.
  await context.addInitScript(() => {
    try {
      localStorage.setItem("pjokk.night.mode", "on");
    } catch {
      // storage unavailable
    }
  });
  await page.reload();

  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "Sleep", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("button", { name: "Wake" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
});
