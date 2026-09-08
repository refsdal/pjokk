import type { IdleState } from "@/lib/kiosk-screen";
import { cn } from "@/lib/utils";

// 60 % black after two idle minutes; the wake tap lands here and nowhere
// else (spec §7). "waking" keeps swallowing for a few hundred ms so the
// tap can never also press what was underneath.
export function KioskIdleOverlay({
  state,
  onWake,
}: {
  state: IdleState;
  onWake: () => void;
}) {
  if (state === "awake") return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a scrim that swallows the wake tap, not a control
    // biome-ignore lint/a11y/useKeyWithClickEvents: any key press already wakes the screen (useIdle listens on window)
    <div
      data-testid="kiosk-idle"
      data-state={state}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (state === "dim") onWake();
      }}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "fixed inset-0 z-40 bg-black transition-opacity duration-1000",
        state === "dim" ? "opacity-60" : "opacity-0",
      )}
    />
  );
}
