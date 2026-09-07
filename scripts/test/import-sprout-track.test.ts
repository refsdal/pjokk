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

function fixture(): string {
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
    db.run(`CREATE TABLE ${t} (id TEXT, deletedAt TEXT)`);
  }
  for (const t of ["VaccineDocument", "BabyEvent", "CaretakerEvent"])
    db.run(`CREATE TABLE ${t} (id TEXT)`);
  db.run(
    "INSERT INTO Baby VALUES ('b1', 'Nora', 'Hansen', '2026-06-15 00:00:00', 'FEMALE', NULL)",
  );
  db.run(
    "INSERT INTO FeedLog (id, babyId, time, type, amount, unitAbbr, bottleType) VALUES ('f1', 'b1', '2026-09-01 08:00:00', 'BOTTLE', 4, 'OZ', 'Formula')",
  );
  db.close();
  return path;
}

describe("import-sprout-track (writer plumbing)", () => {
  test("resolve mode emits one transaction with the baby and the feed", () => {
    const dbPath = fixture();
    const out = join(
      mkdtempSync(join(tmpdir(), "pjokk-st-out-")),
      "import.sql",
    );
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
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const sql = readFileSync(out, "utf8");
    expect(sql.startsWith("BEGIN;")).toBe(true);
    expect(sql.trim().endsWith("COMMIT;")).toBe(true);
    expect(sql).toContain(
      `'st-b1', family_id, 'Nora Hansen', '2026-06-15T00:00:00.000Z', 'girl' FROM _import_target ON CONFLICT DO NOTHING;`,
    );
    expect(sql).toContain(
      `'st-f1', family_id, 'st-b1', caretaker_id, '2026-09-01T08:00:00.000Z', 'bottle', 118, NULL, NULL, 'formula'`,
    );
    expect(proc.stdout.toString()).toContain("1 × feed_log");
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
