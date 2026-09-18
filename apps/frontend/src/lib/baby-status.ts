import type { Summary } from "@pjokk/shared";

// What the baby is doing right now, for the header ring (2026-09-18):
// sleep purple while a session runs, barnehage green while she is there,
// nothing otherwise. Sleeping first if both — the more immediate thing.
// Read off the summary the screen already loads; no request of its own.
export type BabyStatus = "sleeping" | "daycare";

// Only presence is read, so any object with the two fields will do — the
// unit test hands it stubs.
export function babyStatus(
  s:
    | {
        activeSleep?: Summary["activeSleep"] | { id: string } | null;
        activeDaycare?: Summary["activeDaycare"] | { id: string } | null;
      }
    | undefined,
): BabyStatus | null {
  if (!s) return null;
  if (s.activeSleep) return "sleeping";
  // `?? null`: absent from a snapshot cached before the field existed.
  if (s.activeDaycare ?? null) return "daycare";
  return null;
}

export function statusRing(status: BabyStatus | null): string {
  if (status === "sleeping") return "ring-sleep";
  if (status === "daycare") return "ring-daycare";
  return "ring-accent";
}
