import { describe, expect, test } from "bun:test";
import {
  CARETAKER_REF,
  createWriter,
  esc,
  FAMILY_REF,
  render,
} from "../lib/import-writer.mjs";

// render() is the one place every importer's values become SQL text, so it
// fails closed (issue #94): a value it cannot prove is a number, NULL, a
// boolean, the writer's own column reference or a well-formed quoted
// literal is an error, not something to paste into the statement.
describe("render", () => {
  test("passes everything the writer and the readers legitimately emit", () => {
    expect(render("amount_ml", 118)).toBe("118");
    expect(render("value", -3.25)).toBe("-3.25");
    expect(render("amount_ml", null)).toBe("NULL");
    expect(render("amount_ml", undefined)).toBe("NULL");
    expect(render("amount_ml", "NULL")).toBe("NULL");
    expect(render("notes", "TRUE")).toBe("TRUE");
    expect(render("notes", "FALSE")).toBe("FALSE");
    expect(render("family_id", FAMILY_REF)).toBe("family_id");
    expect(render("caretaker_id", CARETAKER_REF)).toBe("caretaker_id");
    expect(render("notes", esc("it's"))).toBe("'it''s'");
    expect(render("notes", esc("two\nlines, a \\ and ''"))).toBe(
      "'two\nlines, a \\ and '''''",
    );
    expect(render("notes", esc(""))).toBe("''");
    expect(render("created_at", Date.UTC(2026, 8, 1))).toBe(
      "'2026-09-01T00:00:00.000Z'",
    );
    expect(render("reaction", "TRUE")).toBe("true");
    expect(render("is_supplement", false)).toBe("false");
    expect(render("all_day", 1)).toBe("true");
    expect(render("all_day", 0)).toBe("false");
  });

  test("throws on a bare string that is not a well-formed quoted literal", () => {
    for (const v of [
      `0); DELETE FROM "users"; --`,
      "12",
      "12abc",
      "",
      "'unterminated",
      "'it's'",
      "'a' || 'b'",
      "E'x'",
      " 'padded'",
      "family_id2",
      "true",
    ])
      expect(() => render("dose_number", v), JSON.stringify(v)).toThrow(
        /dose_number/,
      );
  });

  test("throws on a number that is not finite, in any column", () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => render("amount_ml", v)).toThrow(/amount_ml/);
      expect(() => render("time", v)).toThrow(/time/);
    }
    expect(() => render("time", 8.64e15 + 1)).toThrow(/time/);
  });

  test("throws on a value that is neither a string nor a number", () => {
    for (const v of [{}, [], 10n, Symbol("x")])
      expect(() => render("notes", v)).toThrow(/notes/);
  });
});

describe("the --resolve-by-email prelude", () => {
  test("a quote, a percent sign or a dollar quote in the address stays inside its literals", () => {
    const email = "o'hara%s$$x@example.com";
    const w = createWriter({ resolveEmail: email });
    w.prelude();
    const sql = w.out.join("\n");
    expect(sql).toContain("WHERE u.email = 'o''hara%s$$x@example.com'");
    // Inside RAISE's format string a quote is doubled for the literal and a
    // percent sign for the format, so neither ends or extends either one.
    expect(sql).toContain(
      "RAISE EXCEPTION 'expected exactly one (user, family) for o''hara%%s$$x@example.com, found %', n;",
    );
    // The DO body is dollar-quoted with a tag of its own, so the address's
    // $$ cannot close it: the tag opens once and closes once.
    const tag = /DO (\$\w*\$)/.exec(sql)?.[1];
    expect(tag).toBeDefined();
    expect(tag).not.toBe("$$");
    expect(sql.split(tag as string)).toHaveLength(3);
  });

  test("refuses an address that contains the DO body's own dollar-quote tag", () => {
    const w = createWriter({ resolveEmail: "a$$b@example.com" });
    w.prelude();
    const tag = /DO (\$\w*\$)/.exec(w.out.join("\n"))?.[1] as string;
    const hostile = createWriter({ resolveEmail: `x${tag}@example.com` });
    expect(() => hostile.prelude()).toThrow(/resolve-by-email/);
  });
});
