import { describe, expect, it } from "bun:test";
import { moreActions } from "../src/components/sheets/OtherLogSheet";

// One data source for the More sheet (phone) and Home's unfolded tiles
// (tablet, desktop — spec §4): a new activity kind must show up in both
// without a second edit, and in the same order.
describe("moreActions", () => {
  const calls: string[] = [];
  const actions = moreActions({
    onPick: (kind) => calls.push(`pick:${kind}`),
    onPickPlay: (type) => calls.push(`play:${type}`),
    onPickHelp: () => calls.push("help"),
    onVaccines: () => calls.push("vaccines"),
  });

  it("lists the six kinds, the three play types, vaccines and help, in that order", () => {
    expect(actions.map((a) => a.key)).toEqual([
      "medicine",
      "bath",
      "note",
      "milestone",
      "measurement",
      "pump",
      "play:tummy",
      "play:walk",
      "play:play",
      "vaccines",
      "help",
    ]);
  });

  it("routes each pick to the right handler", () => {
    calls.length = 0;
    for (const a of actions) a.pick();
    expect(calls).toEqual([
      "pick:medicine",
      "pick:bath",
      "pick:note",
      "pick:milestone",
      "pick:measurement",
      "pick:pump",
      "play:tummy",
      "play:walk",
      "play:play",
      "vaccines",
      "help",
    ]);
  });

  it("carries a label, icon and tint for every tile", () => {
    for (const a of actions) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(typeof a.icon).toBe("object");
      expect(a.tint.startsWith("text-")).toBe(true);
    }
  });
});
