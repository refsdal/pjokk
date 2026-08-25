import { Hono } from "hono";
import type { FamEnv } from "../context";
import { canUse } from "../entitlements";

// CSV export of every log in the family, chronological, one row per entry.
// A plain (non-OpenAPI) route: browsers download it by navigation, and it
// sits behind requireFamily like everything else. Explicitly no xlsx.

const esc = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  let s = String(v);
  // Formula-injection guard (sec review M1): a leading = + - @ tab or CR
  // would execute as a formula in Excel/Sheets. Neutralize with a leading
  // apostrophe (none of our numeric fields are negative).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n']/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

const HEADERS = [
  "kind",
  "baby",
  "time",
  "end_time",
  "type",
  "detail",
  "amount",
  "unit",
  "side",
  "duration_min",
  "value",
  "location",
  "caretaker",
  "notes",
] as const;

type Row = Partial<Record<(typeof HEADERS)[number], unknown>> & {
  sortMs: number;
};

export const exportApp = new Hono<FamEnv>().get(
  "/api/export.csv",
  async (c) => {
    if (!canUse({ plan: c.var.plan }, "csvExport")) {
      return c.json({ error: "Premium required", code: "PLAN_REQUIRED" }, 402);
    }
    const fam = c.var.fam;
    const babies = await fam.listBabies();
    const babyName = new Map(babies.map((b) => [b.id, b.name]));
    const MAX = 100_000;
    const opts = { limit: MAX };

    const [
      feeds,
      diapers,
      sleeps,
      meds,
      baths,
      notes,
      milestones,
      meas,
      pumps,
    ] = await Promise.all([
      fam.listFeeds(opts),
      fam.listDiapers(opts),
      fam.listSleeps(opts),
      fam.medicine.list(opts),
      fam.bath.list(opts),
      fam.note.list(opts),
      fam.milestone.list(opts),
      fam.measurement.list(opts),
      fam.pump.list(opts),
    ]);

    const rows: Row[] = [
      ...feeds.map((r) => ({
        sortMs: r.time.getTime(),
        kind: "feed",
        baby: babyName.get(r.babyId),
        time: r.time.toISOString(),
        type: r.type,
        amount: r.amountMl,
        unit: r.amountMl != null ? (r.type === "solids" ? "g" : "ml") : null,
        side: r.side,
        duration_min: r.durationMin,
        caretaker: r.caretakerName,
        notes: r.notes,
      })),
      ...diapers.map((r) => ({
        sortMs: r.time.getTime(),
        kind: "diaper",
        baby: babyName.get(r.babyId),
        time: r.time.toISOString(),
        type: r.type,
        caretaker: r.caretakerName,
        notes: r.notes,
      })),
      ...sleeps.map((r) => ({
        sortMs: r.startTime.getTime(),
        kind: "sleep",
        baby: babyName.get(r.babyId),
        time: r.startTime.toISOString(),
        end_time: r.endTime?.toISOString() ?? null,
        location: r.location,
        caretaker: r.caretakerName,
        notes: r.notes,
      })),
      ...meds.map((r) => ({
        sortMs: r.time.getTime(),
        kind: "medicine",
        baby: babyName.get(r.babyId),
        time: r.time.toISOString(),
        detail: r.name,
        amount: r.amount,
        unit: r.unit,
        caretaker: r.caretakerName,
        notes: r.notes,
      })),
      ...baths.map((r) => ({
        sortMs: r.time.getTime(),
        kind: "bath",
        baby: babyName.get(r.babyId),
        time: r.time.toISOString(),
        caretaker: r.caretakerName,
        notes: r.notes,
      })),
      ...notes.map((r) => ({
        sortMs: r.time.getTime(),
        kind: "note",
        baby: babyName.get(r.babyId),
        time: r.time.toISOString(),
        detail: r.content,
        caretaker: r.caretakerName,
        notes: r.notes,
      })),
      ...milestones.map((r) => ({
        sortMs: r.time.getTime(),
        kind: "milestone",
        baby: babyName.get(r.babyId),
        time: r.time.toISOString(),
        detail: r.title,
        caretaker: r.caretakerName,
        notes: r.notes,
      })),
      ...meas.map((r) => ({
        sortMs: r.time.getTime(),
        kind: "measurement",
        baby: babyName.get(r.babyId),
        time: r.time.toISOString(),
        type: r.type,
        value: r.value,
        unit: r.type === "weight" ? "kg" : "cm",
        caretaker: r.caretakerName,
        notes: r.notes,
      })),
      ...pumps.map((r) => ({
        sortMs: r.time.getTime(),
        kind: "pump",
        baby: babyName.get(r.babyId),
        time: r.time.toISOString(),
        amount: r.amountMl,
        unit: r.amountMl != null ? "ml" : null,
        side: r.side,
        duration_min: r.durationMin,
        caretaker: r.caretakerName,
        notes: r.notes,
      })),
    ].sort((a, b) => a.sortMs - b.sortMs);

    const csv = [
      HEADERS.join(","),
      ...rows.map((r) => HEADERS.map((h) => esc(r[h])).join(",")),
    ].join("\n");

    const stamp = new Date().toISOString().slice(0, 10);
    return c.body(csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="pjokk-export-${stamp}.csv"`,
    });
  },
);
