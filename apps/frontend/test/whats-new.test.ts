import { describe, expect, it } from "bun:test";
import type { Feature } from "@pjokk/shared";
import { IconSparkles } from "@tabler/icons-react";
import { highestSeq, pending, type WhatsNewEntry } from "../src/lib/whats-new";

// What's new (issue #140): which entries a person is shown, and what
// dismissal marks. The nag must never repeat, and must never announce a
// feature the family has switched off.
const entry = (seq: number, feature?: Feature): WhatsNewEntry => ({
  seq,
  version: `v0.${seq}.0`,
  title: `Entry ${seq}`,
  body: "Body",
  feature,
  icon: IconSparkles,
  tint: "text-accent",
});

const all = () => true;
const none = () => false;

describe("pending", () => {
  it("returns only entries newer than the marker, newest first", () => {
    const got = pending([entry(1), entry(2), entry(3)], 1, all);
    expect(got.map((e) => e.seq)).toEqual([3, 2]);
  });

  it("is exclusive at the boundary", () => {
    expect(pending([entry(5)], 5, all)).toEqual([]);
  });

  it("drops an entry whose feature the family does not track", () => {
    const got = pending(
      [entry(1), entry(2, "daycare")],
      0,
      (k) => k !== "daycare",
    );
    expect(got.map((e) => e.seq)).toEqual([1]);
  });

  it("keeps an entry with no feature even when nothing is tracked", () => {
    const got = pending([entry(1)], 0, none);
    expect(got.map((e) => e.seq)).toEqual([1]);
  });

  it("is empty for an empty catalogue", () => {
    expect(pending([], 0, all)).toEqual([]);
  });
});

describe("highestSeq", () => {
  it("is 0 for an empty catalogue", () => {
    expect(highestSeq([])).toBe(0);
  });

  it("counts entries the family cannot see", () => {
    // Dismissal must mark the filtered-out entry seen too: otherwise
    // switching barnehage on six months later replays a stale
    // announcement as though it were news.
    expect(highestSeq([entry(1), entry(9, "daycare")])).toBe(9);
  });
});
