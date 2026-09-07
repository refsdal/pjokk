import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the real script under node (it is a node CLI, not a bun one) against
// the Baby Buddy fixtures and reads the SQL it writes.
const root = join(import.meta.dir, "..", "..");
const fixtures = join(import.meta.dir, "fixtures", "babybuddy");
const script = join(root, "scripts", "import-babybuddy.mjs");
const files = [
  "child",
  "feeding",
  "diaperchange",
  "sleep",
  "weight",
  "temperature",
  "note",
  "medication",
  "tummytime",
  "other-child",
].map((f) => join(fixtures, `${f}.csv`));

function run(extra: string[]) {
  const out = join(mkdtempSync(join(tmpdir(), "pjokk-bb-")), "import.sql");
  const proc = Bun.spawnSync(
    ["node", script, ...files, ...extra, "--out", out],
    { cwd: root },
  );
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    sql:
      proc.exitCode === 0 && existsSync(out) ? readFileSync(out, "utf8") : "",
  };
}

describe("import-babybuddy", () => {
  test("resolve mode: one transaction, babies from the child columns, every kind mapped, zone and units applied", () => {
    const r = run([
      "--resolve-by-email",
      "you@example.com",
      "--create-babies",
      "--tz",
      "Europe/Oslo",
      "--volume",
      "oz",
      "--weight",
      "lb",
      "--temperature",
      "f",
    ]);
    expect(r.code, r.stderr).toBe(0);
    const { sql, stdout } = r;
    expect(sql.startsWith("BEGIN;")).toBe(true);
    expect(sql.trim().endsWith("COMMIT;")).toBe(true);
    expect(sql).toContain(
      "expected exactly one (user, family) for you@example.com",
    );
    expect(sql).toContain(
      `INSERT INTO "baby" (id, family_id, name, birth_date, sex) SELECT 'bb-child-1', family_id, 'Nora Hansen', '2026-06-15T06:30:00.000Z', NULL FROM _import_target`,
    );
    expect(sql).toContain(`'bb-child-2', family_id, 'Ola Berg'`);
    expect(stdout).toContain("created without a birth date");
    expect(sql).toContain(
      `'bb-feeding-10', family_id, 'bb-child-1', caretaker_id, '2026-09-01T06:00:00.000Z', 'bottle', 118, NULL, NULL, 'formula', NULL, NULL, 'morning, hungry'`,
    );
    expect(sql).toContain(
      `'bb-feeding-11', family_id, 'bb-child-1', caretaker_id, '2026-09-01T10:00:00.000Z', 'breast', NULL, 'left', 20, NULL, NULL, NULL, NULL`,
    );
    expect(stdout).toContain("tags dropped");
    expect(sql).toContain(
      `'bb-feeding-12', family_id, 'bb-child-1', caretaker_id, '2026-09-01T16:00:00.000Z', 'solids', 30, NULL, NULL, NULL, NULL, NULL, 'parent fed · avocado'`,
    );
    expect(stdout).toContain("solids amount taken as grams");
    expect(sql).toContain(
      `'bb-feeding-13', family_id, 'bb-child-1', caretaker_id, '2026-09-01T19:00:00.000Z', 'bottle', 104, NULL, NULL, 'mixed', NULL, NULL, 'fortified'`,
    );
    expect(sql).toContain(
      `'bb-diaperchange-20', family_id, 'bb-child-1', caretaker_id, '2026-09-01T07:00:00.000Z', 'both', 'yellow', NULL, NULL`,
    );
    expect(sql).toContain(
      `'bb-diaperchange-21', family_id, 'bb-child-1', caretaker_id, '2026-09-01T12:00:00.000Z', 'dry', NULL, NULL, 'just checked'`,
    );
    expect(sql).toContain(
      `'bb-diaperchange-22', family_id, 'bb-child-1', caretaker_id, '2026-09-01T14:00:00.000Z', 'wet', NULL, NULL, 'amount 2'`,
    );
    expect(sql).toContain(
      `'bb-sleep-30', family_id, 'bb-child-1', caretaker_id, '2026-09-01T11:00:00.000Z', '2026-09-01T12:30:00.000Z', NULL, 'nap'`,
    );
    expect(sql).toContain(
      `'bb-sleep-31', family_id, 'bb-child-1', caretaker_id, '2026-09-01T18:00:00.000Z', '2026-09-02T03:00:00.000Z', NULL, 'night'`,
    );
    expect(sql).toContain(
      `'bb-weight-40', family_id, 'bb-child-1', caretaker_id, '2026-09-01T10:00:00.000Z', 'weight', 5.22`,
    );
    expect(sql).toContain(
      `'bb-temperature-50', family_id, 'bb-child-1', caretaker_id, '2026-09-01T20:00:00.000Z', 'temperature', 38.39`,
    );
    expect(sql).toContain(
      `'bb-note-60', family_id, 'bb-child-1', caretaker_id, '2026-09-01T15:00:00.000Z', 'First laugh, at the dog', NULL`,
    );
    expect(sql).toContain(
      `'bb-medication-70', family_id, 'bb-child-1', caretaker_id, '2026-09-01T20:10:00.000Z', 'Paracetamol', 2.5, 'ml', NULL, 'next dose after 06:00:00'`,
    );
    expect(sql).toContain(
      `'bb-medication-71', family_id, 'bb-child-1', caretaker_id, '2026-09-01T06:30:00.000Z', 'Vitamin D', 1, 'dose', NULL, NULL`,
    );
    expect(sql).toContain(
      `INSERT INTO "play_log" (id, family_id, baby_id, caretaker_id, type, start_time, end_time, notes, created_at) SELECT 'bb-tummytime-80', family_id, 'bb-child-1', caretaker_id, 'tummy', '2026-09-01T08:00:00.000Z', '2026-09-01T08:10:00.000Z', 'Lifted her head'`,
    );
    for (const line of sql.split("\n").filter((l) => l.startsWith("INSERT"))) {
      expect(line.endsWith("ON CONFLICT DO NOTHING;")).toBe(true);
    }
    expect(stdout).toMatch(/imported:\n(.*\n)*\s+4 × feed_log/);
  });

  test("literal mode: --family/--caretaker/--baby, an unmapped child is skipped and counted", () => {
    const r = run([
      "--family",
      "fam1",
      "--caretaker",
      "user1",
      "--baby",
      "1=baby_nora",
      "--tz",
      "UTC",
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.sql.startsWith("BEGIN;")).toBe(false);
    expect(r.sql).toContain(
      `INSERT INTO "feed_log" (id, family_id, baby_id, caretaker_id, time, type, amount_ml, side, duration_min, contents, food, reaction, notes, created_at) VALUES ('bb-feeding-10', 'fam1', 'baby_nora', 'user1', '2026-09-01T08:00:00.000Z', 'bottle', 4,`,
    );
    expect(r.sql).not.toContain("bb-child-2");
    expect(r.stdout).toContain("1 × unmapped child");
  });

  test("refuses to run without a target or a baby mapping, and rejects a bad unit", () => {
    expect(run(["--create-babies"]).code).toBe(1);
    expect(
      run(["--resolve-by-email", "x@y", "--volume", "cups", "--create-babies"])
        .code,
    ).toBe(1);
    expect(run(["--resolve-by-email", "x@y"]).code).toBe(1);
  });

  test("--inspect lists the models and children without writing anything", () => {
    const r = run(["--inspect"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("feeding.csv: feeding (4 rows)");
    expect(r.stdout).toContain("1  Nora Hansen");
    expect(r.stdout).toContain("2  Ola Berg");
  });
});
