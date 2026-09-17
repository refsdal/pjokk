import { IconMapPin, IconPhone, IconPlus } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { Baby, DaycarePlace, Member, PickupPlanDay } from "@pjokk/shared";
import { Avatar } from "@/components/Avatar";
import { ChipGroup, MultiChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { caretakerOptions, firstName } from "@/lib/caretaker-ui";
import {
  useBabies,
  useDaycarePlaces,
  useMe,
  useMembers,
  usePickupPlan,
  useRemoveDaycarePlace,
  useSaveDaycarePlace,
  useSetPickupPlan,
} from "@/lib/data";
import {
  clockMinute,
  directionsUrl,
  minuteClock,
  planGrid,
  weekdayLabel,
} from "@/lib/daycare-ui";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { SectionTitle } from "./lib";

// Settings → Family → Barnehage (spec 2026-09-17-daycare-place-and-pickup-
// plan-design.md): the place — how to reach it, when it opens and closes,
// how long before closing to say she is still there — and, per baby who
// goes there, the Monday-to-Friday pick-up plan. Parents edit; everyone
// else reads, because a grandparent needs the phone number too. A settings
// page rather than a log flow, so text fields and time inputs are fine
// here (CLAUDE.md §5 is about logging in the dark).

const timeInput =
  "h-12 min-w-0 flex-1 rounded-xl2 border border-line bg-surface px-4 text-base text-ink tabular-nums";
const fieldLabel = "text-xs font-semibold tracking-wide text-muted uppercase";

const LEADS = ["off", "15", "30", "45", "60"] as const;
type Lead = (typeof LEADS)[number];

export function DaycarePlaceSection({ isAdmin }: { isAdmin: boolean }) {
  const places = useDaycarePlaces();
  const babies = useBabies();
  const [adding, setAdding] = useState(false);
  const rows = places.data ?? [];
  const enrolled = (babies.data ?? []).filter((b) =>
    rows.some((p) => p.babyIds.includes(b.id)),
  );

  return (
    <div className="space-y-4" data-testid="daycare-place">
      {rows.map((place) =>
        isAdmin ? (
          <PlaceForm key={place.id} place={place} babies={babies.data ?? []} />
        ) : (
          <PlaceView key={place.id} place={place} />
        ),
      )}

      {rows.length === 0 && !adding && (
        <Card>
          <p className="text-sm text-muted">
            {isAdmin
              ? t(
                  "Add the barnehage to keep its number and address at hand, and to hear when she is still there near closing time.",
                )
              : t("A parent can add the barnehage here.")}
          </p>
        </Card>
      )}

      {isAdmin && adding && (
        <PlaceForm
          place={null}
          babies={babies.data ?? []}
          onDone={() => setAdding(false)}
        />
      )}
      {isAdmin && !adding && (
        <Button
          size="full"
          variant={rows.length === 0 ? "outline" : "ghost"}
          onClick={() => setAdding(true)}
          data-testid="add-daycare-place"
        >
          <IconPlus className="h-5 w-5" />
          {rows.length === 0 ? t("Add barnehage") : t("Add another barnehage")}
        </Button>
      )}

      {enrolled.map((baby) => (
        <PickupPlanCard key={baby.id} baby={baby} isAdmin={isAdmin} />
      ))}
    </div>
  );
}

function PlaceView({ place }: { place: DaycarePlace }) {
  const directions = directionsUrl(place);
  const hours =
    place.openMinute !== null && place.closeMinute !== null
      ? `${minuteClock(place.openMinute)}–${minuteClock(place.closeMinute)}`
      : null;
  return (
    <Card className="space-y-2">
      <p className="text-base font-bold text-ink">{place.name}</p>
      {hours && <p className="text-sm text-ink-soft tabular-nums">{hours}</p>}
      {place.address && (
        <p className="text-sm text-ink-soft">{place.address}</p>
      )}
      {place.notes && <p className="text-sm text-muted">{place.notes}</p>}
      <div className="flex flex-wrap gap-4 pt-1 text-sm font-semibold text-accent">
        {place.phone && (
          <a
            className="flex min-h-11 items-center gap-2"
            href={`tel:${place.phone.replace(/\s+/g, "")}`}
          >
            <IconPhone className="h-4 w-4" />
            {place.phone}
          </a>
        )}
        {directions && (
          <a
            className="flex min-h-11 items-center gap-2"
            href={directions}
            target="_blank"
            rel="noreferrer"
          >
            <IconMapPin className="h-4 w-4" />
            {t("Directions")}
          </a>
        )}
      </div>
    </Card>
  );
}

function PlaceForm({
  place,
  babies,
  onDone,
}: {
  place: DaycarePlace | null;
  babies: Baby[];
  onDone?: () => void;
}) {
  const save = useSaveDaycarePlace();
  const remove = useRemoveDaycarePlace();
  const [name, setName] = useState(place?.name ?? "");
  const [address, setAddress] = useState(place?.address ?? "");
  const [phone, setPhone] = useState(place?.phone ?? "");
  const [email, setEmail] = useState(place?.email ?? "");
  const [website, setWebsite] = useState(place?.website ?? "");
  const [notes, setNotes] = useState(place?.notes ?? "");
  const [open, setOpen] = useState(
    place?.openMinute != null ? minuteClock(place.openMinute) : "",
  );
  const [close, setClose] = useState(
    place?.closeMinute != null ? minuteClock(place.closeMinute) : "",
  );
  // A new place starts with the alert on at half an hour: the family's
  // number to change, but the reason most people add the place at all.
  const [lead, setLead] = useState<Lead>(
    place ? ((String(place.alertLeadMin ?? "off") as Lead) ?? "off") : "30",
  );
  // A new place starts with every baby going there — one baby, one tap less.
  const [babyIds, setBabyIds] = useState<string[]>(
    place ? place.babyIds : babies.map((b) => b.id),
  );
  // The babies query may land after the first render of a new place.
  const [seeded, setSeeded] = useState(!!place || babies.length > 0);
  useEffect(() => {
    if (seeded || babies.length === 0) return;
    setBabyIds(babies.map((b) => b.id));
    setSeeded(true);
  }, [seeded, babies]);

  const submit = () => {
    const text = (s: string) => s.trim() || null;
    save.mutate(
      {
        id: place?.id,
        place: {
          name: name.trim(),
          address: text(address),
          phone: text(phone),
          email: text(email),
          website: text(website),
          notes: text(notes),
          openMinute: clockMinute(open),
          closeMinute: clockMinute(close),
          alertLeadMin: lead === "off" ? null : Number(lead),
          // The hours are wall-clock times where this device is (and the
          // zone an existing place was made in stays its own).
          tz:
            place?.tz ??
            Intl.DateTimeFormat().resolvedOptions().timeZone ??
            "Europe/Oslo",
          babyIds,
        },
      },
      {
        onSuccess: () => {
          toast(t("Saved"));
          onDone?.();
        },
      },
    );
  };

  return (
    <Card className="space-y-3" data-testid="daycare-place-form">
      <Input
        placeholder={t("Name of the barnehage")}
        aria-label={t("Name of the barnehage")}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        placeholder={t("Address")}
        aria-label={t("Address")}
        value={address}
        onChange={(e) => setAddress(e.target.value)}
      />
      <Input
        type="tel"
        placeholder={t("Phone")}
        aria-label={t("Phone")}
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
      />
      <Input
        type="email"
        placeholder={t("Email")}
        aria-label={t("Email")}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Input
        placeholder={t("Website")}
        aria-label={t("Website")}
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
      />
      <Input
        placeholder={t("Notes")}
        aria-label={t("Notes")}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />

      <div className="flex gap-3">
        <label className="min-w-0 flex-1 space-y-2">
          <span className={fieldLabel}>{t("Opens")}</span>
          <input
            type="time"
            value={open}
            onChange={(e) => setOpen(e.target.value)}
            className={`${timeInput} w-full`}
          />
        </label>
        <label className="min-w-0 flex-1 space-y-2">
          <span className={fieldLabel}>{t("Closes")}</span>
          <input
            type="time"
            value={close}
            onChange={(e) => setClose(e.target.value)}
            className={`${timeInput} w-full`}
          />
        </label>
      </div>

      <div className="space-y-2">
        <p className={fieldLabel}>{t("Still there near closing")}</p>
        <ChipGroup<Lead>
          options={LEADS.map((v) => ({
            value: v,
            label: v === "off" ? t("Off") : `${v} ${t("min")}`,
          }))}
          value={lead}
          onChange={setLead}
        />
        <p className="text-xs text-muted">
          {t(
            "One notification this long before closing if she has not been picked up, to whoever the plan says collects her that day, or to the parents when it names nobody.",
          )}
        </p>
      </div>

      {babies.length > 0 && (
        <div className="space-y-2">
          <p className={fieldLabel}>{t("Who goes here")}</p>
          <MultiChipGroup
            options={babies.map((b) => ({ value: b.id, label: b.name }))}
            values={babyIds}
            onToggle={(id) =>
              setBabyIds((prev) =>
                prev.includes(id)
                  ? prev.filter((x) => x !== id)
                  : [...prev, id],
              )
            }
          />
        </div>
      )}

      <Button
        size="full"
        onClick={submit}
        disabled={save.isPending || name.trim().length === 0}
      >
        {t("Save")}
      </Button>
      {!place && onDone && (
        <Button size="full" variant="ghost" onClick={onDone}>
          {t("Cancel")}
        </Button>
      )}
      {place && (
        <DeleteButton onDelete={() => remove.mutate({ id: place.id })} />
      )}
    </Card>
  );
}

// One baby's week. The time is when you EXPECT to collect her — shown on
// Home, and nothing fires on it; the person is who hears near closing.
function PickupPlanCard({ baby, isAdmin }: { baby: Baby; isAdmin: boolean }) {
  const plan = usePickupPlan(baby.id);
  const setPlan = useSetPickupPlan();
  const me = useMe();
  const members = useMembers();
  const faces = caretakerOptions(members.data ?? [], me.data?.userId);
  const [draft, setDraft] = useState<PickupPlanDay[] | null>(null);
  const days = draft ?? planGrid(plan.data);

  const patch = (weekday: number, change: Partial<PickupPlanDay>) =>
    setDraft(
      days.map((d) => (d.weekday === weekday ? { ...d, ...change } : d)),
    );

  return (
    <>
      <SectionTitle>{`${t("Pick-up plan")} · ${baby.name}`}</SectionTitle>
      <Card
        className="divide-y divide-line p-0"
        data-testid={`pickup-plan-${baby.id}`}
      >
        {days.map((day) =>
          isAdmin ? (
            <div key={day.weekday} className="space-y-2 px-4 py-3">
              <div className="flex items-center gap-3">
                <p className="w-24 shrink-0 text-sm font-semibold text-ink">
                  {weekdayLabel(day.weekday)}
                </p>
                <input
                  type="time"
                  aria-label={`${weekdayLabel(day.weekday)}: ${t("Pick-up")}`}
                  value={day.minute === null ? "" : minuteClock(day.minute)}
                  onChange={(e) =>
                    patch(day.weekday, { minute: clockMinute(e.target.value) })
                  }
                  className={timeInput}
                />
              </div>
              <PersonChips
                faces={faces}
                value={day.userId}
                label={`${weekdayLabel(day.weekday)}: ${t("Who")}`}
                // A second tap on the chosen face names nobody again.
                onChange={(userId) =>
                  patch(day.weekday, {
                    userId: userId === day.userId ? null : userId,
                  })
                }
              />
            </div>
          ) : (
            <PlanLine
              key={day.weekday}
              day={day}
              members={members.data ?? []}
            />
          ),
        )}
      </Card>
      {isAdmin && (
        <div className="space-y-2 pt-3">
          <Button
            size="full"
            disabled={!draft || setPlan.isPending}
            onClick={() =>
              setPlan.mutate(
                { babyId: baby.id, days },
                {
                  onSuccess: () => {
                    setDraft(null);
                    toast(t("Saved"));
                  },
                },
              )
            }
          >
            {t("Save plan")}
          </Button>
          <p className="px-1 text-xs text-muted">
            {t(
              "The time is when you expect to collect her. It shows on Home while she is there; nothing reminds you of it. Someone else on one day? Set it on the day itself, from Home.",
            )}
          </p>
        </div>
      )}
    </>
  );
}

function PlanLine({ day, members }: { day: PickupPlanDay; members: Member[] }) {
  const who = members.find((m) => m.userId === day.userId);
  const parts = [
    day.minute !== null ? minuteClock(day.minute) : null,
    who ? firstName(who) : null,
  ].filter(Boolean);
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <p className="w-24 shrink-0 text-sm font-semibold text-ink">
        {weekdayLabel(day.weekday)}
      </p>
      <p className="text-sm text-ink-soft tabular-nums">
        {parts.length > 0 ? parts.join(" · ") : "—"}
      </p>
    </div>
  );
}

function PersonChips({
  faces,
  value,
  label,
  onChange,
}: {
  faces: Member[];
  value: string | null;
  label: string;
  onChange: (userId: string) => void;
}) {
  return (
    <fieldset aria-label={label} className="flex gap-2 overflow-x-auto">
      <ChipGroup
        className="flex-nowrap"
        options={faces.map((m) => ({
          value: m.userId,
          label: firstName(m),
          leading: (
            <Avatar src={m.avatarUrl} name={m.name || m.email} size={8} />
          ),
        }))}
        value={value}
        onChange={onChange}
      />
    </fieldset>
  );
}
