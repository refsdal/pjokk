import whoLms from "@/data/who-weight-for-age-lms.json";

// WHO Child Growth Standards, weight-for-age (0–60 months). LMS method:
// z = ((value/M)^L − 1) / (L·S), percentile = Φ(z).

export type BabySex = "girl" | "boy";

type LmsRow = [l: number, m: number, s: number];

const tables: Record<BabySex, LmsRow[]> = {
  boy: whoLms.boy as LmsRow[],
  girl: whoLms.girl as LmsRow[],
};

export function ageInMonths(birthDate: Date, at = new Date()): number {
  return (at.getTime() - birthDate.getTime()) / (30.4375 * 24 * 3600_000);
}

function lmsAt(sex: BabySex, ageMonths: number): LmsRow | null {
  const table = tables[sex];
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

/** Percentile (0–100) of a weight in kg, or null outside the 0–60 mo table. */
export function weightPercentile(
  sex: BabySex,
  ageMonths: number,
  weightKg: number,
): number | null {
  const lms = lmsAt(sex, ageMonths);
  if (!lms || weightKg <= 0) return null;
  const [l, m, s] = lms;
  const z =
    l !== 0 ? ((weightKg / m) ** l - 1) / (l * s) : Math.log(weightKg / m) / s;
  return normalCdf(z) * 100;
}

/** The weight (kg) at a given z-score for a reference curve. */
export function referenceWeight(
  sex: BabySex,
  ageMonths: number,
  z: number,
): number | null {
  const lms = lmsAt(sex, ageMonths);
  if (!lms) return null;
  const [l, m, s] = lms;
  return l !== 0 ? m * (1 + l * s * z) ** (1 / l) : m * Math.exp(s * z);
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
