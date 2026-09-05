// One-off importer: sprout-track SQLite database → Pjokk (Postgres).
//
// 1) Inspect the source db to find ids and caretaker names:
//      node scripts/import-sprout-track.mjs sprout.db --inspect
//
// 2) Generate SQL, mapping sprout entities to Pjokk. Either name the target
//    ids yourself:
//      node scripts/import-sprout-track.mjs sprout.db \
//        --family fam_pjokk_test \
//        --baby <sproutBabyId>=baby_nora \
//        --caretaker "Anders"=user_anders --caretaker "Kristine"=user_kristine \
//        --default-caretaker user_anders
//
//    …or let the SQL resolve them at APPLY time from one account, which is
//    the right shape when sprout recorded a single caretaker (or its
//    "system" one) and saves querying production for two uuids first:
//      node scripts/import-sprout-track.mjs sprout.db \
//        --resolve-by-email you@example.com --create-babies \
//        --out pjokk-import.sql
//
//    --resolve-by-email looks the family up through organization_members and
//    ABORTS the transaction unless it matches exactly one (user, family):
//    importing four thousand rows into the wrong family is not a typo you
//    can undo. --create-babies creates each sprout baby under a st- id
//    instead of needing a --baby mapping. --out defaults to .import.sql.
//
// 3) Apply (review the SQL first — it is a one-off against real data):
//      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f pjokk-import.sql
//
// Idempotent: rows get deterministic ids (st-<sproutId>) and ON CONFLICT DO
// NOTHING, so re-running never duplicates. Soft-deleted sprout rows are
// skipped. Units are normalized to Pjokk's (ml, kg, cm) — including sprout's
// imperial defaults (OZ bottles, TBSP solids). Because conflicts are ignored,
// fixing a mapping and re-running does NOT update rows already imported:
// delete the st-% rows first.
//
// Imported: feeds (incl. FoodLog as `solids`), diapers, sleep, notes,
// milestones, pumps, baths, measurements, medicine, play, vaccines,
// contacts, calendar events.
//
// FoodLog is sprout's separate solids tracker. Pjokk has no solids screen —
// it has a `solids` FEED type whose amount_ml is RENDERED AS GRAMS (see
// FeedSheet unit="g" and the summary's solidsG), which is what those rows
// hold, so they import as feeds. The amount is taken as grams whatever
// sprout's unit said: G and ML are grams-ish for puree, and converting a
// TBSP row (12 tbsp = 177 g) would make a baby's first taste of solids the
// largest meal of her first two months. The summary counts every row whose
// unit was reinterpreted this way.
//
// NOT imported, because Pjokk has no equivalent:
//   MoodLog, PlayLog activities beyond the three Pjokk types (folded into
//   notes), BabyAllergen,
//   BreastMilkAdjustment (freezer inventory), Photo/PhotoLog, Settings,
//   and VaccineDocument files (sprout stores them encrypted on its own
//   disk, outside the SQLite file this script reads — re-attach by hand).
//
// Lossy on purpose, preserved in `notes` rather than dropped:
//   feed bottleType / reaction fields / breastMilkAmount, diaper
//   condition / colour / blowout / cream, sleep NAP-vs-NIGHT and quality,
//   milestone category, bath type. A DRY diaper becomes a note ("Dry nappy
//   check") rather than a wet one, so wet-nappy counts stay true.
//   sprout's medicine units are singular (DROP, PILL)
//   where Pjokk's enum is plural, so they are mapped by name rather than by
//   identity — matching them exactly used to drop the unit off every
//   Vitamin D dose — and a dose whose unit has no Pjokk equivalent keeps
//   its amount and carries the unit in notes.
//   Recurring calendar events import as their FIRST occurrence only.
//   A breastfeed recorded as two sided rows in sprout stays two rows here.
//
// The summary printed at the end lists everything skipped, and why.
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const dbPath = args.find((a) => !a.startsWith("--"));
if (!dbPath) {
  console.error(
    "usage: node scripts/import-sprout-track.mjs <sprout.db> [--inspect|--family ... --baby a=b --caretaker name=id]",
  );
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
const escOrNull = (s) =>
  s === null || s === undefined || s === "" ? "NULL" : esc(s);

if (args.includes("--inspect")) {
  console.log("== Babies ==");
  for (const b of rows(
    `SELECT id, firstName, lastName, birthDate, gender FROM Baby WHERE deletedAt IS NULL`,
  ))
    console.log(
      `  ${b.id}  ${b.firstName} ${b.lastName}  born ${b.birthDate}  ${b.gender ?? ""}`,
    );
  console.log("== Caretakers ==");
  for (const c of rows(
    `SELECT id, name, type FROM Caretaker WHERE deletedAt IS NULL`,
  ))
    console.log(`  ${c.id}  "${c.name}"  ${c.type ?? ""}`);
  const count = (t) =>
    rows(`SELECT count(*) AS n FROM ${t} WHERE deletedAt IS NULL`)[0].n;
  for (const t of [
    "FeedLog",
    "DiaperLog",
    "SleepLog",
    "Note",
    "Milestone",
    "PumpLog",
    "BathLog",
    "Measurement",
    "MedicineLog",
    "Contact",
    "PlayLog",
    "VaccineLog",
    "CalendarEvent",
  ])
    console.log(`${t}: ${count(t)} rows`);
  process.exit(0);
}

const familyId = flag("family");
const babyMap = new Map(flagAll("baby").map((p) => p.split("=")));
const defaultCaretaker = flag("default-caretaker");
const outPath = flag("out") ?? ".import.sql";
// --resolve-by-email emits SQL that looks the family and the caretaker up at
// APPLY time instead of baking ids in, so the file can be reviewed and run
// without first querying production for two uuids. Everything is attributed
// to that one account, which is right when sprout recorded a single
// caretaker (or the "system" one) and wrong otherwise -- hence the warning.
const resolveEmail = flag("resolve-by-email");
const createBabies = args.includes("--create-babies");
// --caretaker accepts sprout caretaker NAME or ID on the left.
const caretakerByKey = new Map(
  flagAll("caretaker").map((p) => {
    const i = p.lastIndexOf("=");
    return [p.slice(0, i), p.slice(i + 1)];
  }),
);
// Babies are created by the generated SQL under deterministic st- ids, which
// also registers the mapping --baby would otherwise have to supply by hand.
const sproutBabies = createBabies
  ? rows(
      `SELECT id, firstName, lastName, birthDate, gender FROM Baby WHERE deletedAt IS NULL`,
    )
  : [];
for (const b of sproutBabies) babyMap.set(b.id, `st-${b.id}`);

if (!resolveEmail && !familyId) {
  console.error("--family (or --resolve-by-email) is required");
  process.exit(1);
}
if (babyMap.size === 0) {
  console.error(
    "at least one --baby mapping (or --create-babies) is required (run --inspect first)",
  );
  process.exit(1);
}
if (resolveEmail && (caretakerByKey.size > 0 || defaultCaretaker))
  console.warn(
    "warning: --resolve-by-email attributes every row to one account; --caretaker/--default-caretaker are ignored",
  );

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

// Unit conversions → ml / kg / cm. sprout's defaults are imperial (OZ for
// bottles, TBSP for solids), so anything unconverted here silently imports
// as the wrong number.
const ML_PER = { oz: 29.5735, "fl oz": 29.5735, tbsp: 14.7868, tsp: 4.92892 };
const toMl = (amount, unit) => {
  if (amount === null || amount === undefined) return null;
  const u = String(unit ?? "ml").toLowerCase();
  const factor = ML_PER[u];
  if (factor) return Math.round(amount * factor);
  if (u !== "ml" && u !== "g") skip(`unknown amount unit "${u}" taken as ml`);
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
// Pjokk stores every temperature in its canonical unit, °C, the way it stores
// weight in kg — there is no unit column. sprout's Unit table has both C and
// F, so a Fahrenheit row must convert here rather than land as a 100 °C baby.
const toCelsius = (v, unit) => {
  const u = String(unit ?? "c")
    .toLowerCase()
    .replace("\u00b0", "");
  return u === "f" ? ((v - 32) * 5) / 9 : v;
};

const out = [];
const skipped = {};
const skip = (why) => (skipped[why] = (skipped[why] ?? 0) + 1);
const now = Date.now();

// Postgres columns are typed, unlike SQLite's, so values are rendered by
// column name at this single boundary rather than at each of the ~20 call
// sites: timestamps are timestamptz (an epoch-ms integer is not accepted)
// and flags are real booleans (1/0 is not accepted either).
const TIMESTAMP_COLS = new Set([
  "time",
  "start_time",
  "end_time",
  "birth_date",
  "created_at",
  "reminded_at",
  "expires_at",
  "last_used_at",
  "revoked_at",
  "last_reminded_at",
]);
const BOOLEAN_COLS = new Set(["all_day", "read_only", "email_verified"]);

const at = (msValue) => `'${new Date(msValue).toISOString()}'`;

const render = (col, v) => {
  if (v === "NULL" || v === null || v === undefined) return "NULL";
  if (TIMESTAMP_COLS.has(col) && typeof v === "number") return at(v);
  if (BOOLEAN_COLS.has(col)) return v && v !== "0" ? "true" : "false";
  return v;
};

const insert = (table, cols, vals) => {
  const exprs = cols.map((col, i) => render(col, vals[i])).join(", ");
  const head = `INSERT INTO "${table}" (${cols.join(", ")})`;
  // In resolve mode family_id/caretaker_id are bare column references into the
  // single-row _import_target, so the statement is a SELECT rather than VALUES.
  out.push(
    resolveEmail
      ? `${head} SELECT ${exprs} FROM _import_target ON CONFLICT DO NOTHING;`
      : `${head} VALUES (${exprs}) ON CONFLICT DO NOTHING;`,
  );
};

const FAMILY_REF = "family_id";
const CARETAKER_REF = "caretaker_id";
const familyExpr = () => (resolveEmail ? FAMILY_REF : esc(familyId));

const base = (r, timeMs) => {
  const babyId = babyMap.get(r.babyId);
  if (!babyId) return skip("unmapped baby"), null;
  let caretakerExpr = CARETAKER_REF;
  if (!resolveEmail) {
    const caretakerId = resolveCaretaker(r.caretakerId);
    if (!caretakerId)
      return skip("unmapped caretaker (set --default-caretaker)"), null;
    caretakerExpr = esc(caretakerId);
  }
  if (timeMs === null) return skip("unparseable time"), null;
  return [esc(`st-${r.id}`), familyExpr(), esc(babyId), caretakerExpr, timeMs];
};

// The prelude: resolve the target, then create the babies. Both must precede
// every log insert, so they are emitted before the per-table loops run.
if (resolveEmail) {
  out.push(
    "BEGIN;",
    "",
    "-- Resolve the family and the caretaker from one account, rather than",
    "-- baking ids in. A missing or ambiguous match aborts the transaction:",
    "-- importing 4000 rows into the wrong family is not a recoverable typo.",
    "CREATE TEMP TABLE _import_target ON COMMIT DROP AS",
    "SELECT u.id AS caretaker_id, o.id AS family_id",
    'FROM "users" u',
    'JOIN "organization_members" m ON m.user_id = u.id',
    'JOIN "organizations" o ON o.id = m.organization_id',
    `WHERE u.email = ${esc(resolveEmail)} AND u.deleted_at IS NULL;`,
    "",
    "DO $$",
    "DECLARE n int;",
    "BEGIN",
    "  SELECT count(*) INTO n FROM _import_target;",
    "  IF n <> 1 THEN",
    `    RAISE EXCEPTION 'expected exactly one (user, family) for ${resolveEmail}, found %', n;`,
    "  END IF;",
    "END $$;",
    "",
  );
}
for (const b of sproutBabies) {
  const name = [b.firstName, b.lastName].filter(Boolean).join(" ") || "Baby";
  const sex = { FEMALE: "girl", MALE: "boy" }[b.gender];
  insert(
    "baby",
    ["id", "family_id", "name", "birth_date", "sex"],
    [
      esc(`st-${b.id}`),
      familyExpr(),
      esc(name),
      ms(b.birthDate),
      sex ? esc(sex) : "NULL",
    ],
  );
}
if (sproutBabies.length) out.push("");

for (const r of rows(`SELECT * FROM FeedLog WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.time));
  if (!b) continue;
  const type = { BREAST: "breast", BOTTLE: "bottle", SOLIDS: "solids" }[r.type];
  if (!type) {
    skip(`feed type ${r.type}`);
    continue;
  }
  const durationMin =
    r.feedDuration != null
      ? Math.round(r.feedDuration / 60)
      : r.startTime && r.endTime
        ? Math.round((ms(r.endTime) - ms(r.startTime)) / 60000)
        : null;
  // bottleType (formula vs breast milk), reaction flags and breastMilkAmount
  // have no Pjokk column; they are real clinical detail, so they ride along
  // in notes rather than vanishing.
  const notes =
    [
      r.food,
      r.bottleType,
      r.breastMilkAmount ? `${r.breastMilkAmount} breast milk` : null,
      r.hadReaction
        ? `reaction${r.reactionDescription ? `: ${r.reactionDescription}` : ""}${r.reactionCause ? ` (${r.reactionCause})` : ""}`
        : null,
      r.notes,
    ]
      .filter(Boolean)
      .join(" · ") || null;
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
      "notes",
      "created_at",
    ],
    [
      ...b,
      esc(type),
      type === "breast" ? "NULL" : (toMl(r.amount, r.unitAbbr) ?? "NULL"),
      r.side ? esc(r.side.toLowerCase()) : "NULL",
      type === "breast" ? (durationMin ?? "NULL") : "NULL",
      escOrNull(notes),
      now,
    ],
  );
}

// FoodLog is sprout's solids tracker, a table apart from FeedLog. Pjokk has
// no separate solids screen -- it has a `solids` FEED type whose amount_ml is
// rendered as GRAMS (FeedSheet unit="g", summary solidsG), which is exactly
// what these rows hold. They used to be dropped wholesale; a row here is a
// meal, and 150 of them is half a year of weaning.
const foodNames = new Map(
  rows(`SELECT id, name FROM Food`).map((f) => [f.id, String(f.name).trim()]),
);
for (const r of rows(`SELECT * FROM FoodLog WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.time));
  if (!b) continue;
  // `foods` is a JSON array; `foodId` is the single-food shorthand.
  let foodIds = [];
  try {
    foodIds = JSON.parse(r.foods ?? "[]")
      .map((f) => f?.foodId)
      .filter(Boolean);
  } catch {
    // Malformed JSON just falls through to foodId below.
  }
  if (!foodIds.length && r.foodId) foodIds = [r.foodId];
  const foodUnit = String(r.unitAbbr ?? "").toLowerCase();
  if (r.amount != null && foodUnit && foodUnit !== "g")
    skip(`solids amount in ${r.unitAbbr} taken as grams`);
  const names = foodIds.map((i) => foodNames.get(i)).filter(Boolean);
  const notes =
    [
      names.join(", ") || null,
      r.enjoyment ? String(r.enjoyment).toLowerCase() : null,
      r.hadReaction
        ? `reaction${r.reactionDescription ? `: ${r.reactionDescription}` : ""}`
        : null,
      r.notes,
    ]
      .filter(Boolean)
      .join(" \u00b7 ") || null;
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
      "notes",
      "created_at",
    ],
    [
      ...b,
      esc("solids"),
      // The amount is taken as GRAMS whatever the unit says. G and ML are
      // grams-ish for puree either way, and converting the handful of early
      // TBSP rows (12 tbsp = 177 g) would make a baby's first taste of solids
      // the largest meal of her first two months -- the number was recorded
      // against sprout's default unit label, not actually measured in spoons.
      r.amount != null ? Math.round(r.amount) : "NULL",
      "NULL",
      "NULL",
      escOrNull(notes),
      now,
    ],
  );
}

for (const r of rows(`SELECT * FROM DiaperLog WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.time));
  if (!b) continue;
  const diaperNotes =
    [
      r.condition,
      r.color,
      r.blowout ? "blowout" : null,
      r.creamApplied ? "cream applied" : null,
      r.notes,
    ]
      .filter(Boolean)
      .join(" · ") || null;
  // Pjokk has no DRY type, and calling a dry check "wet" would inflate every
  // wet-nappy count forever. Keep the record as a note instead: the event
  // survives, the diaper statistics stay true.
  if (r.type === "DRY") {
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
      [...b, esc("Dry nappy check"), escOrNull(diaperNotes), now],
    );
    skip("DRY diaper imported as a note (no Pjokk diaper type fits)");
    continue;
  }
  const type = { WET: "wet", DIRTY: "dirty", BOTH: "both" }[r.type];
  if (!type) {
    skip(`diaper type ${r.type}`);
    continue;
  }
  insert(
    "diaper_log",
    [
      "id",
      "family_id",
      "baby_id",
      "caretaker_id",
      "time",
      "type",
      "notes",
      "created_at",
    ],
    [...b, esc(type), escOrNull(diaperNotes), now],
  );
}

for (const r of rows(`SELECT * FROM SleepLog WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.startTime));
  if (!b) continue;
  const [id, fam, babyId, caretakerId, startMs] = b;
  // Pjokk has no nap/night split and no sleep quality; both would otherwise
  // be dropped silently, so they ride along in notes.
  const sleepNotes =
    [
      r.type === "NAP" ? "nap" : r.type === "NIGHT_SLEEP" ? "night sleep" : null,
      r.quality ? `quality: ${String(r.quality).toLowerCase()}` : null,
      r.notes,
    ]
      .filter(Boolean)
      .join(" · ") || null;
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
      "notes",
      "created_at",
    ],
    [
      id,
      fam,
      babyId,
      caretakerId,
      startMs,
      ms(r.endTime) ?? "NULL",
      // Not lowercased: the value is shown as-is and sits beside the
      // family's own sleep-location chips, which are capitalized.
      escOrNull(r.location),
      escOrNull(sleepNotes),
      now,
    ],
  );
}

for (const r of rows(`SELECT * FROM Note WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.time));
  if (!b) continue;
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
    [...b, esc(r.content ?? ""), escOrNull(r.category), now],
  );
}

for (const r of rows(`SELECT * FROM Milestone WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.date));
  if (!b) continue;
  insert(
    "milestone_log",
    [
      "id",
      "family_id",
      "baby_id",
      "caretaker_id",
      "time",
      "title",
      "notes",
      "created_at",
    ],
    [...b, esc(r.title ?? ""), escOrNull(r.description), now],
  );
}

for (const r of rows(`SELECT * FROM PumpLog WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.startTime));
  if (!b) continue;
  const total =
    r.totalAmount ?? ((r.leftAmount ?? 0) + (r.rightAmount ?? 0) || null);
  const side =
    r.leftAmount && r.rightAmount
      ? "both"
      : r.leftAmount
        ? "left"
        : r.rightAmount
          ? "right"
          : null;
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
      side ? esc(side) : "NULL",
      total != null ? toMl(total, r.unitAbbr) : "NULL",
      r.duration ?? "NULL",
      escOrNull(r.notes),
      now,
    ],
  );
}

for (const r of rows(`SELECT * FROM BathLog WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.time));
  if (!b) continue;
  const notes = [r.bathType, r.notes].filter(Boolean).join(" · ") || null;
  insert(
    "bath_log",
    [
      "id",
      "family_id",
      "baby_id",
      "caretaker_id",
      "time",
      "notes",
      "created_at",
    ],
    [...b, escOrNull(notes), now],
  );
}

for (const r of rows(`SELECT * FROM Measurement WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.date));
  if (!b) continue;
  const map = {
    WEIGHT: "weight",
    HEIGHT: "length",
    HEAD_CIRCUMFERENCE: "head",
    TEMPERATURE: "temperature",
  };
  const type = map[r.type];
  if (!type) {
    skip(`measurement type ${r.type}`);
    continue;
  }
  const value =
    type === "weight"
      ? toKg(r.value, r.unit)
      : type === "temperature"
        ? toCelsius(r.value, r.unit)
        : toCm(r.value, r.unit);
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
    [...b, esc(type), Math.round(value * 100) / 100, escOrNull(r.notes), now],
  );
}

const medicineNames = new Map(
  rows(`SELECT id, name FROM Medicine`).map((m) => [m.id, m.name]),
);
// sprout's unit vocabulary is singular (DROP, PILL); Pjokk's enum is
// ("ml","mg","drops","dose"). Matching them by identity silently dropped the
// unit off every Vitamin D dose, so map explicitly and keep what will not fit
// in the notes rather than losing the dose entirely.
const MEDICINE_UNIT = {
  drop: "drops",
  drops: "drops",
  dose: "dose",
  ml: "ml",
  mg: "mg",
};
for (const r of rows(`SELECT * FROM MedicineLog WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.time));
  if (!b) continue;
  const unit = String(r.unitAbbr ?? "").toLowerCase();
  const mappedUnit = MEDICINE_UNIT[unit] ?? null;
  if (unit && !mappedUnit)
    skip(`medicine unit ${r.unitAbbr} kept in notes (no Pjokk unit fits)`);
  const medicineNotes =
    [
      !mappedUnit && unit
        ? `${r.doseAmount ?? ""} ${unit}`.trim()
        : null,
      r.notes,
    ]
      .filter(Boolean)
      .join(" \u00b7 ") || null;
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
      "notes",
      "created_at",
    ],
    [
      ...b,
      esc(medicineNames.get(r.medicineId) ?? "Medicine"),
      r.doseAmount ?? "NULL",
      mappedUnit ? esc(mappedUnit) : "NULL",
      escOrNull(medicineNotes),
      now,
    ],
  );
}

// Vaccines. Documents are NOT imported: sprout stores them encrypted on its
// own disk (VaccineDocument.storedName), so the bytes are not reachable from
// the SQLite file this script reads. Re-attach them by hand afterwards.
// scheduleSlot stays NULL — the Vaccines screen matches a logged dose to the
// programme by name + dose number anyway.
for (const r of rows(`SELECT * FROM VaccineLog WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.time));
  if (!b) continue;
  insert(
    "vaccine_log",
    [
      "id",
      "family_id",
      "baby_id",
      "caretaker_id",
      "time",
      "name",
      "dose_number",
      "schedule_slot",
      "notes",
      "created_at",
    ],
    [
      ...b,
      esc(r.vaccineName ?? "Vaccine"),
      r.doseNumber ?? "NULL",
      "NULL",
      escOrNull(r.notes),
      now,
    ],
  );
}
// Counted individually so the summary reads "N × vaccine document …".
const vaccineDocs = rows(`SELECT count(*) AS n FROM VaccineDocument`)[0].n;
for (let i = 0; i < vaccineDocs; i++) {
  skip("vaccine document (the file lives outside the db)");
}

// Play. sprout has five PlayTypes; Pjokk has three, so the two indoor/
// outdoor variants and CUSTOM collapse into "play" with the original type
// preserved in notes. A row with no endTime imports as a RUNNING session,
// which the partial unique index caps at one per baby — later ones are
// dropped by ON CONFLICT DO NOTHING rather than failing the import.
const PLAY_TYPE = {
  TUMMY_TIME: "tummy",
  WALK: "walk",
  INDOOR_PLAY: "play",
  OUTDOOR_PLAY: "play",
  CUSTOM: "play",
};
for (const r of rows(`SELECT * FROM PlayLog WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.startTime));
  if (!b) continue;
  const [id, fam, babyId, caretakerId, startMs] = b;
  const type = PLAY_TYPE[r.type];
  if (!type) {
    skip(`play type ${r.type}`);
    continue;
  }
  // Keep the distinction the enum loses, plus sprout's free-text activities.
  const original =
    r.type === "INDOOR_PLAY" || r.type === "OUTDOOR_PLAY" || r.type === "CUSTOM"
      ? r.type.toLowerCase().replace("_", " ")
      : null;
  const notes = [original, r.activities, r.notes].filter(Boolean).join(" · ") || null;
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
      id,
      fam,
      babyId,
      caretakerId,
      esc(type),
      startMs,
      ms(r.endTime) ?? "NULL",
      escOrNull(notes),
      now,
    ],
  );
}

// Calendar events. sprout's recurrence has no Pjokk equivalent, so a
// recurring event imports as its FIRST occurrence only, flagged in the
// description — silently importing one row for a weekly series would be
// worse than saying so. Reminders come across as remind_minutes_before with
// remindedAt pre-set for anything already in the past, so the import can
// never fire a burst of notifications for old events.
const CAL_CATEGORY = {
  APPOINTMENT: "doctor",
  CARETAKER_SCHEDULE: "babysitting",
  REMINDER: "other",
  CUSTOM: "other",
};
const eventBabies = new Map();
for (const r of rows(`SELECT * FROM BabyEvent`)) {
  if (!eventBabies.has(r.eventId)) eventBabies.set(r.eventId, []);
  eventBabies.get(r.eventId).push(r.babyId);
}
const eventCaretakers = new Map();
for (const r of rows(`SELECT * FROM CaretakerEvent`)) {
  if (!eventCaretakers.has(r.eventId)) eventCaretakers.set(r.eventId, []);
  eventCaretakers.get(r.eventId).push(r.caretakerId);
}

for (const r of rows(`SELECT * FROM CalendarEvent WHERE deletedAt IS NULL`)) {
  const startMs = ms(r.startTime);
  if (startMs === null) {
    skip("calendar event with unparseable start time");
    continue;
  }
  let createdBy = CARETAKER_REF;
  if (!resolveEmail) {
    const resolved = resolveCaretaker(null);
    if (!resolved) {
      skip("calendar event (set --default-caretaker)");
      continue;
    }
    createdBy = esc(resolved);
  }
  const id = `st-${r.id}`;
  const endMs = ms(r.endTime);
  const durationMin =
    !r.allDay && endMs && endMs > startMs
      ? Math.min(1440, Math.max(5, Math.round((endMs - startMs) / 60000)))
      : null;
  const description =
    [
      r.recurring
        ? `imported from a recurring series (${String(r.recurrencePattern ?? "custom").toLowerCase()}) — first occurrence only`
        : null,
      r.description,
    ]
      .filter(Boolean)
      .join(" · ") || null;
  insert(
    "calendar_event",
    [
      "id",
      "family_id",
      "created_by",
      "title",
      "description",
      "location",
      "category",
      "start_time",
      "all_day",
      "duration_min",
      "remind_minutes_before",
      "reminded_at",
      "created_at",
    ],
    [
      esc(id),
      familyExpr(),
      createdBy,
      esc(r.title ?? "Event"),
      escOrNull(description),
      escOrNull(r.location),
      esc(CAL_CATEGORY[r.type] ?? "other"),
      startMs,
      r.allDay ? 1 : 0,
      durationMin ?? "NULL",
      r.reminderTime ?? "NULL",
      // Latch past reminders shut; future ones stay armed.
      startMs < now ? now : "NULL",
      now,
    ],
  );
  for (const sproutBabyId of new Set(eventBabies.get(r.id) ?? [])) {
    const babyId = babyMap.get(sproutBabyId);
    if (!babyId) continue;
    insert(
      "calendar_event_baby",
      ["event_id", "baby_id"],
      [esc(id), esc(babyId)],
    );
  }
  for (const sproutCaretakerId of new Set(eventCaretakers.get(r.id) ?? [])) {
    if (resolveEmail) {
      insert(
        "calendar_assignee",
        ["event_id", "user_id"],
        [esc(id), CARETAKER_REF],
      );
      continue;
    }
    const userId = resolveCaretaker(sproutCaretakerId);
    // resolveCaretaker falls back to the default, which would silently
    // assign every unmapped caretaker to one person — only take real hits.
    const mapped =
      caretakerByKey.get(sproutCaretakerId) ??
      caretakerByKey.get(caretakers.get(sproutCaretakerId) ?? "");
    if (!mapped || !userId) continue;
    insert(
      "calendar_assignee",
      ["event_id", "user_id"],
      [esc(id), esc(userId)],
    );
  }
}

// Contacts. sprout links contacts to events/medicines/vaccines, never to a
// baby, so every imported contact lands family-wide (zero contact_baby rows)
// — which is the right default for a doctor anyway. `address` has no Pjokk
// column and folds into notes.
const ICON_BY_ROLE = [
  [/doctor|lege|fastlege|gp\b/i, "doctor"],
  [/nurse|helsesykepleier|helsestasjon/i, "nurse"],
  [/hospital|sykehus|clinic|klinikk/i, "hospital"],
  [/dentist|tannlege/i, "dental"],
  [/daycare|barnehage|nursery|kindergarten/i, "daycare"],
];
for (const r of rows(`SELECT * FROM Contact WHERE deletedAt IS NULL`)) {
  const role = r.role ?? "";
  const icon = ICON_BY_ROLE.find(([re]) => re.test(role))?.[1] ?? null;
  const notes = [r.address, r.notes].filter(Boolean).join(" · ") || null;
  insert(
    "contact",
    [
      "id",
      "family_id",
      "name",
      "role",
      "icon",
      "phone",
      "email",
      "website",
      "notes",
      "created_at",
    ],
    [
      esc(`st-${r.id}`),
      familyExpr(),
      esc(r.name ?? "Contact"),
      escOrNull(r.role),
      icon ? esc(icon) : "NULL",
      escOrNull(r.phone),
      escOrNull(r.email),
      // sprout has no website column.
      "NULL",
      escOrNull(notes),
      now,
    ],
  );
}

if (resolveEmail) out.push("", "COMMIT;");
writeFileSync(outPath, out.join("\n") + "\n");
const inserts = out.filter((l) => l.startsWith("INSERT")).length;
console.log(`wrote ${outPath} (${inserts} inserts)`);
if (Object.keys(skipped).length) {
  console.log("skipped:");
  for (const [why, n] of Object.entries(skipped))
    console.log(`  ${n} × ${why}`);
}
