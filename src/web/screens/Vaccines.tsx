import {
  IconArrowLeft,
  IconCheck,
  IconChevronDown,
  IconPaperclip,
  IconX,
} from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { VaccineLog } from "@shared/schemas";
import { BabySwitcher } from "@/components/BabySwitcher";
import { ErrorState, LoadingState } from "@/components/QueryStates";
import { VaccineSheet } from "@/components/sheets/VaccineSheet";
import { Button } from "@/components/ui/button";
import {
  useDismissVaccineSlot,
  useRestoreVaccineSlot,
  useVaccineDismissals,
  useVaccines,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { useSelectedBaby } from "@/lib/selected-baby";
import { formatDay } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  buildSchedule,
  offProgramme,
  vaccineProgramme,
  type ProgrammeSlot,
  type ScheduleRow,
} from "@/lib/vaccine-programme";

// The programme is shown as an overlay over what was actually logged: given
// rows carry their date, due rows are tappable to log, and anything logged
// outside the programme gets its own list below so nothing disappears.
export function VaccinesScreen() {
  const navigate = useNavigate();
  const { baby } = useSelectedBaby();
  const vaccines = useVaccines(baby?.id);
  const dismissals = useVaccineDismissals(baby?.id);
  const dismiss = useDismissVaccineSlot();
  const restore = useRestoreVaccineSlot();
  const [slot, setSlot] = useState<ProgrammeSlot | null>(null);
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<VaccineLog | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);

  const entries = vaccines.data ?? [];
  const dismissedRows = dismissals.data ?? [];
  const schedule = baby
    ? buildSchedule(
        new Date(baby.birthDate),
        entries,
        dismissedRows.map((d) => d.slotKey),
      )
    : [];
  const extra = offProgramme(entries, schedule);
  const pending = schedule.filter((r) => r.status !== "dismissed");
  const dismissed = schedule.filter((r) => r.status === "dismissed");
  // The dismissal row id is what restores it; a slot dismissed for a key the
  // programme no longer has simply never appears here.
  const dismissalIdFor = (slotKey: string) =>
    dismissedRows.find((d) => d.slotKey === slotKey)?.id ?? null;

  return (
    <div className="mx-auto max-w-md px-4 pt-safe">
      <div className="flex items-center gap-2 py-4">
        <button
          type="button"
          aria-label={t("Back")}
          onClick={() => void navigate({ to: "/home" })}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink active:bg-surface-2"
        >
          <IconArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="flex-1 text-2xl font-extrabold text-ink">
          {t("Vaccines")}
        </h1>
        <BabySwitcher compact />
      </div>

      <div className="space-y-4 pb-tabbar">
        {vaccines.isPending && <LoadingState />}
        {vaccines.isError && (
          <ErrorState onRetry={() => void vaccines.refetch()} />
        )}

        {baby && vaccines.isSuccess && (
          <>
            {pending.length > 0 && (
              <div className="divide-y divide-line rounded-xl2 border border-line bg-surface">
                {pending.map((row) => (
                  <ScheduleRowView
                    key={row.slot.key}
                    row={row}
                    onLog={() => setSlot(row.slot)}
                    onEdit={(entry) => setEdit(entry)}
                    onDismiss={
                      baby && !row.entry
                        ? () =>
                            dismiss.mutate(
                              { babyId: baby.id, slotKey: row.slot.key },
                              {
                                onError: (err) => toast(err.message, "error"),
                              },
                            )
                        : undefined
                    }
                  />
                ))}
              </div>
            )}

            {dismissed.length > 0 && (
              <section>
                <button
                  type="button"
                  aria-expanded={showDismissed}
                  onClick={() => setShowDismissed((v) => !v)}
                  className="flex min-h-11 w-full items-center gap-2 px-1 text-left text-xs font-bold tracking-wider text-muted uppercase"
                >
                  <IconChevronDown
                    className={cn(
                      "h-4 w-4 transition-transform",
                      showDismissed ? "" : "-rotate-90",
                    )}
                  />
                  {t("Dismissed")} ({dismissed.length})
                </button>
                {showDismissed && (
                  <div className="divide-y divide-line rounded-xl2 border border-line bg-surface">
                    {dismissed.map((row) => {
                      const id = dismissalIdFor(row.slot.key);
                      return (
                        <div
                          key={row.slot.key}
                          className="flex items-center gap-3 px-4 py-3"
                        >
                          <span className="min-w-0 flex-1 truncate text-sm text-muted">
                            {row.slot.name} · {row.slot.dose}
                          </span>
                          <button
                            type="button"
                            disabled={!id || restore.isPending}
                            onClick={() =>
                              id &&
                              restore.mutate(id, {
                                onError: (err) => toast(err.message, "error"),
                              })
                            }
                            className="shrink-0 text-sm font-semibold text-accent active:opacity-60"
                          >
                            {t("Restore")}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            {extra.length > 0 && (
              <section className="space-y-2">
                <h2 className="px-1 text-xs font-bold tracking-wider text-muted uppercase">
                  {t("Other vaccines")}
                </h2>
                <div className="divide-y divide-line rounded-xl2 border border-line bg-surface">
                  {extra.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setEdit(entry)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2"
                    >
                      <IconCheck className="h-5 w-5 shrink-0 text-growth" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-ink">
                          {entry.name}
                          {entry.doseNumber ? ` · ${entry.doseNumber}` : ""}
                        </span>
                        <span className="block text-sm text-muted">
                          {formatDay(new Date(entry.time))}
                        </span>
                      </span>
                      {entry.documents.length > 0 && (
                        <IconPaperclip className="h-4 w-4 shrink-0 text-muted" />
                      )}
                    </button>
                  ))}
                </div>
              </section>
            )}

            <Button
              size="full"
              variant="outline"
              onClick={() => setAdding(true)}
            >
              {t("Log vaccine")}
            </Button>

            {/* The source is a link, not just a name: a schedule we assert
                is one a parent must be able to check against the original.
                -my-1/py-1 grows the tap target without shifting the line. */}
            <p className="px-1 text-xs text-muted">
              {t("Schedule follows")} {vaccineProgramme.name} (
              <a
                href={vaccineProgramme.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="-my-1 py-1 font-semibold text-accent underline underline-offset-2"
              >
                {vaccineProgramme.source}
              </a>
              ). {t("Check with your helsestasjon.")}
            </p>
          </>
        )}
      </div>

      <VaccineSheet
        open={!!slot}
        onOpenChange={(o) => !o && setSlot(null)}
        babyId={baby?.id ?? ""}
        slot={slot}
      />
      <VaccineSheet
        open={adding}
        onOpenChange={setAdding}
        babyId={baby?.id ?? ""}
      />
      <VaccineSheet
        open={!!edit}
        onOpenChange={(o) => !o && setEdit(null)}
        babyId={baby?.id ?? ""}
        edit={edit}
      />
    </div>
  );
}

function ScheduleRowView({
  row,
  onLog,
  onEdit,
  onDismiss,
}: {
  row: ScheduleRow;
  onLog: () => void;
  onEdit: (entry: VaccineLog) => void;
  /** Absent on a slot that has already been logged — you can only wave away
   *  a suggestion, never a record. */
  onDismiss?: () => void;
}) {
  const { slot, status, entry, dueAt } = row;
  return (
    <div className="flex items-stretch">
      <button
        type="button"
        onClick={() => (entry ? onEdit(entry) : onLog())}
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left active:bg-surface-2"
      >
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
            status === "given"
              ? "border-growth bg-growth/15 text-growth"
              : status === "due"
                ? "border-accent text-accent"
                : "border-line text-muted",
          )}
        >
          {status === "given" && <IconCheck className="h-4 w-4" />}
        </span>

        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate font-semibold",
              status === "upcoming" ? "text-ink-soft" : "text-ink",
            )}
          >
            {slot.name} · {slot.dose}
          </span>
          <span className="block truncate text-sm text-muted">
            {entry
              ? formatDay(new Date(entry.time))
              : `${t(slot.ageLabel)} · ${formatDay(dueAt)}`}
          </span>
        </span>

        {entry && entry.documents.length > 0 && (
          <IconPaperclip className="h-4 w-4 shrink-0 text-muted" />
        )}
        {status === "due" && (
          <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent uppercase">
            {t("due")}
          </span>
        )}
      </button>
      {onDismiss && (
        <button
          type="button"
          aria-label={`${t("Dismiss")} ${slot.name} ${slot.dose}`}
          onClick={onDismiss}
          className="flex w-12 shrink-0 items-center justify-center text-muted active:bg-surface-2"
        >
          <IconX className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
