import { describe, expect, it } from "bun:test";
import { pinPadReducer } from "../src/lib/kiosk-ui";

// Leaving is checked by the server now (spec 2026-09-10-kiosk-devices §6),
// so the pad can hear more than "wrong": too many tries, no connection. A
// message clears the digits and shows the text, and — unlike a wrong PIN —
// does not count towards the pad's own lockout.
describe("pinPadReducer message", () => {
  it("clears the digits and shows the text without counting a wrong try", () => {
    const s = pinPadReducer(
      { digits: "1234", wrong: 1, error: null },
      { type: "message", text: "Leaving needs a connection" },
      4,
    );
    expect(s).toEqual({
      digits: "",
      wrong: 1,
      error: "Leaving needs a connection",
    });
  });
});
