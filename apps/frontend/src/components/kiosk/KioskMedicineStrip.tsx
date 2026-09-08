import type { MedicineCatalogueEntry } from "@pjokk/shared";
import { IconPill } from "@tabler/icons-react";
import { t } from "@/lib/i18n";
import { medicineStripView } from "@/lib/kiosk-ui";
import { formatClock } from "@/lib/time";
import { cn, focusRing } from "@/lib/utils";

// The medicine strip (spec §5): one line per catalogue entry with a dose in
// the last 24 h or an interval still running; Log dose logs the default
// amount and is never blocked — the parent is the authority.
export function KioskMedicineStrip({
  entry,
  now,
  onLog,
}: {
  entry: MedicineCatalogueEntry;
  now: Date;
  onLog: () => void;
}) {
  const v = medicineStripView(entry, now);
  if (!v.show) return null;
  const dose =
    entry.defaultAmount != null
      ? `${entry.defaultAmount} ${entry.unit ?? ""}`.trim()
      : null;
  return (
    <div
      data-testid="kiosk-medicine"
      className="flex items-center gap-3.5 rounded-2xl border border-line bg-surface px-4 py-3"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-growth">
        <IconPill className="h-[18px] w-[18px]" />
      </span>
      <p className="min-w-0 flex-1 truncate text-[17px] text-ink">
        <span className="font-bold">{entry.name}</span>
        <span className="text-ink-soft">
          {" "}
          · {t("last dose")}{" "}
          {entry.lastDoseAt ? formatClock(new Date(entry.lastDoseAt)) : "—"}
          {dose ? ` · ${dose}` : ""} ·{" "}
        </span>
        <span className={cn("font-bold", v.ahead ? "text-accent" : "text-ink")}>
          {v.okText}
        </span>
      </p>
      {dose && (
        <button
          type="button"
          onClick={onLog}
          className={cn(
            "flex h-11 shrink-0 items-center rounded-xl border border-line bg-surface-2 px-4 text-[15px] font-bold text-ink active:scale-[0.97]",
            focusRing,
          )}
        >
          {t("Log dose")}
        </button>
      )}
    </div>
  );
}
