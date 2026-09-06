import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { HelpRequest } from "@pjokk/shared";
import {
  HELP_PRESETS,
  helpCardView,
  pickDefaultMember,
  readLastHelpMember,
  writeLastHelpMember,
} from "../src/lib/help-ui";

const base: HelpRequest = {
  id: "h1",
  fromUserId: "anders",
  fromName: "Anders",
  toUserId: "kari",
  toName: "Kari",
  message: "Bring a bottle",
  createdAt: "2026-09-06T10:00:00.000Z",
  acknowledgedAt: null,
  acknowledgedByName: null,
  delivered: 1,
};
const acked: HelpRequest = {
  ...base,
  acknowledgedAt: "2026-09-06T10:03:00.000Z",
  acknowledgedByName: "Kari",
};

describe("helpCardView", () => {
  it("is open with the pulse until acknowledged", () => {
    expect(helpCardView(base, { userId: "kari", isAdmin: false }).state).toBe(
      "open",
    );
    expect(helpCardView(acked, { userId: "kari", isAdmin: false }).state).toBe(
      "acknowledged",
    );
  });

  it("offers 'On my way' to everyone but the sender while open", () => {
    expect(helpCardView(base, { userId: "kari", isAdmin: false }).action).toBe(
      "acknowledge",
    );
    expect(
      helpCardView(base, { userId: "grandma", isAdmin: false }).action,
    ).toBe("acknowledge");
    expect(
      helpCardView(base, { userId: "anders", isAdmin: false }).action,
    ).toBe("cancel");
  });

  it("offers 'Done' to the sender or an admin once acknowledged, nobody else", () => {
    expect(
      helpCardView(acked, { userId: "anders", isAdmin: false }).action,
    ).toBe("done");
    expect(
      helpCardView(acked, { userId: "grandma", isAdmin: true }).action,
    ).toBe("done");
    expect(
      helpCardView(acked, { userId: "grandma", isAdmin: false }).action,
    ).toBeNull();
    expect(
      helpCardView(acked, { userId: "kari", isAdmin: false }).action,
    ).toBeNull();
  });

  it("knows whether the viewer is the target, so the copy can drop 'from Kari'", () => {
    expect(
      helpCardView(base, { userId: "kari", isAdmin: false }).viewerIsTarget,
    ).toBe(true);
    expect(
      helpCardView(base, { userId: "grandma", isAdmin: false }).viewerIsTarget,
    ).toBe(false);
  });

  it("times the card from creation while open and from the answer afterwards", () => {
    expect(
      helpCardView(base, { userId: "kari", isAdmin: false }).at.toISOString(),
    ).toBe(base.createdAt);
    expect(
      helpCardView(acked, { userId: "kari", isAdmin: false }).at.toISOString(),
    ).toBe(acked.acknowledgedAt as string);
  });

  it("carries the answerer's name", () => {
    expect(
      helpCardView(acked, { userId: "anders", isAdmin: false }).ackBy,
    ).toBe("Kari");
    expect(
      helpCardView(base, { userId: "anders", isAdmin: false }).ackBy,
    ).toBeNull();
  });
});

describe("pickDefaultMember", () => {
  const others = [{ memberId: "m-kari" }, { memberId: "m-grandma" }];
  it("prefers the last-picked member when they are still in the family", () => {
    expect(pickDefaultMember(others, "m-grandma")).toBe("m-grandma");
  });
  it("ignores a stale last pick", () => {
    expect(pickDefaultMember(others, "m-gone")).toBeNull();
  });
  it("picks the only other member automatically", () => {
    expect(pickDefaultMember([{ memberId: "m-kari" }], null)).toBe("m-kari");
  });
  it("picks nobody when there is a real choice and no history", () => {
    expect(pickDefaultMember(others, null)).toBeNull();
  });
});

describe("last-picked member storage", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("remembers per family", () => {
    writeLastHelpMember("fam-1", "m-kari");
    writeLastHelpMember("fam-2", "m-ola");
    expect(readLastHelpMember("fam-1")).toBe("m-kari");
    expect(readLastHelpMember("fam-2")).toBe("m-ola");
    expect(readLastHelpMember("fam-3")).toBeNull();
  });

  it("survives a missing or broken storage", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(() => writeLastHelpMember("fam-1", "m-kari")).not.toThrow();
    expect(readLastHelpMember("fam-1")).toBeNull();
  });

  it("survives a stored value that parses but isn't an object", () => {
    store.set("pjokk.help.lastMember", "null");
    expect(() => readLastHelpMember("fam-1")).not.toThrow();
    expect(readLastHelpMember("fam-1")).toBeNull();
  });
});

describe("presets", () => {
  it("are the three one-tap messages, in order", () => {
    expect([...HELP_PRESETS]).toEqual([
      "Come here",
      "Bring a bottle",
      "Take over",
    ]);
  });
});
