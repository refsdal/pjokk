import type { MeasurementType } from "@pjokk/shared";

// The single source of truth for what a measurement type MEANS: its label,
// the canonical unit its value is stored in, and the stepper bounds the log
// sheet uses.
//
// measurement_log has no unit column. A value is always in its type's
// canonical unit — kilograms, centimetres, degrees Celsius — which is what
// makes a future Fahrenheit (or pounds) preference a display concern: it
// converts here, at the edge, and leaves every stored row and the schema
// alone. Do not add a per-row unit; normalise on the way in instead, the way
// scripts/import-sprout-track.mjs converts sprout's lb and in.
//
// This table exists because the knowledge used to be duplicated — the log
// sheet had its own config while the timeline and the CSV export each
// re-derived the unit as `type === "weight" ? "kg" : "cm"`. That reads fine
// with three types and silently exports a temperature as a length with four.
export const measurementMeta: Record<
  MeasurementType,
  {
    label: string;
    unit: string;
    step: number;
    min: number;
    max: number;
    fallback: number;
  }
> = {
  weight: {
    label: "Weight",
    unit: "kg",
    step: 0.1,
    min: 0.5,
    max: 40,
    fallback: 5,
  },
  length: {
    label: "Length",
    unit: "cm",
    step: 0.5,
    min: 30,
    max: 130,
    fallback: 60,
  },
  head: {
    label: "Head",
    unit: "cm",
    step: 0.5,
    min: 25,
    max: 60,
    fallback: 40,
  },
  // 32–43 °C spans the survivable range in both directions, so a mistyped
  // reading is caught by the stepper rather than stored. 37.0 is the resting
  // norm, which is the sane place for the stepper to start.
  temperature: {
    label: "Temperature",
    unit: "°C",
    step: 0.1,
    min: 32,
    max: 43,
    fallback: 37,
  },
};

// 38.0 °C is the standard definition of fever in an infant, and the boundary
// is inclusive. Kept as a named constant because it is a clinical threshold
// rather than a styling choice — if it ever moves, it moves in one place.
export const FEVER_THRESHOLD_C = 38;

export function isFever(type: MeasurementType, value: number): boolean {
  return type === "temperature" && value >= FEVER_THRESHOLD_C;
}

export function formatMeasurement(
  type: MeasurementType,
  value: number,
): string {
  return `${value.toFixed(1)} ${measurementMeta[type].unit}`;
}

// How long a temperature stays on the Home screen. The card answers "is she
// still running a fever", which stops being a live question quickly; the
// timeline is where the history lives. Matching the Last sleep card, which
// also yields once it is no longer the current state.
export const TEMPERATURE_CARD_WINDOW_MS = 24 * 60 * 60 * 1000;

export function showsTemperatureCard(
  time: Date | null,
  now: Date = new Date(),
): boolean {
  if (!time) return false;
  // Lower-bounded at zero rather than compared directly: a reading
  // timestamped a little ahead of the device's clock is skew, not a reason to
  // blank the card.
  const age = Math.max(0, now.getTime() - time.getTime());
  return age <= TEMPERATURE_CARD_WINDOW_MS;
}

// --- the Home card's three-day trend ---

// How far back the card's sparkline looks. Three days is long enough to show
// a fever breaking and short enough that every point is still the same
// illness.
export const TEMPERATURE_TREND_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export type TemperatureTrend = "rising" | "falling" | "flat" | "unknown";
export type TemperatureStatus = "ok" | "caution" | "alarm";

type MeasurementRow = { time: string; type: MeasurementType; value: number };

// Temperatures inside the window, oldest first. The API serves measurements
// newest-first and callers may hold them in either order, so this sorts
// rather than trusting the input.
export function temperaturesInWindow(
  rows: MeasurementRow[],
  now: Date = new Date(),
): MeasurementRow[] {
  const floor = now.getTime() - TEMPERATURE_TREND_WINDOW_MS;
  return rows
    .filter((r) => r.type === "temperature" && Date.parse(r.time) >= floor)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

// Latest versus the one before it. Deliberately NOT a line fit: across three
// days there are usually two or three readings, and a regression over that is
// false precision.
export function temperatureTrend(
  rows: MeasurementRow[],
  now: Date = new Date(),
): TemperatureTrend {
  const inWindow = temperaturesInWindow(rows, now);
  if (inWindow.length < 2) return "unknown";
  const latest = inWindow[inWindow.length - 1]!.value;
  const previous = inWindow[inWindow.length - 2]!.value;
  if (latest > previous) return "rising";
  if (latest < previous) return "falling";
  return "flat";
}

// Below the threshold is fine whatever the direction. A climbing fever is the
// one to react to; an easing one is the one to keep watching. A fever with no
// previous reading is treated as alarm on purpose — an unknown direction is
// not a reassuring one, and rendering it green would be a guess in the
// dangerous direction.
export function temperatureStatus(
  value: number,
  trend: TemperatureTrend,
): TemperatureStatus {
  if (value < FEVER_THRESHOLD_C) return "ok";
  return trend === "falling" || trend === "flat" ? "caution" : "alarm";
}

// Projects the window's readings into an SVG box. Pure, so the awkward cases
// are testable without rendering anything: one reading, and every reading
// identical, both of which divide by zero under a naive min/max scale.
//
// The y-domain ALWAYS contains the fever threshold. A sparkline scaled only
// to its own values is a squiggle with no reference — "below fever" needs
// something to be below — so the threshold line is what gives it meaning.
export function sparklinePoints(
  rows: MeasurementRow[],
  box: { width: number; height: number },
  now: Date = new Date(),
): {
  points: { x: number; y: number; value: number }[];
  thresholdY: number;
} {
  const inWindow = temperaturesInWindow(rows, now);

  const values = inWindow.map((r) => r.value);
  let lo = Math.min(FEVER_THRESHOLD_C, ...values);
  let hi = Math.max(FEVER_THRESHOLD_C, ...values);
  // A degenerate domain (single reading exactly at the threshold, or every
  // reading identical AND equal to it) would scale to NaN. Pad it.
  if (hi - lo < 0.5) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.25;
    hi = mid + 0.25;
  }
  const projectY = (v: number) =>
    box.height - ((v - lo) / (hi - lo)) * box.height;

  const times = inWindow.map((r) => Date.parse(r.time));
  const first = times[0] ?? 0;
  const span = (times[times.length - 1] ?? 0) - first;

  return {
    points: inWindow.map((r, i) => ({
      // A single reading has no span to spread across, so it sits centred
      // rather than at an arbitrary edge.
      x:
        inWindow.length === 1
          ? box.width / 2
          : span === 0
            ? (i / (inWindow.length - 1)) * box.width
            : ((times[i]! - first) / span) * box.width,
      y: projectY(r.value),
      value: r.value,
    })),
    thresholdY: projectY(FEVER_THRESHOLD_C),
  };
}
