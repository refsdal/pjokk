import { IconX } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { Drawer } from "vaul";
import { t } from "@/lib/i18n";
import { type Tier, useTier } from "@/lib/layout";
import { cn, focusRing } from "@/lib/utils";

// The one vaul import in the app (test/layout-guards.test.ts).
//
// Compact: a bottom sheet, Save at the very bottom inside the safe area —
// reachable with a thumb, one-handed. md and up (spec §3): the SAME sheet
// as a 420 px panel on the right edge, full height. Every sheet was laid
// out for max-w-md minus padding, so nothing inside changes; only the edge
// it comes from.

export type SheetDirection = "bottom" | "right";

export function directionFor(tier: Tier): SheetDirection {
  return tier === "compact" ? "bottom" : "right";
}

// useSheetReset seeds a sheet's fields on the render in which it opens.
//
// Every log sheet is one component for create AND edit (CLAUDE.md), so its
// fields have to be re-seeded each time it opens — from the entry being
// edited, or from the last entry of that kind for the last-value prefill.
// Doing that in an effect would mount the children with the previous open's
// values and then visibly correct them, so `seed` runs DURING the render
// that sees `open` flip, which is React's documented "adjusting state when
// props change": the setters it calls are the caller's own, and React
// re-runs the component before committing anything to the DOM.
//
// The bookkeeping this replaces — a wasOpen flag, its two guard blocks, and
// an instance counter — was written out in all twelve sheets identically.
//
// The returned counter increments on each open and exists for children that
// hold their own uncontrolled state and must therefore be remounted rather
// than re-seeded: `<TimeField key={instance} …>`. Sheets with no such child
// ignore it.
//
// Reset by unmounting the body instead was considered and rejected: vaul
// animates the sheet out after `open` goes false, and an unmounted body
// animates out empty.
export function useSheetReset(open: boolean, seed: () => void): number {
  const [wasOpen, setWasOpen] = useState(false);
  const [instance, setInstance] = useState(0);
  if (open && !wasOpen) {
    setWasOpen(true);
    setInstance((i) => i + 1);
    seed();
  }
  if (!open && wasOpen) {
    setWasOpen(false);
  }
  return instance;
}

export function Sheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  const wanted = directionFor(useTier());
  // Latched at open: changing vaul's `direction` on an open drawer
  // re-animates it and can remount the content, which would throw away a
  // half-filled feed when a window is resized across 768 px (the same
  // hazard Home guards for the 22:00 night flip). The tier is read when the
  // sheet opens and kept until it closes; the next open uses the new tier.
  const [direction, setDirection] = useState<SheetDirection>(wanted);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDirection(wanted);
  }
  const side = direction === "right";

  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      repositionInputs={false}
      direction={direction}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Drawer.Content
          data-direction={direction}
          className={cn(
            "fixed z-50 flex flex-col bg-bg outline-none",
            side
              ? "inset-y-0 right-0 w-[420px] max-w-full rounded-l-3xl"
              : "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-3xl",
          )}
        >
          {side ? (
            // A side panel has no swipe-down cue, so it gets a close
            // button; Escape and the scrim close it too.
            <div className="flex items-center justify-between pt-5 pr-3 pb-1 pl-5">
              <Drawer.Title className="text-lg font-bold text-ink">
                {title}
              </Drawer.Title>
              <Drawer.Close
                aria-label={t("Close")}
                className={cn(
                  "flex h-11 w-11 items-center justify-center rounded-full text-ink-soft active:bg-surface-2",
                  focusRing,
                )}
              >
                <IconX className="h-5 w-5" />
              </Drawer.Close>
            </div>
          ) : (
            <>
              <div className="mx-auto mt-3 h-1.5 w-10 shrink-0 rounded-full bg-line" />
              <Drawer.Title className="px-5 pt-3 pb-1 text-lg font-bold text-ink">
                {title}
              </Drawer.Title>
            </>
          )}
          <div className="flex-1 overflow-y-auto px-5 pb-safe">{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
