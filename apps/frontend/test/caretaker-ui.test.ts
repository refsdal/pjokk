import { describe, expect, it } from "bun:test";
import type { Member } from "@pjokk/shared";
import {
  caretakerField,
  caretakerOptions,
  firstName,
  loggedByLine,
} from "../src/lib/caretaker-ui";

// Who did the care (spec 2026-09-14-who-did-it): the pure half of the
// sheets' caretaker chips.

const member = (userId: string, name: string, email = `${userId}@x.no`) =>
  ({
    memberId: `m-${userId}`,
    userId,
    name,
    email,
    role: "member",
    avatarUrl: null,
    hasPush: false,
  }) as Member;

describe("caretakerField", () => {
  it("sends nothing until a chip is tapped", () => {
    expect(caretakerField(null, "me")).toEqual({});
  });
  it("sends nothing for a tap back to the default", () => {
    expect(caretakerField("me", "me")).toEqual({});
    expect(caretakerField("u2", "u2")).toEqual({});
  });
  it("sends the partner when chosen over the default", () => {
    expect(caretakerField("u2", "me")).toEqual({ caretakerId: "u2" });
  });
  it("sends the choice even before the default is known", () => {
    // Offline cold start: me may not have loaded. A deliberate tap still
    // counts; the server refuses a stranger regardless.
    expect(caretakerField("u2", null)).toEqual({ caretakerId: "u2" });
  });
});

describe("caretakerOptions", () => {
  it("puts yourself first and keeps the family's order after", () => {
    const faces = [
      member("u2", "Bo"),
      member("me", "Anne"),
      member("u3", "Mo"),
    ];
    expect(caretakerOptions(faces, "me").map((m) => m.userId)).toEqual([
      "me",
      "u2",
      "u3",
    ]);
  });
  it("leaves the order alone without a self", () => {
    const faces = [member("u2", "Bo"), member("u3", "Mo")];
    expect(caretakerOptions(faces, null)).toBe(faces);
  });
});

describe("firstName", () => {
  it("is the first word of the name", () => {
    expect(firstName(member("u1", "Anne Marie Hansen"))).toBe("Anne");
  });
  it("falls back to the address before the @ for a nameless account", () => {
    expect(firstName(member("u1", "  ", "bo.h@example.com"))).toBe("bo.h");
  });
});

describe("loggedByLine", () => {
  const edit = { loggedById: "me", loggedByName: "Anne Admin" };
  it("says nothing on a create", () => {
    expect(loggedByLine(null, "me")).toBeNull();
  });
  it("says nothing when the chips name the person who logged it", () => {
    expect(loggedByLine(edit, "me")).toBeNull();
  });
  it("names the logger when the chips name somebody else", () => {
    expect(loggedByLine(edit, "u2")).toBe("Anne Admin");
  });
  it("says nothing before the chips know who is shown", () => {
    expect(loggedByLine(edit, null)).toBeNull();
  });
});
