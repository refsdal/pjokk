import { describe, expect, it } from "bun:test";
import type { VaccineLog } from "@pjokk/shared";
import {
  buildSchedule,
  infoUrlForName,
  infoUrlForSlot,
  offProgramme,
  vaccineProgramme,
} from "../src/lib/vaccine-programme";

const entry = (over: Partial<VaccineLog>): VaccineLog => ({
  id: "v1",
  babyId: "b1",
  caretakerId: "u1",
  caretakerName: "Parent",
  time: "2026-01-01T10:00:00.000Z",
  name: "MMR",
  doseNumber: 1,
  scheduleSlot: null,
  notes: null,
  documents: [],
  ...over,
});

const BIRTH = new Date("2026-01-01T00:00:00.000Z");
const at = (months: number) =>
  new Date(BIRTH.getTime() + months * 30.436875 * 24 * 3600_000);

describe("vaccine programme overlay", () => {
  it("has unique slot keys", () => {
    const keys = vaccineProgramme.slots.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("marks a slot given when an entry names it explicitly", () => {
    const rows = buildSchedule(
      BIRTH,
      [entry({ scheduleSlot: "mmr:1" })],
      [],
      at(20),
    );
    const mmr = rows.find((r) => r.slot.key === "mmr:1")!;
    expect(mmr.status).toBe("given");
    expect(mmr.entry?.id).toBe("v1");
  });

  it("matches a hand-typed entry by name and dose", () => {
    const rows = buildSchedule(
      BIRTH,
      // No slot key — the shape an import or a free-form log produces.
      [entry({ scheduleSlot: null, name: "mmr", doseNumber: 1 })],
      [],
      at(20),
    );
    expect(rows.find((r) => r.slot.key === "mmr:1")!.status).toBe("given");
  });

  it("does not let one entry fill two doses of the same vaccine", () => {
    const rows = buildSchedule(
      BIRTH,
      [entry({ scheduleSlot: null, name: "MMR", doseNumber: 1 })],
      [],
      at(200),
    );
    expect(rows.find((r) => r.slot.key === "mmr:1")!.status).toBe("given");
    expect(rows.find((r) => r.slot.key === "mmr:2")!.status).toBe("due");
  });

  it("separates due from upcoming by the baby's age", () => {
    const rows = buildSchedule(BIRTH, [], [], at(4));
    // 3-month slots have come round; the 5-month ones have not.
    expect(rows.find((r) => r.slot.key === "dtp-ipv-hib-hepb:1")!.status).toBe(
      "due",
    );
    expect(rows.find((r) => r.slot.key === "dtp-ipv-hib-hepb:2")!.status).toBe(
      "upcoming",
    );
  });

  it("lists an off-programme vaccine separately instead of dropping it", () => {
    const yellowFever = entry({
      id: "v2",
      name: "Yellow fever",
      doseNumber: 1,
      scheduleSlot: null,
    });
    const entries = [entry({ scheduleSlot: "mmr:1" }), yellowFever];
    const schedule = buildSchedule(BIRTH, entries, [], at(20));
    expect(offProgramme(entries, schedule).map((e) => e.id)).toEqual(["v2"]);
  });

  it("never reports an entry as both scheduled and off-programme", () => {
    const entries = [entry({ scheduleSlot: "mmr:1" })];
    const schedule = buildSchedule(BIRTH, entries, [], at(20));
    expect(offProgramme(entries, schedule)).toEqual([]);
  });

  it("marks a dismissed slot dismissed instead of due", () => {
    const rows = buildSchedule(BIRTH, [], ["mmr:1"], at(20));
    expect(rows.find((r) => r.slot.key === "mmr:1")!.status).toBe("dismissed");
    // Its neighbours are untouched.
    expect(rows.find((r) => r.slot.key === "mmr:2")!.status).toBe("upcoming");
  });

  it("lets a logged dose beat a dismissal, so no row is in two lists", () => {
    const rows = buildSchedule(
      BIRTH,
      [entry({ scheduleSlot: "mmr:1" })],
      ["mmr:1"],
      at(20),
    );
    expect(rows.find((r) => r.slot.key === "mmr:1")!.status).toBe("given");
    expect(rows.filter((r) => r.status === "dismissed")).toEqual([]);
  });

  it("ignores a dismissal whose slot no longer exists in the programme", () => {
    const rows = buildSchedule(BIRTH, [], ["something:99"], at(20));
    expect(rows.filter((r) => r.status === "dismissed")).toEqual([]);
  });
});

describe("FHI info links", () => {
  it("gives every programme slot a source link", () => {
    for (const slot of vaccineProgramme.slots) {
      expect(infoUrlForSlot(slot.key), `no FHI link for ${slot.key}`).toMatch(
        /^https:\/\/www\.fhi\.no\//,
      );
    }
  });

  it("points every vaccine at fhi.no over https", () => {
    for (const [key, v] of Object.entries(vaccineProgramme.vaccines)) {
      expect(v.infoUrl, key).toMatch(
        /^https:\/\/www\.fhi\.no\/va\/vaksiner-barn\//,
      );
    }
  });

  it("resolves a hand-typed vaccine name to the same page", () => {
    expect(infoUrlForName("MMR")).toBe(infoUrlForSlot("mmr:1"));
    expect(infoUrlForName("  mmr ")).toBe(infoUrlForSlot("mmr:1"));
  });

  it("returns null rather than guessing for anything off-programme", () => {
    expect(infoUrlForName("Yellow fever")).toBeNull();
    expect(infoUrlForSlot(null)).toBeNull();
    expect(infoUrlForSlot("nonexistent:1")).toBeNull();
  });

  it("keeps every slot pointing at a vaccine that exists", () => {
    for (const slot of vaccineProgramme.slots) {
      expect(
        vaccineProgramme.vaccines[slot.vaccine],
        `slot ${slot.key} references unknown vaccine ${slot.vaccine}`,
      ).toBeDefined();
      // The key's prefix is what infoUrlForSlot looks up, so they must agree.
      expect(slot.key.split(":")[0]).toBe(slot.vaccine);
    }
  });
});
