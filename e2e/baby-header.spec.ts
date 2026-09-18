import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// The baby header: the babies in a fixed row on every baby screen, the
// current one a pill, the others faces — and a photo of the baby, set on
// the baby's settings page, that shows in that row.

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

test("a photo of the baby shows in the header", async ({ page, request }) => {
  await freshFamily(page, request, "babyphoto");

  await page.goto("/settings");
  await page.getByRole("link", { name: /Baby babyphoto/ }).click();
  await expect(page).toHaveURL(/\/settings\/baby\//);
  await page.getByLabel("Change photo").setInputFiles({
    name: "baby.png",
    mimeType: "image/png",
    buffer: PNG_1x1,
  });
  await expect(page.getByText("Photo updated")).toBeVisible({ timeout: 10_000 });

  await page.goto("/home");
  const header = page.locator("header").first();
  await expect(header.getByText("Baby babyphoto")).toBeVisible();
  await expect(header.locator("img").first()).toBeVisible();

  // The same header on Timeline.
  await page.goto("/timeline");
  await expect(page.locator("header").first().locator("img").first()).toBeVisible();

  await page.goto("/settings");
  await page.getByRole("link", { name: /Baby babyphoto/ }).click();
  await page.getByRole("button", { name: "Remove photo" }).click();
  await expect(page.getByText("Photo removed")).toBeVisible();
  await page.goto("/home");
  await expect(page.locator("header").first().locator("img")).toHaveCount(0);
});

test("a second baby joins the row and one tap switches", async ({ page, request }) => {
  await freshFamily(page, request, "twobabies");

  await page.goto("/settings");
  await page.getByRole("button", { name: "Add baby" }).click();
  await page.getByPlaceholder("Baby's name").fill("Oskar");
  await page.getByLabel("Birth date").fill("2024-01-10");
  await page.getByRole("button", { name: "Save" }).click();
  // A new baby chooses what to track first (e2e/tracking.spec.ts).
  await expect(page).toHaveURL(/\/settings\/baby\/[^/]+\/tracking/);
  await page.getByTestId("use-recommended").click();
  await page.getByTestId("tracking-done").click();
  await expect(page).toHaveURL(/\/home/);
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: /Oskar/ })).toBeVisible();

  await page.goto("/home");
  // The first baby is the pill (pressed, name as text); Oskar is a face
  // named for the screen reader, to the RIGHT of it.
  const first = page.getByRole("button", { name: "Baby twobabies", pressed: true });
  const oskar = page.getByRole("button", { name: "Oskar", exact: true });
  await expect(first).toBeVisible();
  await expect(oskar).toHaveAttribute("aria-pressed", "false");
  const firstBox = await first.boundingBox();
  const oskarBox = await oskar.boundingBox();
  expect(oskarBox!.x).toBeGreaterThan(firstBox!.x);

  await oskar.click();
  await expect(page.getByRole("button", { name: "Oskar", pressed: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Baby twobabies", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  // The order did not change: the first baby's face stays on the left.
  const firstAfter = await page.getByRole("button", { name: "Baby twobabies", exact: true }).boundingBox();
  const oskarAfter = await page.getByRole("button", { name: "Oskar", pressed: true }).boundingBox();
  expect(firstAfter!.x).toBeLessThan(oskarAfter!.x);

  // The selection follows to Stats.
  await page.goto("/stats");
  await expect(page.getByRole("button", { name: "Oskar", pressed: true })).toBeVisible();
});

// The selected pill's ring is drawn OUTSIDE its box, and the row is a
// scroll container that clips: the pill must sit inside the row with room
// for the ring on every side, however long the name.
test("the selected pill's ring is not clipped by the row", async ({ page, request }) => {
  await freshFamily(page, request, "ring");
  const res = await page.request.post("/api/babies", {
    data: { name: "Maximilian Alexander", birthDate: "2024-01-10T00:00:00Z" },
  });
  expect(res.ok()).toBeTruthy();
  await page.goto("/home");
  const long = page.getByRole("button", { name: "Maximilian Alexander", exact: true });
  await expect(long).toBeVisible();
  const room = () =>
    page.evaluate(() => {
      const fs = document.querySelector("header fieldset") as HTMLElement;
      const f = fs.getBoundingClientRect();
      const p = fs.querySelector("[aria-pressed=true]")!.getBoundingClientRect();
      return { top: p.top - f.top, bottom: f.bottom - p.bottom, left: p.left - f.left, right: f.right - p.right };
    });
  for (const side of Object.values(await room())) expect(side).toBeGreaterThanOrEqual(2);
  await long.click();
  // Selected, the button is the pill: its name now carries the age too.
  await expect(
    page.getByRole("button", { name: /Maximilian Alexander/, pressed: true }),
  ).toBeVisible();
  for (const side of Object.values(await room())) expect(side).toBeGreaterThanOrEqual(2);
});

// The ring's colour is what she is doing right now (lib/baby-status.ts):
// the pill says so in data-status, and a single baby gets a ring only
// while something is happening.
test("the ring follows the baby's status: sleeping, then at barnehage", async ({ page, request }) => {
  await freshFamily(page, request, "status");
  const [baby] = (await (await page.request.get("/api/babies")).json()) as { id: string }[];
  const face = page.locator("header [data-status]");
  await expect(face).toHaveAttribute("data-status", "none");
  await expect(face).not.toHaveClass(/ring-2/);

  const sleep = await page.request.post("/api/sleep", {
    data: { babyId: baby.id, startTime: new Date(Date.now() - 60_000).toISOString(), type: "nap" },
  });
  expect(sleep.ok()).toBeTruthy();
  await page.reload();
  await expect(face).toHaveAttribute("data-status", "sleeping");
  await expect(face).toHaveClass(/ring-sleep/);

  // Woken, then dropped off: the green.
  const { id } = (await sleep.json()) as { id: string };
  const wake = await page.request.patch(`/api/sleep/${id}`, {
    data: { endTime: new Date().toISOString() },
  });
  expect(wake.ok(), `wake: ${wake.status()} ${await wake.text()}`).toBeTruthy();
  const drop = await page.request.post("/api/daycare", {
    data: { babyId: baby.id, startTime: new Date().toISOString() },
  });
  expect(drop.ok()).toBeTruthy();
  await page.reload();
  await expect(face).toHaveAttribute("data-status", "daycare");
  await expect(face).toHaveClass(/ring-daycare/);

  // With two babies the selected pill carries it the same way.
  const res = await page.request.post("/api/babies", {
    data: { name: "Oskar", birthDate: "2024-01-10T00:00:00Z" },
  });
  expect(res.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator("header [aria-pressed=true]")).toHaveAttribute("data-status", "daycare");
});

// With a PHOTO the face is an image, whose baseline is its bottom edge: in
// a wrapper laid out as a text line the descender space went underneath,
// and the single baby's status ring was an oval 7 px taller than the face.
// The ring must hug the face exactly, photo or initial.
test("the status ring hugs a face with a photo", async ({ page, request }) => {
  await freshFamily(page, request, "ring-photo");
  const [baby] = (await (await page.request.get("/api/babies")).json()) as { id: string }[];
  const up = await page.request.put(`/api/babies/${baby.id}/avatar`, {
    multipart: {
      file: {
        name: "baby.png",
        mimeType: "image/png",
        buffer: readFileSync(new URL("../apps/frontend/public/icon-192.png", import.meta.url)),
      },
    },
  });
  expect(up.ok(), `upload: ${up.status()}`).toBeTruthy();
  const sleep = await page.request.post("/api/sleep", {
    data: { babyId: baby.id, startTime: new Date(Date.now() - 60_000).toISOString(), type: "nap" },
  });
  expect(sleep.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator("header [data-status=sleeping] img")).toBeVisible();
  const box = await page.evaluate(() => {
    const ring = document.querySelector("header [data-status]") as HTMLElement;
    const face = ring.firstElementChild as HTMLElement;
    const r = ring.getBoundingClientRect();
    const f = face.getBoundingClientRect();
    return { dw: r.width - f.width, dh: r.height - f.height, dx: r.left - f.left, dy: r.top - f.top };
  });
  expect(box).toEqual({ dw: 0, dh: 0, dx: 0, dy: 0 });

  // The same holds for every face in the header that has a photo: a second
  // baby's bare face, and the caretaker's own face on the right.
  await page.request.post("/api/babies", {
    data: { name: "Oskar", birthDate: "2024-01-10T00:00:00Z" },
  });
  const babies = (await (await page.request.get("/api/babies")).json()) as {
    id: string;
    name: string;
  }[];
  const oskar = babies.find((b) => b.name === "Oskar")!;
  const photo = readFileSync(new URL("../apps/frontend/public/icon-192.png", import.meta.url));
  for (const path of [`/api/babies/${oskar.id}/avatar`, "/api/me/avatar"]) {
    const res = await page.request.put(path, {
      multipart: { file: { name: "p.png", mimeType: "image/png", buffer: photo } },
    });
    expect(res.ok(), `${path}: ${res.status()}`).toBeTruthy();
  }
  await page.reload();
  await expect(page.locator("header img")).toHaveCount(3);
  const faces = await page.evaluate(() =>
    [...document.querySelectorAll("header button")]
      .filter((b) => b.querySelector("img") && b.getAttribute("aria-pressed") !== "true")
      .map((b) => {
        const face = b.querySelector("span") as HTMLElement;
        const r = b.getBoundingClientRect();
        const f = face.getBoundingClientRect();
        return r.height - f.height;
      }),
  );
  expect(faces).toEqual([0, 0]);
});
