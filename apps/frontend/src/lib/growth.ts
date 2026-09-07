import whoHead from "@/data/who-head-for-age-lms.json";
import whoLength from "@/data/who-length-for-age-lms.json";
import whoWeight from "@/data/who-weight-for-age-lms.json";

// WHO Child Growth Standards, 0–60 months, for the three growth measures
// Pjokk logs: weight-for-age, length/height-for-age, head-circumference-
// for-age. One LMS method for all three — z = ((value/M)^L − 1) / (L·S),
// percentile = Φ(z) — over three bundled, cited tables (data/who-*-lms.json;
// real, sourced data, never from memory — see DECISIONS.md Phase 7). Issue
// #47 added length and head next to the original weight table.

export type BabySex = "girl" | "boy";
export type GrowthType = "weight" | "length" | "head";

type LmsRow = [l: number, m: number, s: number];

const tables: Record<GrowthType, Record<BabySex, LmsRow[]>> = {
  weight: { boy: whoWeight.boy as LmsRow[], girl: whoWeight.girl as LmsRow[] },
  length: { boy: whoLength.boy as LmsRow[], girl: whoLength.girl as LmsRow[] },
  head: { boy: whoHead.boy as LmsRow[], girl: whoHead.girl as LmsRow[] },
};

export function ageInMonths(birthDate: Date, at = new Date()): number {
  return (at.getTime() - birthDate.getTime()) / (30.4375 * 24 * 3600_000);
}

function lmsAt(
  type: GrowthType,
  sex: BabySex,
  ageMonths: number,
): LmsRow | null {
  const table = tables[type][sex];
  if (ageMonths < 0 || ageMonths > table.length - 1) return null;
  const lo = Math.floor(ageMonths);
  const hi = Math.min(lo + 1, table.length - 1);
  const f = ageMonths - lo;
  const [l0, m0, s0] = table[lo]!;
  const [l1, m1, s1] = table[hi]!;
  return [l0 + (l1 - l0) * f, m0 + (m1 - m0) * f, s0 + (s1 - s0) * f];
}

// Abramowitz–Stegun 7.1.26 erf approximation (|error| < 1.5e-7).
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Percentile (0–100) of a measurement in its canonical unit (kg or cm),
 *  or null outside the 0–60 month table. */
export function growthPercentile(
  type: GrowthType,
  sex: BabySex,
  ageMonths: number,
  value: number,
): number | null {
  const lms = lmsAt(type, sex, ageMonths);
  if (!lms || value <= 0) return null;
  const [l, m, s] = lms;
  const z =
    l !== 0 ? ((value / m) ** l - 1) / (l * s) : Math.log(value / m) / s;
  return normalCdf(z) * 100;
}

/** The value (kg or cm) at a given z-score on a reference curve. */
export function referenceValue(
  type: GrowthType,
  sex: BabySex,
  ageMonths: number,
  z: number,
): number | null {
  const lms = lmsAt(type, sex, ageMonths);
  if (!lms) return null;
  const [l, m, s] = lms;
  return l !== 0 ? m * (1 + l * s * z) ** (1 / l) : m * Math.exp(s * z);
}

/** Weight-for-age, as the Stats weight row has always called it. */
export function weightPercentile(
  sex: BabySex,
  ageMonths: number,
  weightKg: number,
): number | null {
  return growthPercentile("weight", sex, ageMonths, weightKg);
}

export function referenceWeight(
  sex: BabySex,
  ageMonths: number,
  z: number,
): number | null {
  return referenceValue("weight", sex, ageMonths, z);
}

/** z-scores for the P3 / P50 / P97 reference lines. */
export const referenceCurves = [
  { label: "P3", z: -1.8808 },
  { label: "P50", z: 0 },
  { label: "P97", z: 1.8808 },
] as const;

export function formatPercentile(p: number): string {
  if (p < 1) return "<1";
  if (p > 99) return ">99";
  return String(Math.round(p));
}
