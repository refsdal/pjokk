import { useState } from "react";
import type { CalendarCategory, CalendarEvent } from "@shared/schemas";
import { ChipGroup, MultiChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet } from "@/components/Sheet";
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
  const [wasOpen, setWasOpen] = useState(false);

  if (open && !wasOpen) {
    setWasOpen(true);
    if (edit) {
      const start = new Date(edit.startTime);
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
    }
  }
  if (!open && wasOpen) setWasOpen(false);

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
    const payload = {
      title: title.trim(),
      description: description.trim() || undefined,
      location: location.trim() || undefined,
      category,
      startTime: start.toISOString(),
      allDay,
      durationMin,
      remindMinutesBefore: reminder === "off" ? undefined : Number(reminder),
      babyIds,
      assigneeUserIds: assignees,
    };
    if (edit) {
      updateEvent.mutate({
        id: edit.id,
        patch: {
          ...payload,
          description: payload.description ?? null,
          location: payload.location ?? null,
          durationMin: payload.durationMin ?? null,
          remindMinutesBefore: payload.remindMinutesBefore ?? null,
        },
      });
    } else {
      createEvent.mutate(payload);
    }
    onOpenChange(false);
  };

  const remove = () => {
    if (!edit) return;
    deleteEvent.mutate({ id: edit.id });
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
        <Button size="full" onClick={save} disabled={title.trim().length === 0}>
          {t("Save")}
        </Button>
        {edit && <DeleteButton onDelete={remove} />}
      </div>
    </Sheet>
  );
}
