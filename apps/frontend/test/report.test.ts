import { describe, expect, test } from "bun:test";
import { reportFilename } from "../src/lib/report";

describe("reportFilename", () => {
  test("slugs the baby's name and dates the range", () => {
    expect(
      reportFilename(
        "Nora Ø. Hansen",
        new Date(2026, 8, 1),
        new Date(2026, 8, 7),
      ),
    ).toBe("pjokk-nora-o-hansen-2026-09-01-2026-09-07.pdf");
    expect(
      reportFilename("  ", new Date(2026, 0, 1), new Date(2026, 0, 7)),
    ).toBe("pjokk-baby-2026-01-01-2026-01-07.pdf");
  });
});
