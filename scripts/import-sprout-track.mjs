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
//      wrangler d1 execute pjokk-eu --local  --file .import.sql
//      wrangler d1 execute pjokk-eu --remote --file .import.sql
//
// Idempotent: rows get deterministic ids (st-<sproutId>) and INSERT OR
// IGNORE, so re-running never duplicates. Soft-deleted sprout rows are
// skipped. Units are normalized to Pjokk's (ml, kg, cm) — including sprout's
// imperial defaults (OZ bottles, TBSP solids). Because it is INSERT OR
// IGNORE, fixing a mapping and re-running does NOT update rows already
// imported: delete the st-% rows first.
//
// Imported: feeds, diapers, sleep, notes, milestones, pumps, baths,
// measurements, medicine, play, vaccines, contacts, calendar events.
//
// NOT imported, because Pjokk has no equivalent:
//   MoodLog, PlayLog activities beyond the three Pjokk types (folded into
//   notes), FoodLog/Food/BabyAllergen (solids tracker),
//   BreastMilkAdjustment (freezer inventory), Photo/PhotoLog, Settings,
//   and VaccineDocument files (sprout stores them encrypted on its own
//   disk, outside the SQLite file this script reads — re-attach by hand).
//
// Lossy on purpose, preserved in `notes` rather than dropped:
//   feed bottleType / reaction fields / breastMilkAmount, diaper
//   condition / colour / blowout / cream, sleep NAP-vs-NIGHT and quality,
//   milestone category, bath type. A DRY diaper becomes a note ("Dry nappy
//   check") rather than a wet one, so wet-nappy counts stay true.
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
// --caretaker accepts sprout caretaker NAME or ID on the left.
const caretakerByKey = new Map(
  flagAll("caretaker").map((p) => {
    const i = p.lastIndexOf("=");
    return [p.slice(0, i), p.slice(i + 1)];
  }),
);
if (!familyId || babyMap.size === 0) {
  console.error(
    "--family and at least one --baby mapping are required (run --inspect first)",
  );
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
  if (!caretakerId)
    return skip("unmapped caretaker (set --default-caretaker)"), null;
  if (timeMs === null) return skip("unparseable time"), null;
  return [
    esc(`st-${r.id}`),
    esc(familyId),
    esc(babyId),
    esc(caretakerId),
    timeMs,
  ];
};

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
  };
  const type = map[r.type];
  if (!type) {
    skip(`measurement type ${r.type}`);
    continue;
  }
  const value =
    type === "weight" ? toKg(r.value, r.unit) : toCm(r.value, r.unit);
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
const PJOKK_UNITS = new Set(["ml", "mg", "drops", "dose"]);
for (const r of rows(`SELECT * FROM MedicineLog WHERE deletedAt IS NULL`)) {
  const b = base(r, ms(r.time));
  if (!b) continue;
  const unit = String(r.unitAbbr ?? "").toLowerCase();
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
      PJOKK_UNITS.has(unit) ? esc(unit) : "NULL",
      escOrNull(r.notes),
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
// dropped by INSERT OR IGNORE rather than failing the import.
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
  const createdBy = resolveCaretaker(null);
  if (!createdBy) {
    skip("calendar event (set --default-caretaker)");
    continue;
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
      esc(familyId),
      esc(createdBy),
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
      esc(familyId),
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

writeFileSync(".import.sql", out.join("\n") + "\n");
console.log(`wrote .import.sql (${out.length} inserts)`);
if (Object.keys(skipped).length) {
  console.log("skipped:");
  for (const [why, n] of Object.entries(skipped))
    console.log(`  ${n} × ${why}`);
}
