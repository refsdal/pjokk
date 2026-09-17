import {
  IconBabyBottle,
  IconDiaper,
  IconMoon,
  IconPlus,
} from "@tabler/icons-react";
import { LogButton } from "@/components/LogButton";
import type { MoreAction } from "@/components/sheets/OtherLogSheet";
import { t } from "@/lib/i18n";
import type { CoreKey } from "@/lib/tracking";
import { cn, focusRing } from "@/lib/utils";

// Home's action column (spec §4).
//
// Compact: the 2×2 grid — Feed, Diaper, Sleep, More. md and up: More
// disappears; the primaries become a row, and the More-sheet actions
// unfold beneath them as 44 px row tiles, two across, under the sheet's
// own "Log something" title. Smaller and lighter than the primaries on
// purpose, so the hierarchy stays: three big things, then a list. Both
// forms are in the markup; the tier is CSS.
//
// The primaries are the ENABLED ones (lib/tracking.ts, spec
// 2026-09-17-per-baby-tracking-design.md) and the grid reflows to their
// count; More always stays, because Ask for help lives there.

// Tailwind needs literal class names: one per count. The phone keeps More
// in the grid (3 + More = the 2×2; 2 + More = a row of three; 1 + More = a
// row of two); md hides More, so the columns are the primaries alone.
export function primaryGridClass(count: number): string {
  if (count >= 3) return "grid-cols-2 md:grid-cols-3";
  if (count === 2) return "grid-cols-3 md:grid-cols-2";
  return "grid-cols-2 md:grid-cols-1";
}

export function HomeActions({
  active,
  show,
  onFeed,
  onDiaper,
  onSleep,
  onMore,
  actions,
}: {
  active: boolean;
  show: Record<CoreKey, boolean>;
  onFeed: () => void;
  onDiaper: () => void;
  onSleep: () => void;
  onMore: () => void;
  actions: MoreAction[];
}) {
  const count = Number(show.feeds) + Number(show.diapers) + Number(show.sleep);
  return (
    <div className="flex flex-col gap-3">
      <div className={cn("grid gap-3", primaryGridClass(count))}>
        {show.feeds && (
          <LogButton
            icon={IconBabyBottle}
            label={t("Feed")}
            tintClass="text-feed"
            onClick={onFeed}
          />
        )}
        {show.diapers && (
          <LogButton
            icon={IconDiaper}
            label={t("Diaper")}
            tintClass="text-diaper"
            onClick={onDiaper}
          />
        )}
        {show.sleep && (
          <LogButton
            icon={IconMoon}
            label={active ? t("Sleeping…") : t("Sleep")}
            tintClass="text-sleep"
            onClick={onSleep}
            disabled={active}
          />
        )}
        <LogButton
          icon={IconPlus}
          label={t("More")}
          tintClass="text-growth"
          onClick={onMore}
          className="md:hidden"
        />
      </div>
      <div
        data-testid="home-actions-unfolded"
        className="hidden md:flex md:flex-col md:gap-2 md:pt-2"
      >
        <p className="px-1 text-xs font-semibold tracking-wide text-muted uppercase">
          {t("Log something")}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {actions.map(({ key, label, icon: Icon, tint, pick }) => (
            <button
              key={key}
              type="button"
              onClick={pick}
              className={cn(
                "flex h-11 items-center gap-2.5 rounded-full border border-line bg-surface pr-3.5 pl-1.5 text-left text-sm font-semibold text-ink select-none active:scale-[0.97] active:bg-surface-2",
                focusRing,
              )}
            >
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2",
                  tint,
                )}
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="truncate">{t(label)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
