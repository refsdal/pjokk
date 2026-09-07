import { describe, expect, test } from "bun:test";
import { errorMessage } from "../src/lib/errors";

describe("errorMessage", () => {
  test("uses an Error's message, then its name", () => {
    expect(errorMessage(new TypeError("boom"))).toBe("boom");
    expect(errorMessage(new RangeError(""))).toBe("RangeError");
  });
  test("renders strings and other values", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage({ code: 7 })).toBe('{"code":7}');
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
