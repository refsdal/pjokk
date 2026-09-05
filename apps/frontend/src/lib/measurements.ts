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
