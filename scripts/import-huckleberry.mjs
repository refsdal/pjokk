// One-off importer: Huckleberry CSV export → Pjokk (Postgres). Issue #67.
//
// Huckleberry exports one CSV per child ("Export tracking data as CSV" on
// the child profile; the link arrives by email and lasts 24 h —
// https://huckleberry.zendesk.com/hc/en-us/articles/5055945148819). The
// format below is not documented by Huckleberry; it was established from
// a real export published by its owner (archiewood/baby-tracker,
// sources/huckleberry/events.csv, ~3600 rows) and cross-checked against
// four independent open-source parsers (richardqhill/huckleberry-to-
// posthog, matthewsmorrison/baby-tracker, murphb52/BabyTracker,
// anaandresarroyo/baby-tracker). Nothing here is guessed; a row shape none
// of those sources show is skipped and counted, never imported wrong.
//
//   Type, Start, End, Duration, Start Condition, Start Location, End Condition, Notes
//
//   Start/End   "YYYY-MM-DD HH:MM" in the phone's local time, no offset → --tz
//   Duration    "H:MM" — except Diaper rows, where this column holds the
//               poo COLOUR (yellow, brown, green, red, black, mustard)
//   Feed        Start Location "Bottle": Start Condition "Formula" |
//               "Breast Milk" | "Mixed", End Condition the amount ("120ml",
//               "4.0oz"). Start Location "Breast": Start Condition the RIGHT
//               side "H:MMR", End Condition the LEFT side "H:MML", Duration
//               the total.
//   Solids      Start Condition a comma-separated list of foods.
//   Diaper      End Condition "Pee" | "Poo" | "Both", optionally with sizes
//               ("Pee:large", "Both, pee:large poo:small"); Start Location
//               may hold "Diaper rash".
//   Growth      Start Condition weight ("11.7kg", "25.8lb"), Start Location
//               height ("81.28cm", "2.67ft.in" = decimal FEET), End
//               Condition head circumference ("39.4cm").
//   Pump        Start Condition the LEFT amount, End Condition the RIGHT.
//   Meds        Start Location the name, Start Condition the dose
//               ("1.5ml", "1drops", "80mg").
//   Sleep       Start/End; Start Location may hold where or how ("crib",
//               "nursing, rocking") → sleep_log.location.
//   Tummy time  Start/End.
//   Bath, Temperature, Potty, Activity, Note … are counted as skipped.
//
// The export has no row ids, so Pjokk ids are a hash of the row's own
// content (hb-<12 hex>): stable across re-exports of the same data, and
// still ON CONFLICT DO NOTHING on a re-run.
//
// 1) node scripts/import-huckleberry.mjs nora.csv --inspect
// 2) node scripts/import-huckleberry.mjs nora.csv \
//      --resolve-by-email you@example.com --create-baby "Nora" --birth-date 2026-06-15 \
//      --tz Europe/Oslo --out pjokk-import.sql
//    …or --family <id> --caretaker <userId> --baby <pjokkBabyId>.
// 3) psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f pjokk-import.sql
//
// Lossy on purpose, preserved in notes: diaper sizes and "Diaper rash", a
// pump's per-side split, an unknown bottle content. Sleep rows carry no
// nap/night flag in Huckleberry and are imported untyped.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseCsv } from "./lib/csv.mjs";
import { argv, createWriter, esc, escOrNull } from "./lib/import-writer.mjs";
import { zonedToUtcMs } from "./lib/zoned-time.mjs";

const args = process.argv.slice(2);
const { flag, has } = argv(args);
const file = args.find(
  (a, i) =>
    a.endsWith(".csv") &&
    !(
      i > 0 &&
      args[i - 1].startsWith("--") &&
      !["--inspect"].includes(args[i - 1])
    ),
);
if (!file) {
  console.error(
    "usage: node scripts/import-huckleberry.mjs <export.csv> (--resolve-by-email you@example.com | --family <id> --caretaker <userId>) (--baby <pjokkBabyId> | --create-baby <name> [--birth-date YYYY-MM-DD] [--sex girl|boy]) [--tz Europe/Oslo] [--out file.sql] [--inspect]",
  );
  process.exit(1);
}

const { headers, rows } = parseCsv(readFileSync(file, "utf8"));
const need = [
  "Type",
  "Start",
  "End",
  "Duration",
  "Start Condition",
  "Start Location",
  "End Condition",
];
const missing = need.filter((h) => !headers.includes(h));
if (missing.length) {
  console.error(
    `this does not look like a Huckleberry export — missing columns: ${missing.join(", ")}`,
  );
  process.exit(1);
}

if (has("inspect")) {
  const byType = new Map();
  for (const r of rows) byType.set(r.Type, (byType.get(r.Type) ?? 0) + 1);
  const times = rows
    .map((r) => r.Start)
    .filter(Boolean)
    .sort();
  console.log(
    `${rows.length} rows, ${times[0] ?? "?"} → ${times[times.length - 1] ?? "?"}`,
  );
  for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1]))
    console.log(`  ${n} × ${t}`);
  process.exit(0);
}

const resolveEmail = flag("resolve-by-email");
const familyId = flag("family");
const caretakerId = flag("caretaker");
const babyName = flag("create-baby");
const babyIdFlag = flag("baby");
const tz = flag("tz") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const outPath = flag("out") ?? ".import.sql";
if (!resolveEmail && !(familyId && caretakerId)) {
  console.error(
    "--resolve-by-email, or both --family and --caretaker, is required",
  );
  process.exit(1);
}
if (!babyName && !babyIdFlag) {
  console.error(
    "--baby <pjokkBabyId> or --create-baby <name> is required (a Huckleberry export is one child)",
  );
  process.exit(1);
}

const w = createWriter({ resolveEmail, familyId, caretakerId });
const { skip, now, familyExpr, caretakerExpr, insert } = w;
const at = (text) => zonedToUtcMs(text, tz);
const rowId = (r) =>
  `hb-${createHash("sha1")
    .update(
      need
        .concat("Notes")
        .map((h) => r[h] ?? "")
        .join(""),
    )
    .digest("hex")
    .slice(0, 12)}`;

// "H:MM" (Huckleberry never writes seconds) → minutes.
const hmm = (v) => {
  const m = /^(\d+):(\d{2})$/.exec(String(v ?? "").trim());
  return m ? +m[1] * 60 + +m[2] : null;
};
// "H:MMR" / "H:MML" → minutes, if the side letter matches.
const sideMin = (v, letter) => {
  const m = /^(\d+):(\d{2})([LR])$/i.exec(String(v ?? "").trim());
  return m && m[3].toUpperCase() === letter ? +m[1] * 60 + +m[2] : null;
};
const numUnit = (v) => {
  const m = /^(\d+(?:[.,]\d+)?)\s*([a-z.]+)?$/i.exec(String(v ?? "").trim());
  return m
    ? { n: Number(m[1].replace(",", ".")), unit: (m[2] ?? "").toLowerCase() }
    : null;
};
const toMl = (v) => {
  const p = numUnit(v);
  if (!p) return null;
  if (p.unit === "oz" || p.unit === "floz") return Math.round(p.n * 29.5735);
  if (p.unit === "ml" || p.unit === "") return Math.round(p.n);
  skip(`volume unit "${p.unit}" not understood`);
  return null;
};
const toKg = (v) => {
  const p = numUnit(v);
  if (!p) return null;
  if (p.unit === "kg") return p.n;
  if (p.unit === "g") return p.n / 1000;
  if (p.unit === "lb" || p.unit === "lbs") return p.n * 0.45359237;
  skip(`weight unit "${p.unit}" not understood`);
  return null;
};
const toCm = (v) => {
  const p = numUnit(v);
  if (!p) return null;
  if (p.unit === "cm") return p.n;
  if (p.unit === "in") return p.n * 2.54;
  // Decimal feet: confirmed against same-week cm rows in the public export
  // (1.92ft.in ↔ 58.42cm, 1.75ft.in ↔ 53.34cm).
  if (p.unit === "ft.in" || p.unit === "ft") return p.n * 30.48;
  skip(`length unit "${p.unit}" not understood`);
  return null;
};
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const notes = (...parts) =>
  parts
    .filter((p) => p !== null && p !== undefined && String(p).trim() !== "")
    .join(" · ") || null;

w.prelude();
let babyId = babyIdFlag;
if (babyName) {
  babyId = `hb-baby-${createHash("sha1").update(babyName).digest("hex").slice(0, 12)}`;
  const birth = flag("birth-date") ? at(`${flag("birth-date")} 12:00`) : null;
  if (birth == null) skip("baby created without a birth date (--birth-date)");
  w.baby({
    id: babyId,
    name: babyName,
    birthDateMs: birth ?? now,
    sex: ["girl", "boy"].includes(flag("sex")) ? flag("sex") : null,
  });
}
const base = (r, timeMs) => {
  if (timeMs == null) {
    skip("unparseable time");
    return null;
  }
  return [esc(rowId(r)), familyExpr(), esc(babyId), caretakerExpr(), timeMs];
};

const FEED_COLS = [
  "id",
  "family_id",
  "baby_id",
  "caretaker_id",
  "time",
  "type",
  "amount_ml",
  "side",
  "duration_min",
  "left_min",
  "right_min",
  "contents",
  "food",
  "reaction",
  "notes",
  "created_at",
];

for (const r of rows) {
  const type = String(r.Type ?? "").trim();
  const sc = String(r["Start Condition"] ?? "").trim();
  const sl = String(r["Start Location"] ?? "").trim();
  const ec = String(r["End Condition"] ?? "").trim();
  switch (type) {
    case "Feed": {
      const b = base(r, at(r.Start));
      if (!b) continue;
      if (sl === "Bottle") {
        const contents =
          { formula: "formula", "breast milk": "breast_milk", mixed: "mixed" }[
            sc.toLowerCase()
          ] ?? null;
        if (sc && !contents) skip(`bottle contents "${sc}" kept in notes`);
        insert("feed_log", FEED_COLS, [
          ...b,
          esc("bottle"),
          toMl(ec) ?? "NULL",
          "NULL",
          "NULL",
          "NULL",
          "NULL",
          contents ? esc(contents) : "NULL",
          "NULL",
          "NULL",
          escOrNull(notes(contents ? null : sc, r.Notes)),
          now,
        ]);
      } else if (sl === "Breast") {
        const right = sideMin(sc, "R");
        const left = sideMin(ec, "L");
        const total =
          hmm(r.Duration) ??
          (left != null || right != null ? (left ?? 0) + (right ?? 0) : null);
        const side =
          left != null && right != null
            ? "both"
            : left != null
              ? "left"
              : right != null
                ? "right"
                : null;
        insert("feed_log", FEED_COLS, [
          ...b,
          esc("breast"),
          "NULL",
          side ? esc(side) : "NULL",
          total ?? "NULL",
          left ?? "NULL",
          right ?? "NULL",
          "NULL",
          "NULL",
          "NULL",
          escOrNull(notes(r.Notes)),
          now,
        ]);
      } else {
        skip(`feed location "${sl || "(blank)"}"`);
      }
      break;
    }
    case "Solids": {
      const b = base(r, at(r.Start));
      if (!b) continue;
      const food = sc.replace(/\s*,\s*/g, ", ").slice(0, 100) || null;
      insert("feed_log", FEED_COLS, [
        ...b,
        esc("solids"),
        "NULL",
        "NULL",
        "NULL",
        "NULL",
        "NULL",
        "NULL",
        escOrNull(food),
        "NULL",
        escOrNull(notes(r.Notes)),
        now,
      ]);
      break;
    }
    case "Diaper": {
      const b = base(r, at(r.Start));
      if (!b) continue;
      const lower = ec.toLowerCase();
      const pee = /\bpee\b/.test(lower) || lower.startsWith("both");
      const poo = /\bpoo\b/.test(lower) || lower.startsWith("both");
      const dtype =
        pee && poo
          ? "both"
          : pee
            ? "wet"
            : poo
              ? "dirty"
              : lower === ""
                ? "dry"
                : null;
      if (!dtype) {
        skip(`diaper contents "${ec}"`);
        continue;
      }
      const colourWord = String(r.Duration ?? "")
        .trim()
        .toLowerCase();
      const colour = ["yellow", "green", "brown", "black", "red"].includes(
        colourWord,
      )
        ? colourWord
        : colourWord
          ? "other"
          : null;
      const sizes = [...lower.matchAll(/(pee|poo):\s*(\w+)/g)]
        .map((m) => `${m[1]} ${m[2]}`)
        .join(", ");
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
          esc(dtype),
          colour ? esc(colour) : "NULL",
          "NULL",
          escOrNull(
            notes(sizes, colour === "other" ? colourWord : null, sl, r.Notes),
          ),
          now,
        ],
      );
      break;
    }
    case "Sleep":
    case "Nap": {
      const b = base(r, at(r.Start));
      if (!b) continue;
      const end = at(r.End);
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
          escOrNull(sl.slice(0, 100)),
          type === "Nap" ? esc("nap") : "NULL",
          escOrNull(notes(r.Notes)),
          now,
        ],
      );
      break;
    }
    case "Growth": {
      const t = at(r.Start);
      if (t == null) {
        skip("unparseable time");
        continue;
      }
      let any = false;
      for (const [mtype, raw, conv, d] of [
        ["weight", sc, toKg, 2],
        ["length", sl, toCm, 1],
        ["head", ec, toCm, 1],
      ]) {
        if (!raw) continue;
        const v = conv(raw);
        if (v == null) continue;
        any = true;
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
            esc(`${rowId(r)}-${mtype}`),
            familyExpr(),
            esc(babyId),
            caretakerExpr(),
            t,
            esc(mtype),
            round(v, d),
            escOrNull(notes(r.Notes)),
            now,
          ],
        );
      }
      if (!any) skip("growth row without a value");
      break;
    }
    case "Pump": {
      const b = base(r, at(r.Start));
      if (!b) continue;
      const left = toMl(sc);
      const right = toMl(ec);
      const total =
        left == null && right == null ? null : (left ?? 0) + (right ?? 0);
      const side =
        left != null && right != null
          ? "both"
          : left != null
            ? "left"
            : right != null
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
          total ?? "NULL",
          hmm(r.Duration) ?? "NULL",
          escOrNull(
            notes(
              side === "both" ? `L ${left} ml, R ${right} ml` : null,
              r.Notes,
            ),
          ),
          now,
        ],
      );
      break;
    }
    case "Meds": {
      const b = base(r, at(r.Start));
      if (!b) continue;
      const p = numUnit(sc);
      const unit = p
        ? ({
            ml: "ml",
            mg: "mg",
            drops: "drops",
            drop: "drops",
            dose: "dose",
            doses: "dose",
            tablet: "dose",
            tablets: "dose",
          }[p.unit] ?? null)
        : null;
      if (p?.unit && !unit) skip(`medicine unit "${p.unit}" kept in notes`);
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
          esc(sl || "Medicine"),
          p ? p.n : "NULL",
          unit ? esc(unit) : "NULL",
          "NULL",
          escOrNull(notes(p && !unit ? sc : null, r.Notes)),
          now,
        ],
      );
      break;
    }
    case "Tummy time": {
      const b = base(r, at(r.Start));
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
          at(r.End) ?? "NULL",
          escOrNull(notes(r.Notes)),
          now,
        ],
      );
      break;
    }
    case "Bath": {
      const b = base(r, at(r.Start));
      if (!b) continue;
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
        [...b, escOrNull(notes(r.Notes)), now],
      );
      break;
    }
    default:
      skip(
        `type "${type || "(blank)"}" (no Pjokk equivalent, or a shape no public export shows)`,
      );
  }
}

w.finish(outPath);
