import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// Photos on milestones (issue #48), against the real artifact: a milestone
// exists, the timeline row opens its sheet, a photo is added from the
// sheet's file picker, the thumbnail shows on the row, Settings → Data
// shows the usage, and the photo can be deleted again. The server-side
// pipeline (re-encode, quota, limits) is covered by
// internal/api/photos_test.go; this is the only place the picker and the
// <img> round trip are exercised.

const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "test-results/milestone-photo-shots";
const shot = (name: string) => join(SHOT_DIR, name);

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
}

// A real PNG (a 64×48 warm gradient), built without any image library:
// zlib "stored" blocks plus CRCs are all a valid PNG needs.
function pngBuffer(width: number, height: number): Buffer {
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc32 = (buf: Buffer) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = 216 - Math.round((y / height) * 60);
      raw[o + 1] = 118 + Math.round((x / width) * 40);
      raw[o + 2] = 87;
    }
  }
  // zlib stream with one stored (uncompressed) block per ≤65535 bytes.
  const blocks: Buffer[] = [Buffer.from([0x78, 0x01])];
  for (let i = 0; i < raw.length; i += 65535) {
    const slice = raw.subarray(i, Math.min(i + 65535, raw.length));
    const last = i + 65535 >= raw.length ? 1 : 0;
    const head = Buffer.alloc(5);
    head[0] = last;
    head.writeUInt16LE(slice.length, 1);
    head.writeUInt16LE(~slice.length & 0xffff, 3);
    blocks.push(head, slice);
  }
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((b << 16) | a) >>> 0);
  blocks.push(adler);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.concat(blocks)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("adds a photo to a milestone from the sheet, sees it on the timeline, deletes it", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "photos");
  const babies = await (await page.request.get("/api/babies")).json();
  const babyId = babies[0].id as string;
  const created = await page.request.post("/api/milestones", {
    data: { babyId, time: new Date().toISOString(), title: "First smile" },
  });
  expect(created.status(), await created.text()).toBe(201);

  await page.goto("/timeline");
  await page.getByRole("button", { name: /^Milestone · First smile/ }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "Edit milestone" })).toBeVisible();

  const [uploaded] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/photos") && r.request().method() === "POST",
    ),
    sheet.locator('input[type="file"]').setInputFiles({
      name: "smile.png",
      mimeType: "image/png",
      buffer: pngBuffer(64, 48),
    }),
  ]);
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const thumb = sheet.getByRole("img", { name: "Photo" });
  await expect(thumb).toBeVisible({ timeout: 10_000 });
  // The <img> actually loaded from /api/photos/{id}.
  await expect
    .poll(() => thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBe(64);
  await settle(page);
  await page.screenshot({ path: shot("1-sheet-with-photo.png") });

  await page.keyboard.press("Escape");
  const row = page.getByRole("button", { name: /^Milestone · First smile/ });
  await expect(row.locator("img")).toBeVisible({ timeout: 10_000 });
  await settle(page);
  await page.screenshot({ path: shot("2-timeline-thumbnail.png") });

  await page.goto("/settings");
  await expect(page.getByText(/^Photos: .* MB of 500 MB$/)).toBeVisible({ timeout: 10_000 });
  await settle(page);
  await page
    .getByText(/^Photos: .* MB of 500 MB$/)
    .locator("..")
    .screenshot({ path: shot("3-settings-usage.png") });

  await page.goto("/timeline");
  await row.click();
  await sheet.getByRole("button", { name: "Delete photo" }).click();
  await expect(sheet.getByRole("img", { name: "Photo" })).toHaveCount(0, { timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(row.locator("img")).toHaveCount(0, { timeout: 10_000 });
});
