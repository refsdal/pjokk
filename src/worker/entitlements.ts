// Central entitlement gate. Every future feature gate routes through this —
// today every family is on the free plan and everything is allowed.
export type Feature = "core";

export function canUse(_family: { plan: string }, _feature: Feature): boolean {
  return true;
}
