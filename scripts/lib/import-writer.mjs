// The one writer every importer shares (issue #54). A reader turns a
// source — sprout-track's SQLite, Baby Buddy's CSVs — into calls to
// insert(); this module owns everything that must not differ between
// sources: SQL rendering by column type, deterministic ids, the
// --resolve-by-email guard that aborts unless exactly one (user, family)
// matches, the baby prelude, ON CONFLICT DO NOTHING, and the summary of
// what was skipped and why.
//
// It emits SQL to review and apply with psql, never a live connection:
// importing four thousand rows is an admin action, and reading the file
// first is the safety net.
import { writeFileSync } from "node:fs";

export const esc = (s) => `'${String(s).replaceAll("'", "''")}'`;
export const escOrNull = (s) =>
  s === null || s === undefined || s === "" ? "NULL" : esc(s);

// Postgres columns are typed, unlike SQLite's or a CSV's, so values are
// rendered by column name at this single boundary rather than at each call
// site: timestamps are timestamptz (an epoch-ms integer is not accepted)
// and flags are real booleans (1/0 is not accepted either).
export const TIMESTAMP_COLS = new Set([
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
  "archived_at",
  "recurrence_until",
]);
export const BOOLEAN_COLS = new Set([
  "all_day",
  "read_only",
  "email_verified",
  "is_supplement",
  "reaction",
]);

const at = (msValue) => `'${new Date(msValue).toISOString()}'`;

export const render = (col, v) => {
  if (v === "NULL" || v === null || v === undefined) return "NULL";
  if (TIMESTAMP_COLS.has(col) && typeof v === "number") return at(v);
  if (BOOLEAN_COLS.has(col)) {
    if (v === "TRUE" || v === "true") return "true";
    if (v === "FALSE" || v === "false") return "false";
    return v && v !== "0" ? "true" : "false";
  }
  return v;
};

export const FAMILY_REF = "family_id";
export const CARETAKER_REF = "caretaker_id";

/**
 * createWriter({ resolveEmail?, familyId?, caretakerId?, now? })
 *
 * In resolve mode (--resolve-by-email) family_id and caretaker_id are bare
 * column references into a one-row temp table the prelude creates, so every
 * INSERT is a SELECT … FROM _import_target and the whole file is one
 * transaction that aborts on a missing or ambiguous account. Otherwise the
 * ids are baked in as literals.
 */
export function createWriter({
  resolveEmail,
  familyId,
  caretakerId,
  now = Date.now(),
} = {}) {
  const out = [];
  const skipped = {};
  const counts = {};
  const skip = (why) => (skipped[why] = (skipped[why] ?? 0) + 1);

  const familyExpr = () => (resolveEmail ? FAMILY_REF : esc(familyId));
  const caretakerExpr = (id = caretakerId) =>
    resolveEmail ? CARETAKER_REF : esc(id);

  const insert = (table, cols, vals) => {
    const exprs = cols.map((col, i) => render(col, vals[i])).join(", ");
    const head = `INSERT INTO "${table}" (${cols.join(", ")})`;
    out.push(
      resolveEmail
        ? `${head} SELECT ${exprs} FROM _import_target ON CONFLICT DO NOTHING;`
        : `${head} VALUES (${exprs}) ON CONFLICT DO NOTHING;`,
    );
    counts[table] = (counts[table] ?? 0) + 1;
  };

  const prelude = () => {
    if (!resolveEmail) return;
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
  };

  /** One baby row under a deterministic id; returns nothing, the caller keeps its own map. */
  const baby = ({ id, name, birthDateMs, sex }) => {
    insert(
      "baby",
      ["id", "family_id", "name", "birth_date", "sex"],
      [
        esc(id),
        familyExpr(),
        esc(name || "Baby"),
        birthDateMs,
        sex ? esc(sex) : "NULL",
      ],
    );
  };

  const finish = (outPath, { log = console.log } = {}) => {
    if (resolveEmail) out.push("", "COMMIT;");
    writeFileSync(outPath, out.join("\n") + "\n");
    const inserts = out.filter((l) => l.startsWith("INSERT")).length;
    log(`wrote ${outPath} (${inserts} inserts)`);
    const tables = Object.entries(counts);
    if (tables.length) {
      log("imported:");
      for (const [table, n] of tables) log(`  ${n} × ${table}`);
    }
    if (Object.keys(skipped).length) {
      log("skipped:");
      for (const [why, n] of Object.entries(skipped)) log(`  ${n} × ${why}`);
    }
    return { inserts, counts, skipped };
  };

  return {
    out,
    skipped,
    counts,
    skip,
    now,
    familyExpr,
    caretakerExpr,
    insert,
    prelude,
    baby,
    finish,
    esc,
    escOrNull,
  };
}

/** Shared argv helpers: `flag("name")` → value, `flagAll("name")` → every value, `has("--x")`. */
export function argv(args) {
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const flagAll = (name) =>
    args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
  const has = (name) => args.includes(`--${name}`);
  const positional = args.filter(
    (a, i) =>
      !a.startsWith("--") &&
      (i === 0 ||
        !args[i - 1].startsWith("--") ||
        args[i - 1] === "--create-babies" ||
        args[i - 1] === "--inspect"),
  );
  return { flag, flagAll, has, positional };
}
