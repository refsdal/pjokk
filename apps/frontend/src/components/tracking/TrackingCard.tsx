import type { CSSProperties } from "react";
import { useState } from "react";
import { t } from "@/lib/i18n";
import type { FeatureMeta } from "@/lib/tracking";
import { cn, focusRing } from "@/lib/utils";
import { FeatureMock } from "./mocks";

// The ring takes the card's category tint (styles.css ring-ping reads
// --ping-color), so night mode's amber comes through unchanged.
const tintVar: Record<string, string> = {
  "text-feed": "var(--color-feed)",
  "text-sleep": "var(--color-sleep)",
  "text-diaper": "var(--color-diaper)",
  "text-growth": "var(--color-growth)",
  "text-accent": "var(--color-accent)",
  "text-muted": "var(--color-muted)",
};

// One card per switch (spec §The carousel): the live mock, the title, one
// line, the toggle, a tag. Off is asleep — mock desaturated, title muted;
// turning on is the light-up (styles.css): the tint returns, the mock
// plays its one animation, a ring in the tint pulses from the toggle, and
// the phone ticks once. Off just dims: tidying, not losing.
export function TrackingCard({
  meta,
  on,
  tag,
  readOnly,
  onToggle,
}: {
  meta: FeatureMeta;
  on: boolean;
  tag: string | null;
  readOnly: boolean;
  onToggle: (next: boolean) => void;
}) {
  // A counter, not a boolean: re-arms the one-shot ring on every flip on.
  const [lit, setLit] = useState(0);
  const toggle = () => {
    const next = !on;
    if (next) {
      setLit((n) => n + 1);
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        try {
          navigator.vibrate(10);
        } catch {
          // a browser that lists it and refuses it
        }
      }
    }
    onToggle(next);
  };
  const Icon = meta.icon;
  const state = on ? t("On") : t("Off");
  return (
    <section
      className="flex h-full w-full shrink-0 snap-center flex-col justify-between px-4"
      data-testid={`tracking-card-${meta.key}`}
      aria-label={t(meta.label)}
    >
      <div className="space-y-4 pt-6">
        <FeatureMock feature={meta.key} on={on} />
        <div className="flex items-center gap-2">
          <Icon className={cn("h-6 w-6", on ? meta.tint : "text-muted")} />
          <h2
            className={cn(
              "text-2xl font-extrabold transition-colors",
              on ? "text-ink" : "text-muted",
            )}
          >
            {t(meta.label)}
          </h2>
        </div>
        <p className="text-base text-ink-soft">{t(meta.description)}</p>
        {tag && <p className="text-sm font-semibold text-accent">{tag}</p>}
      </div>
      <div className="flex items-center justify-between py-4">
        <span className="text-sm font-semibold text-muted">{state}</span>
        {readOnly ? (
          <span className="text-sm font-bold text-ink">{state}</span>
        ) : (
          <button
            key={lit}
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={t(meta.label)}
            onClick={toggle}
            style={
              {
                "--ping-color": tintVar[meta.tint] ?? "var(--color-accent)",
              } as CSSProperties
            }
            className={cn(
              "relative h-11 w-20 shrink-0 rounded-full border transition-colors",
              on ? "border-accent bg-accent" : "border-line bg-surface-2",
              lit > 0 && on && "animate-tracking-lit",
              focusRing,
            )}
          >
            <span
              className={cn(
                "absolute top-1 left-1 h-8 w-8 rounded-full bg-white shadow transition-transform",
                on && "translate-x-9",
              )}
            />
          </button>
        )}
      </div>
    </section>
  );
}
