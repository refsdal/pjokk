// Central entitlement gate. Every feature gate routes through this.
// The map exists so a future plan matrix is a data change, not a refactor.
export type Feature =
  | "growthCharts"
  | "apiKeys"
  | "csvExport"
  | "statsMonth"
  | "otherActivities"
  | "multipleBabies";

const requiresPremium: Record<Feature, boolean> = {
  growthCharts: true,
  apiKeys: true,
  csvExport: true,
  statsMonth: true,
  otherActivities: true,
  multipleBabies: true,
};

export function canUse(family: { plan: string }, feature: Feature): boolean {
  if (!requiresPremium[feature]) return true;
  return family.plan !== "free";
}
