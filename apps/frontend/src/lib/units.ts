import type { MeasurementType } from "@pjokk/shared";
import { useMe } from "./data/family";
import { measurementMeta } from "./measurements";

// Display units (issue #53). Every stored value is metric — ml, kg, cm, °C
// (lib/measurements.ts) — and this module is the ONLY place the imperial
// view is derived: what a card prints, what a stepper shows and how a
// stepped value goes back to the canonical number. Sheets keep canonical
// state and convert only what the user touched, so an untouched prefill
// of 120 ml is saved as 120 ml, never as 121 after a round trip.

export type Units = "metric" | "imperial";

export const ML_PER_OZ = 29.5735;
export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;

/** The signed-in person's preference; metric until /api/me has answered. */
export function useUnits(): Units {
  const me = useMe();
  return me.data?.units === "imperial" ? "imperial" : "metric";
}

const round = (v: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

/** A stepper's view of one canonical quantity. */
export type DisplayScale = {
  unit: string;
  decimals: number;
  step: number;
  min: number;
  max: number;
  toDisplay: (canonical: number) => number;
  toCanonical: (display: number) => number;
};

/** Bottle / pump volumes: ml, or fl oz in 0.5 oz steps. */
export function volumeScale(units: Units): DisplayScale {
  if (units === "imperial") {
    return {
      unit: "oz",
      decimals: 1,
      step: 0.5,
      min: 0.5,
      max: 17,
      toDisplay: (ml) => round(ml / ML_PER_OZ, 1),
      toCanonical: (oz) => Math.round(oz * ML_PER_OZ),
    };
  }
  return {
    unit: "ml",
    decimals: 0,
    step: 10,
    min: 5,
    max: 500,
    toDisplay: (ml) => ml,
    toCanonical: (ml) => Math.round(ml),
  };
}

/** A measurement type's stepper: the canonical scale from measurementMeta,
 *  or its imperial counterpart with a step the same size in the hand. */
export function measurementScale(
  type: MeasurementType,
  units: Units,
): DisplayScale {
  const meta = measurementMeta[type];
  if (units === "metric") {
    return {
      unit: meta.unit,
      decimals: 1,
      step: meta.step,
      min: meta.min,
      max: meta.max,
      toDisplay: (v) => v,
      toCanonical: (v) => round(v, type === "weight" ? 2 : 1),
    };
  }
  switch (type) {
    case "weight":
      return {
        unit: "lb",
        decimals: 1,
        step: 0.1,
        min: round(meta.min / KG_PER_LB, 1),
        max: round(meta.max / KG_PER_LB, 1),
        toDisplay: (kg) => round(kg / KG_PER_LB, 1),
        toCanonical: (lb) => round(lb * KG_PER_LB, 2),
      };
    case "temperature":
      return {
        unit: "°F",
        decimals: 1,
        step: 0.1,
        min: round(cToF(meta.min), 1),
        max: round(cToF(meta.max), 1),
        toDisplay: (c) => round(cToF(c), 1),
        toCanonical: (f) => round(((f - 32) * 5) / 9, 1),
      };
    default:
      return {
        unit: "in",
        decimals: 2,
        step: 0.25,
        min: round(meta.min / CM_PER_IN, 2),
        max: round(meta.max / CM_PER_IN, 2),
        toDisplay: (cm) => round(cm / CM_PER_IN, 2),
        toCanonical: (inch) => round(inch * CM_PER_IN, 1),
      };
  }
}

export function cToF(c: number): number {
  return (c * 9) / 5 + 32;
}

/** "120 ml" / "4.1 oz". */
export function formatVolume(ml: number, units: Units): string {
  const s = volumeScale(units);
  return `${s.toDisplay(ml).toFixed(s.decimals)} ${s.unit}`;
}

/** "3.2 kg" / "7.1 lb", "38.4 °C" / "101.1 °F", "52.0 cm" / "20.47 in". */
export function formatMeasurementIn(
  type: MeasurementType,
  value: number,
  units: Units,
): string {
  const s = measurementScale(type, units);
  return `${s.toDisplay(value).toFixed(s.decimals)} ${s.unit}`;
}

/** The unit word alone, for labels like "Weight (lb)". */
export function measurementUnit(type: MeasurementType, units: Units): string {
  return measurementScale(type, units).unit;
}
