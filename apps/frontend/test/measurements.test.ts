import { describe, expect, it } from "bun:test";
import { measurementTypes } from "@pjokk/shared";
import {
  FEVER_THRESHOLD_C,
  formatMeasurement,
  isFever,
  measurementMeta,
  showsTemperatureCard,
  sparklinePoints,
  temperatureStatus,
  temperatureTrend,
} from "../src/lib/measurements";

// measurement_log stores no unit column: every value is in the CANONICAL unit
// for its type, and this table is the single place that knowledge lives. It
// used to be duplicated as `type === "weight" ? "kg" : "cm"` in the timeline
// and the CSV export, which silently exported temperatures as centimetres.
describe("measurement units", () => {
  it("gives each type its canonical unit", () => {
    expect(measurementMeta.weight.unit).toBe("kg");
    expect(measurementMeta.length.unit).toBe("cm");
    expect(measurementMeta.head.unit).toBe("cm");
    expect(measurementMeta.temperature.unit).toBe("°C");
  });

  it("covers every type the wire can carry", () => {
    for (const type of measurementTypes) {
      expect(measurementMeta[type]).toBeDefined();
    }
    expect(Object.keys(measurementMeta).sort()).toEqual(
      [...measurementTypes].sort(),
    );
  });

  it("formats a value with its unit at one decimal", () => {
    expect(formatMeasurement("temperature", 39.4)).toBe("39.4 °C");
    expect(formatMeasurement("weight", 8.4)).toBe("8.4 kg");
    expect(formatMeasurement("head", 43.5)).toBe("43.5 cm");
  });
});

// 38.0 °C is the standard definition of fever in an infant. The boundary is
// inclusive, and the check is meaningless for the growth types — a 39 kg
// toddler is not running a temperature.
describe("fever", () => {
  it("starts at 38.0 °C inclusive", () => {
    expect(FEVER_THRESHOLD_C).toBe(38);
    expect(isFever("temperature", 37.9)).toBe(false);
    expect(isFever("temperature", 38)).toBe(true);
    expect(isFever("temperature", 39.4)).toBe(true);
  });

  it("is never true for a non-temperature measurement", () => {
    expect(isFever("weight", 39.4)).toBe(false);
    expect(isFever("length", 70.4)).toBe(false);
    expect(isFever("head", 43.5)).toBe(false);
  });
});

// The Home card is for "is she still running a fever right now", not for
// history — the timeline holds that. So it appears only while a reading is
// recent, the way the Last sleep card yields once a new sleep starts.
// Without a window, a temperature taken in March sits on the home screen in
// July, spending permanent space on something that matters a few days a year.
describe("the Home temperature card's window", () => {
  const now = new Date("2026-09-05T12:00:00Z");
  const at = (hoursAgo: number) =>
    new Date(now.getTime() - hoursAgo * 3600_000);

  it("shows a reading from the last 24 hours", () => {
    expect(showsTemperatureCard(at(0), now)).toBe(true);
    expect(showsTemperatureCard(at(23.9), now)).toBe(true);
  });

  it("hides one older than 24 hours", () => {
    expect(showsTemperatureCard(at(24.1), now)).toBe(false);
    expect(showsTemperatureCard(at(24 * 30), now)).toBe(false);
  });

  it("hides when nothing was ever recorded", () => {
    expect(showsTemperatureCard(null, now)).toBe(false);
  });

  // Clock skew between the device and the server must not blank the card.
  it("shows a reading timestamped slightly in the future", () => {
    expect(showsTemperatureCard(at(-0.5), now)).toBe(true);
  });
});

// --- trend, status and the sparkline behind the Home card ---

const reading = (hoursAgo: number, value: number) => ({
  time: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(),
  type: "temperature" as const,
  value,
});
const NOW = new Date("2026-09-05T12:00:00Z");

// The trend compares the latest reading to the one before it. Not a line fit:
// with two or three readings across three days, a regression is false
// precision dressed up as rigour.
describe("temperatureTrend", () => {
  it("is rising when the latest reading is higher than the previous", () => {
    expect(temperatureTrend([reading(5, 38.9), reading(20, 38.1)], NOW)).toBe(
      "rising",
    );
  });

  it("is falling when the latest is lower", () => {
    expect(temperatureTrend([reading(5, 38.1), reading(20, 39.2)], NOW)).toBe(
      "falling",
    );
  });

  it("is flat when the latest equals the previous", () => {
    expect(temperatureTrend([reading(5, 38.4), reading(20, 38.4)], NOW)).toBe(
      "flat",
    );
  });

  it("is unknown with fewer than two readings", () => {
    expect(temperatureTrend([reading(2, 39.4)], NOW)).toBe("unknown");
    expect(temperatureTrend([], NOW)).toBe("unknown");
  });

  it("reads chronologically regardless of the order given", () => {
    // The API serves measurements newest-first; a caller may sort otherwise.
    const rising = [reading(20, 38.1), reading(5, 38.9)];
    expect(temperatureTrend(rising, NOW)).toBe("rising");
  });

  it("ignores readings older than the three-day window", () => {
    // The older reading is out of range, so only one remains in-window.
    expect(temperatureTrend([reading(5, 39.4), reading(100, 37.0)], NOW)).toBe(
      "unknown",
    );
  });

  it("ignores measurements that are not temperatures", () => {
    const mixed = [
      reading(5, 38.9),
      { time: reading(6, 0).time, type: "weight" as const, value: 8.4 },
      reading(20, 38.1),
    ];
    expect(temperatureTrend(mixed, NOW)).toBe("rising");
  });
});

// Below fever is fine whatever the direction. A fever that is climbing is the
// one worth reacting to; a fever that is easing is worth watching. A fever
// whose direction is unknown must NOT read as reassuring.
describe("temperatureStatus", () => {
  it("is ok below the fever threshold", () => {
    expect(temperatureStatus(37.2, "rising")).toBe("ok");
    expect(temperatureStatus(37.9, "rising")).toBe("ok");
  });

  it("is alarm for a rising fever", () => {
    expect(temperatureStatus(38, "rising")).toBe("alarm");
    expect(temperatureStatus(39.4, "rising")).toBe("alarm");
  });

  it("is caution for a fever that is easing or steady", () => {
    expect(temperatureStatus(38.6, "falling")).toBe("caution");
    expect(temperatureStatus(38.6, "flat")).toBe("caution");
  });

  it("is alarm for a fever with only one reading", () => {
    expect(temperatureStatus(39.4, "unknown")).toBe("alarm");
  });
});

// The sparkline is hand-rolled SVG, so the projection is the part worth
// testing: a bare squiggle with no reference tells you nothing, and the
// degenerate inputs (one point, every value identical) are exactly where a
// naive min/max scale divides by zero.
describe("sparklinePoints", () => {
  const box = { width: 64, height: 24 };

  it("always includes the fever threshold in the y-domain", () => {
    // All readings well below 38 — the threshold must still be on the chart,
    // otherwise "below fever" has nothing to be below.
    const pts = sparklinePoints(
      [reading(40, 36.8), reading(5, 37.1)],
      box,
      NOW,
    );
    expect(pts.thresholdY).toBeGreaterThanOrEqual(0);
    expect(pts.thresholdY).toBeLessThanOrEqual(box.height);
  });

  it("puts the newest reading at the right edge and the oldest at the left", () => {
    const pts = sparklinePoints([reading(60, 37), reading(2, 39)], box, NOW);
    expect(pts.points[0]!.x).toBe(0);
    expect(pts.points[pts.points.length - 1]!.x).toBe(box.width);
  });

  it("draws a higher temperature further up (smaller y)", () => {
    const pts = sparklinePoints([reading(60, 37), reading(2, 39)], box, NOW);
    expect(pts.points[1]!.y).toBeLessThan(pts.points[0]!.y);
  });

  it("centres a single reading rather than dividing by zero", () => {
    const pts = sparklinePoints([reading(2, 39.4)], box, NOW);
    expect(pts.points).toHaveLength(1);
    for (const p of pts.points) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("survives readings that are all identical", () => {
    const pts = sparklinePoints(
      [reading(60, 38.2), reading(30, 38.2), reading(2, 38.2)],
      box,
      NOW,
    );
    for (const p of pts.points) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("is empty when there is nothing in the window", () => {
    expect(sparklinePoints([], box, NOW).points).toHaveLength(0);
  });
});
