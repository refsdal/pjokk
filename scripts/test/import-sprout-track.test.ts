import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A smoke run of the sprout-track importer after its move onto the shared
// writer: a minimal sprout schema (every table the script reads, one baby
// and one feed), resolve mode, and the SQL it emits. The full mapping is
// exercised by hand against real exports; this guards the plumbing.
const root = join(import.meta.dir, "..", "..");
const script = join(root, "scripts", "import-sprout-track.mjs");

// The tables whose numeric cells used to be pasted into the SQL verbatim
// (issue #94), declared with sprout's own column types. SQLite does not
// enforce them: a REAL or INTEGER column keeps whatever text it is given,
// which is the whole point of the test that uses them.
const COLUMNS: Record<string, string> = {
  PumpLog:
    "id TEXT, babyId TEXT, caretakerId TEXT, startTime TEXT, leftAmount REAL, rightAmount REAL, totalAmount REAL, unitAbbr TEXT, duration INTEGER, notes TEXT, deletedAt TEXT",
  MedicineLog:
    "id TEXT, babyId TEXT, caretakerId TEXT, time TEXT, medicineId TEXT, doseAmount REAL, unitAbbr TEXT, notes TEXT, deletedAt TEXT",
  VaccineLog:
    "id TEXT, babyId TEXT, caretakerId TEXT, time TEXT, vaccineName TEXT, doseNumber INTEGER, notes TEXT, deletedAt TEXT",
  CalendarEvent:
    "id TEXT, title TEXT, description TEXT, location TEXT, type TEXT, startTime TEXT, endTime TEXT, allDay INTEGER, reminderTime INTEGER, recurring INTEGER, recurrencePattern TEXT, deletedAt TEXT",
};

function fixture(seed?: (db: Database) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "pjokk-st-"));
  const path = join(dir, "sprout.db");
  const db = new Database(path);
  db.run(
    "CREATE TABLE Baby (id TEXT, firstName TEXT, lastName TEXT, birthDate TEXT, gender TEXT, deletedAt TEXT)",
  );
  db.run(
    "CREATE TABLE Caretaker (id TEXT, name TEXT, type TEXT, deletedAt TEXT)",
  );
  db.run("CREATE TABLE Food (id TEXT, name TEXT)");
  db.run(
    "CREATE TABLE Medicine (id TEXT, name TEXT, unitAbbr TEXT, typicalDoseSize REAL, doseMinTime TEXT, active INTEGER)",
  );
  db.run(
    "CREATE TABLE FeedLog (id TEXT, babyId TEXT, caretakerId TEXT, time TEXT, type TEXT, amount REAL, unitAbbr TEXT, side TEXT, feedDuration INTEGER, startTime TEXT, endTime TEXT, bottleType TEXT, food TEXT, breastMilkAmount REAL, hadReaction INTEGER, reactionDescription TEXT, reactionCause TEXT, notes TEXT, deletedAt TEXT)",
  );
  for (const t of [
    "FoodLog",
    "DiaperLog",
    "SleepLog",
    "Note",
    "Milestone",
    "PumpLog",
    "BathLog",
    "Measurement",
    "MedicineLog",
    "VaccineLog",
    "PlayLog",
    "CalendarEvent",
    "Contact",
  ]) {
    db.run(`CREATE TABLE ${t} (${COLUMNS[t] ?? "id TEXT, deletedAt TEXT"})`);
  }
  for (const t of ["VaccineDocument", "BabyEvent", "CaretakerEvent"])
    db.run(`CREATE TABLE ${t} (id TEXT)`);
  db.run(
    "INSERT INTO Baby VALUES ('b1', 'Nora', 'Hansen', '2026-06-15 00:00:00', 'FEMALE', NULL)",
  );
  db.run(
    "INSERT INTO FeedLog (id, babyId, time, type, amount, unitAbbr, bottleType) VALUES ('f1', 'b1', '2026-09-01 08:00:00', 'BOTTLE', 4, 'OZ', 'Formula')",
  );
  seed?.(db);
  db.close();
  return path;
}

function runResolve(dbPath: string) {
  const out = join(mkdtempSync(join(tmpdir(), "pjokk-st-out-")), "import.sql");
  const proc = Bun.spawnSync(
    [
      "node",
      script,
      dbPath,
      "--resolve-by-email",
      "you@example.com",
      "--create-babies",
      "--out",
      out,
    ],
    { cwd: root },
  );
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    sql: proc.exitCode === 0 ? readFileSync(out, "utf8") : "",
  };
}

describe("import-sprout-track (writer plumbing)", () => {
  test("resolve mode emits one transaction with the baby and the feed", () => {
    const r = runResolve(fixture());
    expect(r.code, r.stderr).toBe(0);
    const { sql } = r;
    expect(sql.startsWith("BEGIN;")).toBe(true);
    expect(sql.trim().endsWith("COMMIT;")).toBe(true);
    expect(sql).toContain(
      `'st-b1', family_id, 'Nora Hansen', '2026-06-15T00:00:00.000Z', 'girl' FROM _import_target ON CONFLICT DO NOTHING;`,
    );
    expect(sql).toContain(
      `'st-f1', family_id, 'st-b1', caretaker_id, '2026-09-01T08:00:00.000Z', 'bottle', 118, NULL, NULL, 'formula'`,
    );
    expect(r.stdout).toContain("1 × feed_log");
  });

  // Issue #94: five numeric cells went from the SQLite file into the SQL
  // with no conversion and no escaping. Text in any of them now imports as
  // NULL, counted in the summary, and never reaches the SQL; a real number
  // beside it still comes through.
  test("text in a numeric cell imports as NULL and never reaches the SQL", () => {
    const hostile = `0); DELETE FROM "users"; --`;
    const r = runResolve(
      fixture((db) => {
        const add = (sql: string, ...values: (string | number | null)[]) =>
          db.query(sql).run(...values);
        const medicine =
          "INSERT INTO Medicine VALUES (?, ?, 'DROP', ?, NULL, 1)";
        add(medicine, "mh", "Hostile drops", hostile);
        add(medicine, "mn", "Vitamin D", 3);
        const pump =
          "INSERT INTO PumpLog VALUES (?, 'b1', NULL, '2026-09-01 09:00:00', 100, NULL, NULL, 'ML', ?, NULL, NULL)";
        add(pump, "ph", hostile);
        add(pump, "pn", 15);
        const dose =
          "INSERT INTO MedicineLog VALUES (?, 'b1', NULL, '2026-09-01 10:00:00', 'mn', ?, 'DROP', NULL, NULL)";
        add(dose, "mlh", hostile);
        add(dose, "mln", 2);
        const vaccine =
          "INSERT INTO VaccineLog VALUES (?, 'b1', NULL, '2026-09-01 11:00:00', 'Rotavirus', ?, NULL, NULL)";
        add(vaccine, "vh", hostile);
        add(vaccine, "vn", 2);
        const event =
          "INSERT INTO CalendarEvent VALUES (?, 'Helsestasjon', NULL, NULL, 'APPOINTMENT', '2026-09-20 10:00:00', '2026-09-20 10:30:00', 0, ?, 0, NULL, NULL)";
        add(event, "ch", hostile);
        add(event, "cn", 30);
      }),
    );
    expect(r.code, r.stderr).toBe(0);
    const { sql, stdout } = r;
    expect(sql).not.toContain(hostile);
    expect(sql).not.toContain("DELETE");

    // pump_log.duration_min
    expect(sql).toContain(
      `'st-ph', family_id, 'st-b1', caretaker_id, '2026-09-01T09:00:00.000Z', 'left', 100, NULL, NULL,`,
    );
    expect(sql).toContain(
      `'st-pn', family_id, 'st-b1', caretaker_id, '2026-09-01T09:00:00.000Z', 'left', 100, 15, NULL,`,
    );
    // medicine.default_amount
    expect(sql).toContain(
      `'st-med-mh', family_id, 'Hostile drops', NULL, 'drops', NULL, false, NULL,`,
    );
    expect(sql).toContain(
      `'st-med-mn', family_id, 'Vitamin D', 3, 'drops', NULL, false, NULL,`,
    );
    // medicine_log.amount
    expect(sql).toContain(
      `'st-mlh', family_id, 'st-b1', caretaker_id, '2026-09-01T10:00:00.000Z', 'Vitamin D', NULL, 'drops', 'st-med-mn', NULL,`,
    );
    expect(sql).toContain(
      `'st-mln', family_id, 'st-b1', caretaker_id, '2026-09-01T10:00:00.000Z', 'Vitamin D', 2, 'drops', 'st-med-mn', NULL,`,
    );
    // vaccine_log.dose_number
    expect(sql).toContain(
      `'st-vh', family_id, 'st-b1', caretaker_id, '2026-09-01T11:00:00.000Z', 'Rotavirus', NULL, NULL, NULL,`,
    );
    expect(sql).toContain(
      `'st-vn', family_id, 'st-b1', caretaker_id, '2026-09-01T11:00:00.000Z', 'Rotavirus', 2, NULL, NULL,`,
    );
    // calendar_event.remind_minutes_before (after all_day and duration_min)
    expect(sql).toContain(
      `'st-ch', family_id, caretaker_id, 'Helsestasjon', NULL, NULL, 'doctor', '2026-09-20T10:00:00.000Z', false, 30, NULL,`,
    );
    expect(sql).toContain(
      `'st-cn', family_id, caretaker_id, 'Helsestasjon', NULL, NULL, 'doctor', '2026-09-20T10:00:00.000Z', false, 30, 30,`,
    );

    for (const what of [
      "pump duration",
      "medicine default dose",
      "medicine dose",
      "vaccine dose number",
      "calendar reminder",
    ])
      expect(stdout).toContain(`1 × non-numeric ${what} imported as NULL`);
  });

  test("--inspect still works", () => {
    const proc = Bun.spawnSync(["node", script, fixture(), "--inspect"], {
      cwd: root,
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    expect(proc.stdout.toString()).toContain(
      "b1  Nora Hansen  born 2026-06-15",
    );
  });
});
