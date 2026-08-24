// One-off importer: sprout-track SQLite database → Pjokk D1.
//
// 1) Inspect the source db to find ids and caretaker names:
//      node scripts/import-sprout-track.mjs sprout.db --inspect
//
// 2) Generate SQL (writes .import.sql), mapping sprout entities to Pjokk:
//      node scripts/import-sprout-track.mjs sprout.db \
//        --family fam_pjokk_test \
//        --baby <sproutBabyId>=baby_nora \
//        --caretaker "Anders"=user_anders --caretaker "Kristine"=user_kristine \
//        --default-caretaker user_anders
//
// 3) Apply (test locally first, then remote):
//      wrangler d1 execute pjokk --local  --file .import.sql
//      wrangler d1 execute pjokk --remote --file .import.sql
//
// Idempotent: rows get deterministic ids (st-<sproutId>) and INSERT OR
// IGNORE, so re-running never duplicates. Soft-deleted sprout rows are
// skipped. Units are normalized to Pjokk's (ml, kg, cm).
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const dbPath = args.find((a) => !a.startsWith("--"));
if (!dbPath) {
  console.error("usage: node scripts/import-sprout-track.mjs <sprout.db> [--inspect|--family ... --baby a=b --caretaker name=id]");
  process.exit(1);
}
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flagAll = (name) =>
  args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = (sql) => db.prepare(sql).all();

// Prisma/SQLite DateTime can be epoch-ms or an ISO-ish string.
const ms = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Math.round(v);
  const s = String(v);
  // "YYYY-MM-DD HH:MM:SS(.mmm)" without zone = UTC in sprout-track.
  const normalized = /^\d{4}-\d{2}-\d{2} /.test(s)
    ? s.replace(" ", "T") + "Z"
    : s;
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? null : t;
};
const esc = (s) => `'${String(s).replaceAll("'", "''")}'`;
const escOrNull = (s) => (s === null || s === undefined || s === "" ? "NULL" : esc(s));

if (args.includes("--inspect")) {
  console.log("== Babies ==");
  for (const b of rows(`SELECT id, firstName, lastName, birthDate, gender FROM Baby WHERE deletedAt IS NULL`))
    console.log(`  ${b.id}  ${b.firstName} ${b.lastName}  born ${b.birthDate}  ${b.gender ?? ""}`);
  console.log("== Caretakers ==");
  for (const c of rows(`SELECT id, name, type FROM Caretaker WHERE deletedAt IS NULL`))
    console.log(`  ${c.id}  "${c.name}"  ${c.type ?? ""}`);
  const count = (t) => rows(`SELECT count(*) AS n FROM ${t} WHERE deletedAt IS NULL`)[0].n;
  for (const t of ["FeedLog", "DiaperLog", "SleepLog", "Note", "Milestone", "PumpLog", "BathLog", "Measurement", "MedicineLog"])
    console.log(`${t}: ${count(t)} rows`);
  process.exit(0);
}

const familyId = flag("family");
const babyMap = new Map(flagAll("baby").map((p) => p.split("=")));
const defaultCaretaker = flag("default-caretaker");
// --caretaker accepts sprout caretaker NAME or ID on the left.
const caretakerByKey = new Map(flagAll("caretaker").map((p) => {
  const i = p.lastIndexOf("=");
  return [p.slice(0, i), p.slice(i + 1)];
}));
if (!familyId || babyMap.size === 0) {
  console.error("--family and at least one --baby mapping are required (run --inspect first)");
  process.exit(1);
}

const caretakers = new Map(
  rows(`SELECT id, name FROM Caretaker`).map((c) => [c.id, c.name]),
);
const resolveCaretaker = (sproutCaretakerId) => {
  if (sproutCaretakerId) {
    const byId = caretakerByKey.get(sproutCaretakerId);
    if (byId) return byId;
    const byName = caretakerByKey.get(caretakers.get(sproutCaretakerId) ?? "");
    if (byName) return byName;
  }
  return defaultCaretaker ?? null;
};

// Unit conversions → ml / kg / cm.
const toMl = (amount, unit) => {
  if (amount === null || amount === undefined) return null;
  const u = String(unit ?? "ml").toLowerCase();
  if (u === "oz" || u === "fl oz") return Math.round(amount * 29.5735);
  return Math.round(amount);
};
const toKg = (v, unit) => {
  const u = String(unit ?? "kg").toLowerCase();
  if (u === "lb" || u === "lbs") return v * 0.453592;
  if (u === "g") return v / 1000;
  return v;
};
const toCm = (v, unit) =>
  String(unit ?? "cm").toLowerCase() === "in" ? v * 2.54 : v;

const out = [];
const skipped = {};
const skip = (why) => (skipped[why] = (skipped[why] ?? 0) + 1);
const now = Date.now();

const insert = (table, cols, vals) =>
  out.push(
    `INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${vals.join(", ")});`,
  );

const base = (r, timeMs) => {
  const babyId = babyMap.get(r.babyId);
  const caretakerId = resolveCaretaker(r.caretakerId);
  if (!babyId) return skip("unmapped baby"), null;
  if (!caretakerId) return skip("unmapped caretaker (set --default-caretaker)"), null;
  if (timeMs === null) return skip("unparseable time"), null;
  return [esc(`st-${r.id}`), esc(familyId), esc(babyId), esc(caretakerId), timeMs];
};

for (const r of rows(`SELECT * FROM FeedLog WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.time));
  if (!b) continue;
  const type = { BREAST: "breast", BOTTLE: "bottle", SOLIDS: "solids" }[r.type];
  if (!type) { skip(`feed type ${r.type}`); continue; }
  const durationMin =
    r.feedDuration != null
      ? Math.round(r.feedDuration / 60)
      : r.startTime && r.endTime
        ? Math.round((ms(r.endTime) - ms(r.startTime)) / 60000)
        : null;
  const notes = [r.food, r.notes].filter(Boolean).join(" · ") || null;
  insert(
    "feed_log",
    ["id", "family_id", "baby_id", "caretaker_id", "time", "type", "amount_ml", "side", "duration_min", "notes", "created_at"],
    [...b, esc(type),
      type === "breast" ? "NULL" : (toMl(r.amount, r.unitAbbr) ?? "NULL"),
      r.side ? esc(r.side.toLowerCase()) : "NULL",
      type === "breast" ? (durationMin ?? "NULL") : "NULL",
      escOrNull(notes), now],
  );
}

for (const r of rows(`SELECT * FROM DiaperLog WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.time));
  if (!b) continue;
  const type = { WET: "wet", DIRTY: "dirty", BOTH: "both" }[r.type];
  if (!type) { skip(`diaper type ${r.type} (DRY has no Pjokk equivalent)`); continue; }
  insert(
    "diaper_log",
    ["id", "family_id", "baby_id", "caretaker_id", "time", "type", "notes", "created_at"],
    [...b, esc(type), escOrNull(r.notes), now],
  );
}

for (const r of rows(`SELECT * FROM SleepLog WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.startTime));
  if (!b) continue;
  const [id, fam, babyId, caretakerId, startMs] = b;
  insert(
    "sleep_log",
    ["id", "family_id", "baby_id", "caretaker_id", "start_time", "end_time", "location", "notes", "created_at"],
    [id, fam, babyId, caretakerId, startMs, ms(r.endTime) ?? "NULL",
      escOrNull(r.location?.toLowerCase()), escOrNull(r.notes), now],
  );
}

for (const r of rows(`SELECT * FROM Note WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.time));
  if (!b) continue;
  insert(
    "note_log",
    ["id", "family_id", "baby_id", "caretaker_id", "time", "content", "notes", "created_at"],
    [...b, esc(r.content ?? ""), escOrNull(r.category), now],
  );
}

for (const r of rows(`SELECT * FROM Milestone WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.date));
  if (!b) continue;
  insert(
    "milestone_log",
    ["id", "family_id", "baby_id", "caretaker_id", "time", "title", "notes", "created_at"],
    [...b, esc(r.title ?? ""), escOrNull(r.description), now],
  );
}

for (const r of rows(`SELECT * FROM PumpLog WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.startTime));
  if (!b) continue;
  const total = r.totalAmount ?? ((r.leftAmount ?? 0) + (r.rightAmount ?? 0) || null);
  const side = r.leftAmount && r.rightAmount ? "both" : r.leftAmount ? "left" : r.rightAmount ? "right" : null;
  insert(
    "pump_log",
    ["id", "family_id", "baby_id", "caretaker_id", "time", "side", "amount_ml", "duration_min", "notes", "created_at"],
    [...b, side ? esc(side) : "NULL", total != null ? toMl(total, r.unitAbbr) : "NULL",
      r.duration ?? "NULL", escOrNull(r.notes), now],
  );
}

for (const r of rows(`SELECT * FROM BathLog WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.time));
  if (!b) continue;
  const notes = [r.bathType, r.notes].filter(Boolean).join(" · ") || null;
  insert(
    "bath_log",
    ["id", "family_id", "baby_id", "caretaker_id", "time", "notes", "created_at"],
    [...b, escOrNull(notes), now],
  );
}

for (const r of rows(`SELECT * FROM Measurement WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.date));
  if (!b) continue;
  const map = { WEIGHT: "weight", HEIGHT: "length", HEAD_CIRCUMFERENCE: "head" };
  const type = map[r.type];
  if (!type) { skip(`measurement type ${r.type}`); continue; }
  const value = type === "weight" ? toKg(r.value, r.unit) : toCm(r.value, r.unit);
  insert(
    "measurement_log",
    ["id", "family_id", "baby_id", "caretaker_id", "time", "type", "value", "notes", "created_at"],
    [...b, esc(type), Math.round(value * 100) / 100, escOrNull(r.notes), now],
  );
}

const medicineNames = new Map(rows(`SELECT id, name FROM Medicine`).map((m) => [m.id, m.name]));
const PJOKK_UNITS = new Set(["ml", "mg", "drops", "dose"]);
for (const r of rows(`SELECT * FROM MedicineLog WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.time));
  if (!b) continue;
  const unit = String(r.unitAbbr ?? "").toLowerCase();
  insert(
    "medicine_log",
    ["id", "family_id", "baby_id", "caretaker_id", "time", "name", "amount", "unit", "notes", "created_at"],
    [...b, esc(medicineNames.get(r.medicineId) ?? "Medicine"), r.doseAmount ?? "NULL",
      PJOKK_UNITS.has(unit) ? esc(unit) : "NULL", escOrNull(r.notes), now],
  );
}

writeFileSync(".import.sql", out.join("\n") + "\n");
console.log(`wrote .import.sql (${out.length} inserts)`);
if (Object.keys(skipped).length) {
  console.log("skipped:");
  for (const [why, n] of Object.entries(skipped)) console.log(`  ${n} × ${why}`);
}
