import { useState } from "react";
import type {
  CalendarCategory,
  CalendarEvent,
  CalendarRecurrence,
} from "@pjokk/shared";
import { Avatar } from "@/components/Avatar";
import { ChipGroup, MultiChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet, useSheetReset } from "@/components/Sheet";
import { Stepper } from "@/components/Stepper";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useBabies,
  useCreateCalendarEvent,
  useDeleteCalendarEvent,
  useMembers,
  useUpdateCalendarEvent,
} from "@/lib/data";
import { calendarCategoryMeta } from "@/lib/calendar-ui";
import { t } from "@/lib/i18n";

type DurationChoice = "30" | "60" | "120" | "custom";
// Which part of a recurring event the sheet edits: the tapped occurrence,
// or the whole series.
type Scope = "one" | "all";
type ReminderChoice = "off" | "60" | "1440";

const pad = (n: number) => String(n).padStart(2, "0");
const toDateInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTimeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Next full hour — a sane default start for a planned event. */
function nextHour(): Date {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d;
}

function durationChoiceFor(min: number | null): DurationChoice {
  if (min === 30 || min === 60 || min === 120)
    return String(min) as DurationChoice;
  return "custom";
}

// ONE component for create and edit (CLAUDE.md).
export function EventSheet({
  open,
  onOpenChange,
  edit = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  edit?: CalendarEvent | null;
}) {
  const babies = useBabies();
  const members = useMembers();

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<CalendarCategory>("other");
  const [allDay, setAllDay] = useState(false);
  const [date, setDate] = useState(() => toDateInput(nextHour()));
  const [time, setTime] = useState(() => toTimeInput(nextHour()));
  const [duration, setDuration] = useState<DurationChoice>("60");
  const [customMin, setCustomMin] = useState(45);
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [babyIds, setBabyIds] = useState<string[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [reminder, setReminder] = useState<ReminderChoice>("off");
  // Recurrence (issue #52). A tapped occurrence of a series is edited on
  // its own by default ("This event"); "All events" edits the series, and
  // then the date shown is the series start, not the occurrence.
  const [recurrence, setRecurrence] = useState<CalendarRecurrence>("none");
  const [until, setUntil] = useState("");
  const [scope, setScope] = useState<Scope>("one");
  const recurring = !!edit && edit.recurrence !== "none";
  const onlyThis = recurring && scope === "one";

  useSheetReset(open, () => {
    if (edit) {
      setScope("one");
      // The occurrence that was tapped (for a one-off, its own start).
      const start = new Date(edit.startTime);
      setRecurrence(edit.recurrence);
      setUntil(
        edit.recurrenceUntil ? toDateInput(new Date(edit.recurrenceUntil)) : "",
      );
      setTitle(edit.title);
      setCategory(edit.category);
      setAllDay(edit.allDay);
      setDate(toDateInput(start));
      setTime(toTimeInput(edit.allDay ? nextHour() : start));
      setDuration(durationChoiceFor(edit.durationMin));
      setCustomMin(edit.durationMin ?? 45);
      setLocation(edit.location ?? "");
      setDescription(edit.description ?? "");
      setBabyIds(edit.babies.map((b) => b.id));
      setAssignees(edit.assignees.map((a) => a.userId));
      setReminder(
        edit.remindMinutesBefore === 60
          ? "60"
          : edit.remindMinutesBefore === 1440
            ? "1440"
            : "off",
      );
    } else {
      const start = nextHour();
      setTitle("");
      setCategory("other");
      setAllDay(false);
      setDate(toDateInput(start));
      setTime(toTimeInput(start));
      setDuration("60");
      setCustomMin(45);
      setLocation("");
      setDescription("");
      // Single-baby family: the baby is implicitly attached.
      setBabyIds((babies.data ?? []).length === 1 ? [babies.data![0]!.id] : []);
      setAssignees([]);
      setReminder("off");
      setRecurrence("none");
      setUntil("");
    }
  });

  // Each scope shows its own start: the occurrence, or the series'.
  const changeScope = (next: Scope) => {
    setScope(next);
    if (!edit) return;
    const start = new Date(next === "one" ? edit.startTime : edit.seriesStart);
    setDate(toDateInput(start));
    if (!allDay) setTime(toTimeInput(start));
  };

  const createEvent = useCreateCalendarEvent();
  const updateEvent = useUpdateCalendarEvent();
  const deleteEvent = useDeleteCalendarEvent();

  const save = () => {
    const [y, m, d] = date.split("-").map(Number);
    const [hh, mm] = allDay ? [0, 0] : time.split(":").map(Number);
    const start = new Date(y!, m! - 1, d!, hh ?? 0, mm ?? 0, 0, 0);
    const durationMin = allDay
      ? undefined
      : duration === "custom"
        ? customMin
        : Number(duration);
    // Guard against the open-time prefill losing the race with useBabies():
    // for a single-baby family, always attach that baby on create, even if
    // the babies query hadn't resolved yet when the sheet opened.
    const soleBaby =
      (babies.data ?? []).length === 1 ? [babies.data![0]!.id] : null;
    const effectiveBabyIds = !edit && soleBaby ? soleBaby : babyIds;
    // "Until" is a day: the last occurrence may start any time that day.
    const untilIso = (() => {
      if (recurrence === "none" || !until) return undefined;
      const [uy, um, ud] = until.split("-").map(Number);
      return new Date(uy!, um! - 1, ud!, 23, 59, 59, 0).toISOString();
    })();
    const payload = {
      title: title.trim(),
      recurrence,
      recurrenceUntil: untilIso,
      description: description.trim() || undefined,
      location: location.trim() || undefined,
      category,
      startTime: start.toISOString(),
      allDay,
      durationMin,
      remindMinutesBefore: reminder === "off" ? undefined : Number(reminder),
      babyIds: effectiveBabyIds,
      assigneeUserIds: assignees,
    };
    if (edit) {
      updateEvent.mutate({
        id: edit.id,
        // "This event": the server detaches the occurrence and ignores the
        // recurrence fields (a single occurrence does not repeat).
        occurrence: onlyThis ? edit.startTime : undefined,
        patch: {
          ...payload,
          description: payload.description ?? null,
          location: payload.location ?? null,
          durationMin: payload.durationMin ?? null,
          remindMinutesBefore: payload.remindMinutesBefore ?? null,
          recurrenceUntil: payload.recurrenceUntil ?? null,
        },
      });
    } else {
      createEvent.mutate(payload);
    }
    onOpenChange(false);
  };

  const remove = () => {
    if (!edit) return;
    deleteEvent.mutate({
      id: edit.id,
      occurrence: onlyThis ? edit.startTime : undefined,
    });
    onOpenChange(false);
  };

  const multiBaby = (babies.data ?? []).length > 1;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? t("Edit event") : t("New event")}
    >
      <div className="space-y-5 pb-4">
        {recurring && (
          <div className="space-y-2">
            <ChipGroup
              options={[
                { value: "one", label: t("This event") },
                { value: "all", label: t("All events") },
              ]}
              value={scope}
              onChange={changeScope}
            />
            <p className="text-xs text-muted">
              {onlyThis
                ? t("Only this event changes; the rest of the series stays.")
                : t("Changes apply to every occurrence in the series.")}
            </p>
          </div>
        )}
        <Input
          placeholder={t("Title")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <ChipGroup
          options={(
            Object.keys(calendarCategoryMeta) as CalendarCategory[]
          ).map((c) => ({
            value: c,
            label: t(calendarCategoryMeta[c].label),
          }))}
          value={category}
          onChange={setCategory}
        />
        <ChipGroup
          options={[
            { value: "timed", label: t("Pick time") },
            { value: "allday", label: t("All day") },
          ]}
          value={allDay ? "allday" : "timed"}
          onChange={(v) => setAllDay(v === "allday")}
        />
        <div className="flex gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="h-12 w-full rounded-xl2 border border-line bg-surface px-4 text-base text-ink"
          />
          {!allDay && (
            <input
              type="time"
              value={time}
              onChange={(e) => e.target.value && setTime(e.target.value)}
              className="h-12 w-full rounded-xl2 border border-line bg-surface px-4 text-base text-ink"
            />
          )}
        </div>
        {!allDay && (
          <div className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">
              {t("Duration")}
            </p>
            <ChipGroup
              options={[
                { value: "30", label: `30 ${t("min")}` },
                { value: "60", label: `1 ${t("h")}` },
                { value: "120", label: `2 ${t("h")}` },
                { value: "custom", label: t("Custom") },
              ]}
              value={duration}
              onChange={setDuration}
            />
            {duration === "custom" && (
              <Stepper
                value={customMin}
                onChange={setCustomMin}
                min={5}
                max={1440}
                step={5}
                unit={t("min")}
              />
            )}
          </div>
        )}
        {multiBaby && (
          <div className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">
              {t("Babies")}
            </p>
            <MultiChipGroup
              options={(babies.data ?? []).map((b) => ({
                value: b.id,
                label: b.name,
              }))}
              values={babyIds}
              onToggle={(id) =>
                setBabyIds((ids) =>
                  ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
                )
              }
            />
          </div>
        )}
        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">
            {t("Responsible")}
          </p>
          <MultiChipGroup
            options={(members.data ?? []).map((m) => ({
              value: m.userId,
              label: m.name,
              leading: <Avatar src={m.avatarUrl} name={m.name} size={5} />,
            }))}
            values={assignees}
            onToggle={(id) =>
              setAssignees((ids) =>
                ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
              )
            }
          />
        </div>
        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">
            {t("Reminder")}
          </p>
          <ChipGroup
            options={[
              { value: "off", label: t("Off") },
              { value: "60", label: t("1 h before") },
              { value: "1440", label: t("1 day before") },
            ]}
            value={reminder}
            onChange={setReminder}
          />
        </div>
        {!onlyThis && (
          <div className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">
              {t("Repeat")}
            </p>
            <ChipGroup
              options={[
                { value: "none", label: t("Never") },
                { value: "daily", label: t("Daily") },
                { value: "weekly", label: t("Weekly") },
                { value: "biweekly", label: t("Every 2 weeks") },
                { value: "monthly", label: t("Monthly") },
                { value: "yearly", label: t("Yearly") },
              ]}
              value={recurrence}
              onChange={setRecurrence}
            />
            {recurrence !== "none" && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted">{t("Until")}</span>
                <input
                  type="date"
                  aria-label={t("Until")}
                  value={until}
                  min={date}
                  onChange={(e) => setUntil(e.target.value)}
                  className="h-12 w-full rounded-xl2 border border-line bg-surface px-4 text-base text-ink"
                />
              </div>
            )}
          </div>
        )}
        <Input
          placeholder={t("Location (optional)")}
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
        <Input
          placeholder={t("Description (optional)")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <Button
          size="full"
          onClick={save}
          disabled={title.trim().length === 0 || (!edit && babies.isLoading)}
        >
          {t("Save")}
        </Button>
        {edit && (
          <DeleteButton
            label={
              recurring
                ? onlyThis
                  ? t("Delete this event")
                  : t("Delete all events")
                : undefined
            }
            onDelete={remove}
          />
        )}
      </div>
    </Sheet>
  );
}
