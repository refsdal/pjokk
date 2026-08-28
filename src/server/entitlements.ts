// Central entitlement gate. Every feature gate routes through this.
// The map exists so a future plan matrix is a data change, not a refactor.
export type Feature =
  | "growthCharts"
  | "apiKeys"
  | "csvExport"
  | "statsMonth"
  | "otherActivities"
  | "multipleBabies"
  | "calendar"
  | "contacts"
  | "play"
  | "vaccineDocuments";

const requiresPremium: Record<Feature, boolean> = {
  growthCharts: true,
  apiKeys: true,
  // Free, deliberately: the export is how a family exercises their GDPR
  // right of access and portability, and that cannot be charged for.
  // Keeping the key (rather than deleting the gate) so the decision is
  // visible here rather than looking like an oversight.
  csvExport: false,
  statsMonth: true,
  otherActivities: true,
  multipleBabies: true,
  calendar: true,
  contacts: true,
  play: true,
  vaccineDocuments: true,
};

export function canUse(family: { plan: string }, feature: Feature): boolean {
  if (!requiresPremium[feature]) return true;
  return family.plan !== "free";
}
