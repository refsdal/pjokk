import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// The paced-strip shell, lifted out of components/tracking/TrackingCarousel
// when the first run (issue #140) needed a second one. A scroll-snap strip
// with Back / Next as the primary control — the app's no-swipe rule is
// about ROUTE navigation fighting the back gesture; swiping here is a bonus
// nobody needs.
//
// Everything about WHAT the steps say stays with the caller. This file owns
// only the strip, the dots, the buttons and the scroll bookkeeping.
export function Carousel({
  steps,
  onFinish,
  testIdPrefix,
  finishLabel,
  ariaLabel,
  controls,
}: {
  steps: ReactNode[];
  onFinish: () => void;
  testIdPrefix: string;
  finishLabel?: string;
  ariaLabel?: string;
  /**
   * Filled with a jump function on mount, for a caller that needs to move
   * the strip from inside a step (tracking's "Use the recommended set").
   * A ref rather than a controlled index: the strip's position is the
   * truth here, and a second source would fight the scroll bookkeeping.
   */
  controls?: { current: { goTo: (i: number) => void } | null };
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const last = steps.length - 1;

  // The card a button asked for, while the smooth scroll is still on its
  // way there. Without it the scroll handler below reads the strip's
  // position mid-flight and sets the index BACK, so Done turns into Next
  // for a few frames — and a tap in those frames lands on Next (seen on a
  // slow CI runner). A swipe has no target, so its position is trusted at
  // once.
  const target = useRef<number | null>(null);
  const goTo = (i: number) => {
    const el = strip.current;
    if (!el) return;
    target.current = i;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
    setIndex(i);
  };
  const positionIndex = () => {
    const el = strip.current;
    if (!el || el.clientWidth === 0) return null;
    return Math.round(el.scrollLeft / el.clientWidth);
  };
  const onScroll = () => {
    const i = positionIndex();
    if (i === null) return;
    if (target.current !== null) {
      if (i === target.current) target.current = null; // arrived
      return;
    }
    setIndex(i);
  };
  // A programmatic scroll a swipe interrupted never "arrives": once the
  // strip has come to rest anywhere, the position is the truth again.
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const settle = () => {
      target.current = null;
      const i = positionIndex();
      if (i !== null) setIndex(i);
    };
    el.addEventListener("scrollend", settle);
    return () => el.removeEventListener("scrollend", settle);
  }, []);

  useEffect(() => {
    if (!controls) return;
    controls.current = { goTo };
    return () => {
      controls.current = null;
    };
  });

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col pt-safe md:max-w-lg">
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label is only sent when role is "region" (a caller that passes no ariaLabel gets no landmark at all) */}
      <div
        ref={strip}
        onScroll={onScroll}
        // overflow-y-hidden: a scroll container clips its box-shadows, so
        // the light-up ring must stay inside the strip and the strip must
        // never scroll vertically (which would push the ring to the edge).
        className="flex flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none]"
        data-testid={`${testIdPrefix}-strip`}
        role={ariaLabel ? "region" : undefined}
        aria-label={ariaLabel}
      >
        {steps.map((step, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed strip
            key={i}
            className="flex w-full shrink-0 snap-center flex-col"
          >
            {step}
          </div>
        ))}
      </div>
      {/* pb-tabbar clears the bottom bar on the phone (styles.css). */}
      <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-tabbar">
        <Button
          variant="outline"
          onClick={() => goTo(index - 1)}
          disabled={index === 0}
        >
          {t("Back")}
        </Button>
        <div className="flex gap-1" aria-hidden>
          {Array.from({ length: steps.length }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed strip of dots
              key={i}
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                i === index ? "bg-accent" : "bg-line",
              )}
            />
          ))}
        </div>
        {index < last ? (
          <Button
            onClick={() => goTo(index + 1)}
            data-testid={`${testIdPrefix}-next`}
          >
            {t("Next")}
          </Button>
        ) : (
          <Button onClick={onFinish} data-testid={`${testIdPrefix}-done`}>
            {finishLabel ?? t("Done")}
          </Button>
        )}
      </div>
    </div>
  );
}
