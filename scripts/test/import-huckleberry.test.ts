import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the real script under node against a fixture distilled from a
// public Huckleberry export (every row shape that export and four
// independent parsers show), and reads the SQL it writes.
const root = join(import.meta.dir, "..", "..");
const script = join(root, "scripts", "import-huckleberry.mjs");
const csv = join(import.meta.dir, "fixtures", "huckleberry", "nora.csv");

function run(extra: string[]) {
  const out = join(mkdtempSync(join(tmpdir(), "pjokk-hb-")), "import.sql");
  const proc = Bun.spawnSync(["node", script, csv, ...extra, "--out", out], {
    cwd: root,
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    sql:
      proc.exitCode === 0 && existsSync(out) ? readFileSync(out, "utf8") : "",
  };
}

describe("import-huckleberry", () => {
  test("every row shape lands in the right table with the right numbers", () => {
    const r = run([
      "--resolve-by-email",
      "you@example.com",
      "--create-baby",
      "Nora",
      "--birth-date",
      "2026-06-15",
      "--sex",
      "girl",
      "--tz",
      "Europe/Oslo",
    ]);
    expect(r.code, r.stderr).toBe(0);
    const { sql, stdout } = r;
    expect(sql.startsWith("BEGIN;")).toBe(true);
    expect(sql).toContain(
      `'Nora', '2026-06-15T10:00:00.000Z', 'girl' FROM _import_target`,
    );
    // Sleep: untyped (Huckleberry has no nap/night flag); 19:32 Oslo = 17:32Z.
    expect(sql).toMatch(
      /"sleep_log" .* '2026-09-01T17:32:00.000Z', '2026-09-02T04:57:00.000Z', NULL, NULL, NULL,/,
    );
    expect(sql).toMatch(
      /"sleep_log" .* '2026-09-01T11:05:00.000Z', '2026-09-01T13:17:00.000Z', 'crib, nursing', NULL, 'in the pram',/,
    );
    // Bottles: ml as is, oz converted, Mixed → mixed.
    expect(sql).toMatch(
      /"feed_log" .* '2026-09-01T06:00:00.000Z', 'bottle', 120, NULL, NULL, NULL, NULL, 'formula', NULL, NULL, NULL,/,
    );
    expect(sql).toMatch(
      /'bottle', 118, NULL, NULL, NULL, NULL, 'breast_milk',/,
    );
    expect(sql).toMatch(/'bottle', 90, NULL, NULL, NULL, NULL, 'mixed',/);
    // Nursing: right then left, both sides; right only; left only.
    expect(sql).toMatch(
      /'breast', NULL, 'both', 14, 6, 7, NULL, NULL, NULL, NULL,/,
    );
    expect(sql).toMatch(/'breast', NULL, 'right', 29, NULL, 29, NULL,/);
    expect(sql).toMatch(/'breast', NULL, 'left', 18, 18, NULL, NULL,/);
    // Solids keep the food list.
    expect(sql).toMatch(
      /'solids', NULL, NULL, NULL, NULL, NULL, NULL, 'avocado, banana', NULL, NULL,/,
    );
    // Diapers: both with colour and sizes noted; wet; dirty with mustard →
    // other + rash + note; both without sizes.
    expect(sql).toMatch(
      /"diaper_log" .* '2026-09-01T07:00:00.000Z', 'both', 'yellow', NULL, 'pee large, poo small',/,
    );
    expect(sql).toMatch(/'2026-09-01T10:30:00.000Z', 'wet', NULL, NULL, NULL,/);
    expect(sql).toMatch(
      /'2026-09-01T14:00:00.000Z', 'dirty', 'other', NULL, 'poo medium · mustard · Diaper rash · Blowout',/,
    );
    expect(sql).toMatch(
      /'2026-09-01T16:00:00.000Z', 'both', NULL, NULL, NULL,/,
    );
    // Growth: three measurements from one row; lb and decimal feet converted.
    expect(sql).toMatch(
      /"measurement_log" .*-weight', family_id, 'hb-baby-\w+', caretaker_id, '2026-09-01T13:27:00.000Z', 'weight', 5.2,/,
    );
    expect(sql).toMatch(/-length', .* 'length', 58.4,/);
    expect(sql).toMatch(/-head', .* 'head', 38,/);
    expect(sql).toMatch(/'weight', 5.35,/); // 11.8 lb
    expect(sql).toMatch(/'length', 58.5,/); // 1.92 decimal feet
    // Pump: both sides summed, the split in notes, the duration.
    expect(sql).toMatch(/"pump_log" .* 'both', 220, 20, 'L 100 ml, R 120 ml',/);
    // Meds: name from Start Location, dose parsed.
    expect(sql).toMatch(/"medicine_log" .* 'Tylenol', 1.5, 'ml', NULL, NULL,/);
    expect(sql).toMatch(/'Vitamin D', 1, 'drops', NULL, NULL,/);
    // Tummy time → play; Bath → bath.
    expect(sql).toMatch(
      /"play_log" .* 'tummy', '2026-09-01T14:02:00.000Z', '2026-09-01T14:04:00.000Z', NULL,/,
    );
    expect(sql).toMatch(/"bath_log" .* '2026-09-01T16:30:00.000Z', NULL,/);
    // Potty has no Pjokk equivalent and is counted, not guessed.
    expect(stdout).toContain('1 × type "Potty"');
    expect(stdout).toMatch(/7 × feed_log/);
    for (const line of sql.split("\n").filter((l) => l.startsWith("INSERT"))) {
      expect(line.endsWith("ON CONFLICT DO NOTHING;")).toBe(true);
    }
  });

  test("ids are a hash of the row, so a re-export of the same data gets the same ids", () => {
    const flags = [
      "--family",
      "fam1",
      "--caretaker",
      "user1",
      "--baby",
      "baby_nora",
      "--tz",
      "UTC",
    ];
    const a = run(flags);
    const b = run(flags);
    expect(a.code, a.stderr).toBe(0);
    const ids = (sql: string) => sql.match(/'hb-[0-9a-f]{12}(?:-\w+)?'/g) ?? [];
    expect(ids(a.sql)).toEqual(ids(b.sql));
    expect(new Set(ids(a.sql)).size).toBe(ids(a.sql).length);
    expect(a.sql).toContain("VALUES ('hb-");
    expect(a.sql).not.toContain("BEGIN;");
  });

  test("refuses a file without the Huckleberry columns, and a run without a baby", () => {
    const bad = join(import.meta.dir, "fixtures", "babybuddy", "feeding.csv");
    const proc = Bun.spawnSync(
      ["node", script, bad, "--resolve-by-email", "x@y", "--create-baby", "N"],
      { cwd: root },
    );
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("missing columns");
    expect(run(["--resolve-by-email", "x@y"]).code).toBe(1);
  });

  test("--inspect summarises the file", () => {
    const r = run(["--inspect"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("21 rows, 2026-08-09 15:28 → 2026-09-01 22:13");
    expect(r.stdout).toContain("6 × Feed");
  });
});
