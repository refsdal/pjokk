import { describe, expect, test } from "bun:test";
import { syncAppBadge } from "../src/lib/badge";

describe("syncAppBadge", () => {
  test("sets a dot while active and clears it after", async () => {
    const calls: string[] = [];
    const host = {
      setAppBadge: async () => {
        calls.push("set");
      },
      clearAppBadge: async () => {
        calls.push("clear");
      },
    };
    expect(await syncAppBadge(true, host)).toBe(true);
    expect(await syncAppBadge(false, host)).toBe(true);
    expect(calls).toEqual(["set", "clear"]);
  });

  test("is a no-op without the API, and swallows a refusal", async () => {
    expect(await syncAppBadge(true, {})).toBe(false);
    expect(await syncAppBadge(true, undefined)).toBe(false);
    const refusing = {
      setAppBadge: async () => {
        throw new Error("NotAllowedError");
      },
      clearAppBadge: async () => {},
    };
    expect(await syncAppBadge(true, refusing)).toBe(false);
  });
});
