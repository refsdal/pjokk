import type { CareDay } from "@pjokk/shared";
import { Avatar } from "@/components/Avatar";
import { caretakerOptions, firstName } from "@/lib/caretaker-ui";
import {
  DOCTORS_NOTE_FROM_DAY,
  consecutiveDays,
  nextFraction,
} from "@/lib/care-days-ui";
import {
  useAddCareDay,
  useCareDays,
  useMe,
  useMembers,
  useRemoveCareDay,
  useUpdateCareDay,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import { toLocalDateInput } from "@/lib/time";
import { cn, focusRing } from "@/lib/utils";

// "Who is home today?" on the illness card (issue #108): the family's
// faces, each a three-state tap — not home, a whole day, half a day. A
// whole day is the common case and costs one tap. Shown for a family of one
// too: a single parent's days count the same.
export function HomeTodayChips({ illnessId }: { illnessId: string }) {
  const today = toLocalDateInput();
  const year = Number(today.slice(0, 4));
  const me = useMe();
  const members = useMembers();
  const days = useCareDays(year);
  const add = useAddCareDay();
  const update = useUpdateCareDay();
  const remove = useRemoveCareDay();
  const busy = add.isPending || update.isPending || remove.isPending;

  const faces = caretakerOptions(members.data ?? [], me.data?.userId);
  if (faces.length === 0) return null;
  const todays = (days.data?.days ?? []).filter((d) => d.date === today);
  const dayOf = (userId: string): CareDay | undefined =>
    todays.find((d) => d.userId === userId);

  const tap = (userId: string) => {
    const existing = dayOf(userId);
    const next = nextFraction(existing?.fraction);
    if (!existing) add.mutate({ date: today, userId, fraction: 1, illnessId });
    else if (next === undefined) remove.mutate({ id: existing.id });
    else update.mutate({ id: existing.id, patch: { fraction: next } });
  };

  // From the fourth calendar day in a row an employer may ask for a
  // doctor's note. Said once, quietly, for whoever it applies to.
  const onDayFour = faces.filter(
    (m) =>
      consecutiveDays(days.data?.days ?? [], m.userId, today) >=
      DOCTORS_NOTE_FROM_DAY,
  );

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">
        {t("Home today")}
      </p>
      <fieldset
        aria-label={t("Home today")}
        className="flex gap-2 overflow-x-auto"
        data-testid="home-today-chips"
      >
        {faces.map((m) => {
          const day = dayOf(m.userId);
          return (
            <button
              key={m.userId}
              type="button"
              aria-pressed={!!day}
              disabled={busy}
              onClick={() => tap(m.userId)}
              className={cn(
                "flex h-11 shrink-0 items-center gap-2 rounded-full border py-1 pr-4 pl-1 text-sm font-semibold transition-colors select-none active:scale-[0.97]",
                focusRing,
                day
                  ? "border-accent bg-accent-soft text-ink"
                  : "border-line bg-surface text-ink-soft",
              )}
            >
              <Avatar src={m.avatarUrl} name={m.name || m.email} size={8} />
              {firstName(m)}
              {day?.fraction === 0.5 && (
                <span className="text-xs font-bold text-accent">
                  {t("half day")}
                </span>
              )}
            </button>
          );
        })}
      </fieldset>
      {onDayFour.map((m) => (
        <p key={m.userId} className="text-xs text-muted" data-testid="day-four">
          {firstName(m)}:{" "}
          {t("day 4 in a row. An employer may ask for a doctor's note.")}
        </p>
      ))}
    </div>
  );
}
