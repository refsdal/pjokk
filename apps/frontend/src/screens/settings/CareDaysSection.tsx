import { useState } from "react";
import { ChipGroup } from "@/components/Chips";
import { Stepper } from "@/components/Stepper";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { caretakerOptions, firstName } from "@/lib/caretaker-ui";
import { NAV_URL, totalLine } from "@/lib/care-days-ui";
import {
  useAddCareDay,
  useCareDays,
  useMe,
  useMembers,
  useRemoveCareDay,
  useSetCareDayQuota,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import { formatDay, toLocalDateInput } from "@/lib/time";
import { SectionTitle } from "./lib";

// Days at home with an ill child (issue #108): this year per caretaker
// against the number each set for themselves, the days themselves, and a
// way to add one after the fact. NAV's rule is reference text with a link;
// the app computes nothing about entitlement and ships no default.
export function CareDaysSection({ isAdmin }: { isAdmin: boolean }) {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const me = useMe();
  const members = useMembers();
  const days = useCareDays(year);
  const add = useAddCareDay();
  const remove = useRemoveCareDay();
  const setQuota = useSetCareDayQuota();

  const faces = caretakerOptions(members.data ?? [], me.data?.userId);
  const [who, setWho] = useState<string | null>(null);
  const [date, setDate] = useState(() => toLocalDateInput());
  const [fraction, setFraction] = useState<"1" | "0.5">("1");
  const userId = who ?? me.data?.userId ?? null;
  // Whose number is open in the stepper; null = none.
  const [editing, setEditing] = useState<string | null>(null);
  const [draftQuota, setDraftQuota] = useState(10);

  const thisYear = new Date().getFullYear();

  return (
    <>
      <SectionTitle>{t("Days at home with a sick child")}</SectionTitle>
      <Card className="space-y-4" data-testid="care-days">
        <div className="flex items-center justify-between">
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("Previous year")}
            onClick={() => setYear((y) => y - 1)}
          >
            ‹
          </Button>
          <p className="text-sm font-bold text-ink tabular-nums">{year}</p>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("Next year")}
            disabled={year >= thisYear}
            onClick={() => setYear((y) => y + 1)}
          >
            ›
          </Button>
        </div>

        {(days.data?.totals ?? []).map((total) => {
          const mine = total.userId === me.data?.userId;
          const canEdit = mine || isAdmin;
          return (
            <div key={total.userId} className="space-y-2">
              <div className="flex items-center gap-3">
                <p className="flex-1 truncate text-sm font-semibold text-ink">
                  {total.userName || t("Someone")}
                </p>
                <p
                  className="text-sm text-ink-soft tabular-nums"
                  data-testid={`care-total-${mine ? "me" : total.userId}`}
                >
                  {totalLine(total)}
                </p>
                {canEdit && editing !== total.userId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDraftQuota(total.quota ?? 10);
                      setEditing(total.userId);
                    }}
                  >
                    {total.quota === null ? t("Set days") : t("Change")}
                  </Button>
                )}
              </div>
              {editing === total.userId && (
                <div className="space-y-2">
                  <Stepper
                    value={draftQuota}
                    onChange={setDraftQuota}
                    step={1}
                    min={0}
                    max={60}
                    unit={t("days")}
                  />
                  <div className="flex gap-2">
                    <Button
                      className="flex-1"
                      variant="secondary"
                      onClick={() => {
                        setQuota.mutate({
                          userId: total.userId,
                          days: draftQuota,
                        });
                        setEditing(null);
                      }}
                    >
                      {t("Save")}
                    </Button>
                    <Button
                      className="flex-1"
                      variant="ghost"
                      onClick={() => {
                        setQuota.mutate({ userId: total.userId, days: null });
                        setEditing(null);
                      }}
                    >
                      {t("No number")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <p className="text-xs text-muted">
          {t(
            "Your own number, from your employer or NAV: usually 10 days a year with one or two children, 15 with three or more, doubled for a sole carer. Pjokk only counts.",
          )}{" "}
          <a
            href={NAV_URL}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            nav.no
          </a>
        </p>

        {(days.data?.days ?? []).length > 0 && (
          <div className="divide-y divide-line border-t border-line">
            {(days.data?.days ?? []).map((d) => (
              <div key={d.id} className="flex min-h-11 items-center gap-3 py-1">
                <p className="flex-1 truncate text-sm text-ink">
                  <span className="font-semibold">
                    {formatDay(new Date(`${d.date}T12:00:00`))}
                  </span>
                  <span className="text-ink-soft">
                    {" "}
                    · {d.userName || t("Someone")}
                    {d.fraction === 0.5 ? ` · ${t("half day")}` : ""}
                  </span>
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  onClick={() => remove.mutate({ id: d.id })}
                >
                  {t("Delete")}
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-3 border-t border-line pt-4">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">
            {t("Add a day")}
          </p>
          {faces.length > 1 && (
            <ChipGroup
              options={faces.map((m) => ({
                value: m.userId,
                label: firstName(m),
              }))}
              value={userId}
              onChange={setWho}
            />
          )}
          <input
            type="date"
            aria-label={t("Date")}
            value={date}
            max={toLocalDateInput()}
            onChange={(e) => setDate(e.target.value)}
            className="h-12 w-full rounded-xl2 border border-line bg-surface px-4 text-base text-ink"
          />
          <ChipGroup<"1" | "0.5">
            options={[
              { value: "1", label: t("Whole day") },
              { value: "0.5", label: t("Half day") },
            ]}
            value={fraction}
            onChange={setFraction}
          />
          <Button
            size="full"
            variant="secondary"
            disabled={add.isPending || !date || !userId}
            onClick={() =>
              userId &&
              add.mutate({
                date,
                userId,
                fraction: fraction === "1" ? 1 : 0.5,
              })
            }
          >
            {t("Add day")}
          </Button>
        </div>
      </Card>
    </>
  );
}
