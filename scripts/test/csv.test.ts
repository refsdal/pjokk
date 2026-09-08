import { describe, expect, test } from "bun:test";
import { parseCsv } from "../lib/csv.mjs";

describe("parseCsv", () => {
  test("quoted fields, doubled quotes, embedded newlines and CRLF", () => {
    const { headers, rows } = parseCsv(
      'a,b,c\r\n1,"x, y","he said ""hi"""\r\n2,"multi\nline",\r\n',
    );
    expect(headers).toEqual(["a", "b", "c"]);
    expect(rows).toEqual([
      { a: "1", b: "x, y", c: 'he said "hi"' },
      { a: "2", b: "multi\nline", c: "" },
    ]);
  });
  test("a BOM and blank lines are ignored", () => {
    expect(parseCsv("\ufeffid,name\n\n1,Nora\n").rows).toEqual([
      { id: "1", name: "Nora" },
    ]);
  });
});
