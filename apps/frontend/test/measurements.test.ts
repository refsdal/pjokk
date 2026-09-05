import { describe, expect, it } from "bun:test";
import { measurementTypes } from "@pjokk/shared";
import {
  FEVER_THRESHOLD_C,
  formatMeasurement,
  isFever,
  measurementMeta,
  showsTemperatureCard,
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
