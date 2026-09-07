// One-off importer: Baby Buddy CSV exports → Pjokk (Postgres). Issue #54.
//
// Baby Buddy (https://github.com/babybuddy/babybuddy) exports one CSV per
// model from its admin ("Import/Export" on each list — Feeding, Diaper
// Change, Sleep, Temperature, Weight, Height, Head Circumference,
// Pumping, Note, Tummy Time, Medication, Child). Columns are the model's
// field names (core/admin.py's ImportExportResourceBase), the child as
// `child_id` plus `child_first_name` / `child_last_name`, and every
// datetime as "YYYY-MM-DD HH:MM:SS" in the SERVER's time zone with no
// offset — hence --tz. Amounts, weights, lengths and temperatures carry NO
// unit in Baby Buddy (each family picks its own), hence the unit flags.
//
// 1) Export each model you want from Baby Buddy's admin as CSV.
//
// 2) Generate SQL (resolving the target family from one account at apply
//    time, and creating the babies from the child columns):
//      node scripts/import-babybuddy.mjs feeding.csv sleep.csv diaperchange.csv … \
//        --resolve-by-email you@example.com --create-babies \
//        --tz Europe/Oslo --volume ml --weight kg --length cm --temperature c \
//        --out pjokk-import.sql
//
//    …or name the target ids yourself: --family <id> --caretaker <userId>
//    --baby <child_id>=<pjokkBabyId>.
//
// 3) Apply (review the SQL first — it is a one-off against real data):
//      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f pjokk-import.sql
//
// Idempotent: deterministic ids (bb-<model>-<id>) and ON CONFLICT DO
// NOTHING, so re-running never duplicates. Fixing a mapping and
// re-running does NOT update rows already imported: delete the bb-% rows
// first.
//
// Imported: feedings (bottle / breast / solids), diaper changes, sleep
// (nap flag → type), temperatures, weights, heights, head circumferences,
// pumping, notes, tummy time (→ play), medications, children.
//
// Mapping notes — the "lossy on purpose, preserved in notes" policy:
//   Feeding.type "breast milk" / "formula" → contents; "fortified breast
//   milk" → contents mixed, "fortified" in notes; "solid food" → a solids
//   feed whose amount is taken as GRAMS whatever --volume says (the
//   summary counts it). Feeding.method "bottle" → bottle; "left/right/both
//   breasts" → breast with side; "parent fed" / "self fed" → solids
//   method, kept in notes. duration → duration_min for breast feeds.
//   DiaperChange wet+solid → both, wet → wet, solid → dirty, neither → dry;
//   color maps 1:1 (Pjokk has the same four plus red/other); amount → notes.
//   Sleep.nap → type nap / night. Weight/Height/Head dates (no time) land
//   at 12:00 in --tz. Medication.dosage_unit tablets → dose;
//   next_dose_interval → notes. TummyTime.milestone → notes.
//   Tags are dropped (the summary counts rows that had any). BMI rows are
//   skipped (derived). Pictures and note images are not exported by Baby
//   Buddy's CSV and cannot be imported.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseCsv } from "./lib/csv.mjs";
import { argv, createWriter, esc, escOrNull } from "./lib/import-writer.mjs";
import { zonedToUtcMs } from "./lib/zoned-time.mjs";

const args = process.argv.slice(2);
const { flag, flagAll, has } = argv(args);
const files = args.filter(
  (a, i) =>
    a.endsWith(".csv") &&
    !(
      i > 0 &&
      args[i - 1].startsWith("--") &&
      !["--create-babies", "--inspect"].includes(args[i - 1])
    ),
);
if (files.length === 0) {
  console.error(
    "usage: node scripts/import-babybuddy.mjs <export.csv>... (--resolve-by-email you@example.com | --family <id> --caretaker <userId>) [--create-babies | --baby <child_id>=<babyId>] [--tz Europe/Oslo] [--volume ml|oz] [--weight kg|lb] [--length cm|in] [--temperature c|f] [--out file.sql] [--inspect]",
  );
  process.exit(1);
}

const resolveEmail = flag("resolve-by-email");
const familyId = flag("family");
const caretakerId = flag("caretaker");
const createBabies = has("create-babies");
const babyMap = new Map(flagAll("baby").map((p) => p.split("=")));
const tz = flag("tz") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const outPath = flag("out") ?? ".import.sql";
const units = {
  volume: (flag("volume") ?? "ml").toLowerCase(),
  weight: (flag("weight") ?? "kg").toLowerCase(),
  length: (flag("length") ?? "cm").toLowerCase(),
  temperature: (flag("temperature") ?? "c").toLowerCase(),
};
for (const [k, allowed] of [
  ["volume", ["ml", "oz"]],
  ["weight", ["kg", "lb"]],
  ["length", ["cm", "in"]],
  ["temperature", ["c", "f"]],
]) {
  if (!allowed.includes(units[k])) {
    console.error(`--${k} must be one of ${allowed.join("|")}`);
    process.exit(1);
  }
}

// ---- Detect each file's model from its header row -----------------------
const MODELS = [
  [
    "child",
    (h) => h.has("first_name") && h.has("birth_date") && !h.has("child_id"),
  ],
  ["feeding", (h) => h.has("method") && h.has("type")],
  ["diaperchange", (h) => h.has("wet") && h.has("solid")],
  ["sleep", (h) => h.has("nap") && h.has("start")],
  ["temperature", (h) => h.has("temperature")],
  ["weight", (h) => h.has("weight") && h.has("date")],
  ["height", (h) => h.has("height") && h.has("date")],
  ["headcircumference", (h) => h.has("head_circumference")],
  ["pumping", (h) => h.has("amount") && h.has("start") && !h.has("method")],
  ["note", (h) => h.has("note") && h.has("time")],
  ["tummytime", (h) => h.has("milestone") && h.has("start")],
  ["medication", (h) => h.has("dosage_unit")],
  ["bmi", (h) => h.has("bmi")],
];
const inputs = files.map((f) => {
  const { headers, rows } = parseCsv(readFileSync(f, "utf8"));
  const h = new Set(headers);
  const model = MODELS.find(([, test]) => test(h))?.[0] ?? null;
  return { file: f, model, rows, headers };
});

if (has("inspect")) {
  const children = new Map();
  for (const { file, model, rows } of inputs) {
    console.log(
      `${basename(file)}: ${model ?? "UNRECOGNISED"} (${rows.length} rows)`,
    );
    for (const r of rows) {
      const id = model === "child" ? r.id : r.child_id;
      const name =
        model === "child"
          ? `${r.first_name} ${r.last_name}`.trim()
          : `${r.child_first_name ?? ""} ${r.child_last_name ?? ""}`.trim();
      if (id) children.set(id, name || children.get(id) || "");
    }
  }
  console.log("== Children ==");
  for (const [id, name] of children) console.log(`  ${id}  ${name}`);
  process.exit(0);
}

if (!resolveEmail && !(familyId && caretakerId)) {
  console.error(
    "--resolve-by-email, or both --family and --caretaker, is required",
  );
  process.exit(1);
}
if (!createBabies && babyMap.size === 0) {
  console.error(
    "at least one --baby <child_id>=<babyId> mapping (or --create-babies) is required (run --inspect first)",
  );
  process.exit(1);
}

const w = createWriter({ resolveEmail, familyId, caretakerId });
const { skip, now, familyExpr, caretakerExpr, insert } = w;
const at = (text) => zonedToUtcMs(text, tz);
const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const bool = (v) =>
  ["1", "true", "True", "TRUE", "yes"].includes(String(v).trim());
// Baby Buddy's DurationField exports as "HH:MM:SS" (or "D days, HH:MM:SS").
const durationMin = (v, start, end) => {
  const m = /^(?:(\d+) days?, )?(\d+):(\d{2}):(\d{2})/.exec(
    String(v ?? "").trim(),
  );
  if (m)
    return Math.round(+(m[1] ?? 0) * 24 * 60 + +m[2] * 60 + +m[3] + +m[4] / 60);
  const s = at(start);
  const e = at(end);
  return s != null && e != null ? Math.round((e - s) / 60000) : null;
};
const toMl = (v) =>
  v == null ? null : Math.round(units.volume === "oz" ? v * 29.5735 : v);
const toKg = (v) => (units.weight === "lb" ? v * 0.45359237 : v);
const toCm = (v) => (units.length === "in" ? v * 2.54 : v);
const toC = (v) => (units.temperature === "f" ? ((v - 32) * 5) / 9 : v);
const tagsNote = (r) => {
  if (r.tags && String(r.tags).trim()) skip("tags dropped");
  return null;
};

// ---- Babies --------------------------------------------------------------
// Every log row names its child, so --create-babies needs no child.csv;
// child.csv adds the birth date (and nothing else Pjokk stores).
const children = new Map(); // child_id → { name, birthMs }
for (const { model, rows } of inputs) {
  for (const r of rows) {
    if (model === "child") {
      children.set(r.id, {
        name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
        birthMs: r.birth_date
          ? at(`${r.birth_date} ${r.birth_time || "12:00:00"}`)
          : null,
      });
    } else if (r.child_id && !children.has(r.child_id)) {
      children.set(r.child_id, {
        name: `${r.child_first_name ?? ""} ${r.child_last_name ?? ""}`.trim(),
        birthMs: null,
      });
    }
  }
}
w.prelude();
if (createBabies) {
  for (const [id, c] of children) {
    if (babyMap.has(id)) continue;
    babyMap.set(id, `bb-child-${id}`);
    if (c.birthMs == null)
      skip(
        `baby ${c.name || id} created without a birth date (export child.csv too)`,
      );
    w.baby({
      id: `bb-child-${id}`,
      name: c.name,
      birthDateMs: c.birthMs ?? now,
      sex: null,
    });
  }
}

const base = (model, r, timeMs) => {
  const babyId = babyMap.get(r.child_id);
  if (!babyId) return skip("unmapped child"), null;
  if (timeMs == null) return skip("unparseable time"), null;
  return [
    esc(`bb-${model}-${r.id}`),
    familyExpr(),
    esc(babyId),
    caretakerExpr(),
    timeMs,
  ];
};
const notes = (...parts) =>
  parts
    .filter((p) => p !== null && p !== undefined && String(p).trim() !== "")
    .join(" · ") || null;

for (const { file, model, rows } of inputs) {
  if (!model) {
    console.warn(
      `warning: ${basename(file)}: headers not recognised as a Baby Buddy export, skipped`,
    );
    continue;
  }
  if (model === "child") continue;
  for (const r of rows) {
    switch (model) {
      case "feeding": {
        const b = base(model, r, at(r.start));
        if (!b) continue;
        const method = String(r.method ?? "").toLowerCase();
        const kind = String(r.type ?? "").toLowerCase();
        const solids = kind === "solid food";
        const breast = /breast/.test(method);
        const type = solids ? "solids" : breast ? "breast" : "bottle";
        const contents = solids
          ? null
          : kind === "formula"
            ? "formula"
            : kind === "breast milk"
              ? "breast_milk"
              : kind === "fortified breast milk"
                ? "mixed"
                : null;
        const side =
          method === "left breast"
            ? "left"
            : method === "right breast"
              ? "right"
              : method === "both breasts"
                ? "both"
                : null;
        const amount = num(r.amount);
        if (solids && amount != null && units.volume === "oz")
          skip("solids amount taken as grams, not oz");
        insert(
          "feed_log",
          [
            "id",
            "family_id",
            "baby_id",
            "caretaker_id",
            "time",
            "type",
            "amount_ml",
            "side",
            "duration_min",
            "contents",
            "food",
            "reaction",
            "notes",
            "created_at",
          ],
          [
            ...b,
            esc(type),
            type === "breast"
              ? "NULL"
              : solids
                ? amount == null
                  ? "NULL"
                  : Math.round(amount)
                : (toMl(amount) ?? "NULL"),
            side ? esc(side) : "NULL",
            type === "breast"
              ? (durationMin(r.duration, r.start, r.end) ?? "NULL")
              : "NULL",
            type === "bottle" && contents ? esc(contents) : "NULL",
            "NULL",
            "NULL",
            escOrNull(
              notes(
                kind === "fortified breast milk" ? "fortified" : null,
                solids && /fed/.test(method) ? method : null,
                r.notes,
                tagsNote(r),
              ),
            ),
            now,
          ],
        );
        break;
      }
      case "diaperchange": {
        const b = base(model, r, at(r.time));
        if (!b) continue;
        const wet = bool(r.wet);
        const solid = bool(r.solid);
        const type =
          wet && solid ? "both" : wet ? "wet" : solid ? "dirty" : "dry";
        const color = ["yellow", "green", "brown", "black"].includes(
          String(r.color).toLowerCase(),
        )
          ? String(r.color).toLowerCase()
          : null;
        const amount = num(r.amount);
        insert(
          "diaper_log",
          [
            "id",
            "family_id",
            "baby_id",
            "caretaker_id",
            "time",
            "type",
            "color",
            "consistency",
            "notes",
            "created_at",
          ],
          [
            ...b,
            esc(type),
            color ? esc(color) : "NULL",
            "NULL",
            escOrNull(
              notes(
                amount != null ? `amount ${amount}` : null,
                r.notes,
                tagsNote(r),
              ),
            ),
            now,
          ],
        );
        break;
      }
      case "sleep": {
        const b = base(model, r, at(r.start));
        if (!b) continue;
        const end = at(r.end);
        insert(
          "sleep_log",
          [
            "id",
            "family_id",
            "baby_id",
            "caretaker_id",
            "start_time",
            "end_time",
            "location",
            "type",
            "notes",
            "created_at",
          ],
          [
            ...b,
            end ?? "NULL",
            "NULL",
            esc(bool(r.nap) ? "nap" : "night"),
            escOrNull(notes(r.notes, tagsNote(r))),
            now,
          ],
        );
        break;
      }
      case "temperature":
      case "weight":
      case "height":
      case "headcircumference": {
        const timeText = model === "temperature" ? r.time : r.date;
        const b = base(model, r, at(timeText));
        if (!b) continue;
        const raw = num(
          model === "temperature"
            ? r.temperature
            : model === "weight"
              ? r.weight
              : model === "height"
                ? r.height
                : r.head_circumference,
        );
        if (raw == null) {
          skip(`${model} without a value`);
          continue;
        }
        const type =
          model === "temperature"
            ? "temperature"
            : model === "weight"
              ? "weight"
              : model === "height"
                ? "length"
                : "head";
        const value =
          model === "temperature"
            ? toC(raw)
            : model === "weight"
              ? toKg(raw)
              : toCm(raw);
        insert(
          "measurement_log",
          [
            "id",
            "family_id",
            "baby_id",
            "caretaker_id",
            "time",
            "type",
            "value",
            "notes",
            "created_at",
          ],
          [
            ...b,
            esc(type),
            Math.round(value * 100) / 100,
            escOrNull(notes(r.notes, tagsNote(r))),
            now,
          ],
        );
        break;
      }
      case "pumping": {
        const b = base(model, r, at(r.start));
        if (!b) continue;
        insert(
          "pump_log",
          [
            "id",
            "family_id",
            "baby_id",
            "caretaker_id",
            "time",
            "side",
            "amount_ml",
            "duration_min",
            "notes",
            "created_at",
          ],
          [
            ...b,
            "NULL",
            toMl(num(r.amount)) ?? "NULL",
            durationMin(r.duration, r.start, r.end) ?? "NULL",
            escOrNull(notes(r.notes, tagsNote(r))),
            now,
          ],
        );
        break;
      }
      case "note": {
        const b = base(model, r, at(r.time));
        if (!b) continue;
        if (!String(r.note ?? "").trim()) {
          skip("empty note");
          continue;
        }
        insert(
          "note_log",
          [
            "id",
            "family_id",
            "baby_id",
            "caretaker_id",
            "time",
            "content",
            "notes",
            "created_at",
          ],
          [...b, esc(String(r.note).trim()), escOrNull(tagsNote(r)), now],
        );
        break;
      }
      case "tummytime": {
        const b = base(model, r, at(r.start));
        if (!b) continue;
        insert(
          "play_log",
          [
            "id",
            "family_id",
            "baby_id",
            "caretaker_id",
            "type",
            "start_time",
            "end_time",
            "notes",
            "created_at",
          ],
          [
            b[0],
            b[1],
            b[2],
            b[3],
            esc("tummy"),
            b[4],
            at(r.end) ?? "NULL",
            escOrNull(notes(r.milestone, tagsNote(r))),
            now,
          ],
        );
        break;
      }
      case "medication": {
        const b = base(model, r, at(r.time));
        if (!b) continue;
        const unit =
          { mg: "mg", ml: "ml", drops: "drops", tablets: "dose" }[
            String(r.dosage_unit ?? "").toLowerCase()
          ] ?? null;
        if (r.dosage_unit && !unit)
          skip(`medicine unit ${r.dosage_unit} kept in notes`);
        insert(
          "medicine_log",
          [
            "id",
            "family_id",
            "baby_id",
            "caretaker_id",
            "time",
            "name",
            "amount",
            "unit",
            "medicine_id",
            "notes",
            "created_at",
          ],
          [
            ...b,
            esc(String(r.name ?? "Medicine").trim() || "Medicine"),
            num(r.dosage) ?? "NULL",
            unit ? esc(unit) : "NULL",
            "NULL",
            escOrNull(
              notes(
                !unit && r.dosage_unit
                  ? `${r.dosage ?? ""} ${r.dosage_unit}`.trim()
                  : null,
                r.next_dose_interval
                  ? `next dose after ${r.next_dose_interval}`
                  : null,
                r.notes,
                tagsNote(r),
              ),
            ),
            now,
          ],
        );
        break;
      }
      case "bmi":
        skip("BMI rows (derived from weight and height)");
        break;
    }
  }
}

w.finish(outPath);
