import { useState } from "react";
import {
  Bar,
  BarChart,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  IconBabyBottle,
  IconMoon,
  IconMoonStars,
  IconRuler,
} from "@tabler/icons-react";
import type { Baby } from "@pjokk/shared";
import { ErrorState } from "@/components/QueryStates";
import { ChipGroup } from "@/components/Chips";
import { Card } from "@/components/ui/card";
import { OtherLogSheet } from "@/components/sheets/OtherLogSheet";
import { BabyHeader } from "@/components/BabyHeader";
import { useMeasurements, useStats } from "@/lib/data";
import { useSelectedBaby } from "@/lib/selected-baby";
import { useTracking } from "@/lib/tracking";
import {
  ageInMonths,
  formatPercentile,
  type GrowthType,
  referenceCurves,
  referenceValue,
  weightPercentile,
} from "@/lib/growth";
import { measurementMeta } from "@/lib/measurements";
import { t } from "@/lib/i18n";
import { daycareMeta } from "@/lib/daycare-ui";
import { illnessMeta } from "@/lib/illness-ui";
import { dayGroupLine, illLine, lastNight, napLine } from "@/lib/stats-ui";
import {
  KG_PER_LB,
  formatMeasurementIn,
  formatVolume,
  measurementScale,
  measurementUnit,
  useUnits,
} from "@/lib/units";
import { formatDay, formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";

function sleepFmt(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} ${t("h")}` : `${h} ${t("h")} ${m} ${t("m")}`;
}

const weekdayFmt = new Intl.DateTimeFormat("nb-NO", { weekday: "short" });

function StatCard({
  icon: Icon,
  tint,
  label,
  value,
  sub,
  sub2,
}: {
  icon: typeof IconMoon;
  tint: string;
  label: string;
  value: string;
  sub?: string;
  sub2?: string;
}) {
  return (
    <Card className="flex-1">
      <div
        className={cn(
          "mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-surface-2",
          tint,
        )}
      >
        <Icon className="h-4.5 w-4.5" />
      </div>
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">
        {label}
      </p>
      <p className="text-xl font-extrabold text-ink">{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
      {sub2 && <p className="text-xs text-muted">{sub2}</p>}
    </Card>
  );
}

const growthTitle: Record<GrowthType, string> = {
  weight: "Growth (WHO weight-for-age)",
  length: "Growth (WHO length-for-age)",
  head: "Growth (WHO head-for-age)",
};

// WHO growth chart: the baby's measurements of one type against the
// P3/P50/P97 reference curves for their sex (issue #47 added length and
// head next to weight; the chips only show the types with data). Rendered
// only when sex is set and there's data.
function GrowthChart({ baby }: { baby: Baby }) {
  const measurements = useMeasurements(baby.id);
  const units = useUnits();
  const [type, setType] = useState<GrowthType>("weight");
  const sex = baby.sex;
  if (!sex) return null;

  const rows = (measurements.data ?? [])
    .map((m) => ({
      type: m.type,
      age: ageInMonths(new Date(baby.birthDate), new Date(m.time)),
      value: m.value,
    }))
    .filter((m) => m.age >= 0 && m.age <= 60);
  const available = (["weight", "length", "head"] as GrowthType[]).filter((g) =>
    rows.some((r) => r.type === g),
  );
  if (available.length === 0) return null;
  // The first type with data, when the chosen one has none yet.
  const shown = available.includes(type) ? type : available[0]!;
  const points = rows
    .filter((r) => r.type === shown)
    .sort((a, b) => a.age - b.age);

  const maxAge = Math.min(
    60,
    Math.max(12, Math.ceil(points[points.length - 1]!.age) + 2),
  );
  // The WHO maths runs on canonical values; only the plotted numbers are
  // converted, so the curves and the dots move together.
  const scale = measurementScale(shown, units);
  const conv = (v: number | null) => (v == null ? null : scale.toDisplay(v));
  const chartData: Record<string, number | null>[] = [];
  for (let m = 0; m <= maxAge; m++) {
    const row: Record<string, number | null> = { age: m };
    for (const curve of referenceCurves) {
      row[curve.label] = conv(referenceValue(shown, sex, m, curve.z));
    }
    chartData.push(row);
  }
  for (const p of points) {
    chartData.push({ age: p.age, baby: scale.toDisplay(p.value) });
  }
  chartData.sort((a, b) => (a.age ?? 0) - (b.age ?? 0));

  return (
    <Card>
      <p className="pb-3 text-xs font-semibold tracking-wide text-muted uppercase">
        {t(growthTitle[shown])}
      </p>
      {available.length > 1 && (
        <ChipGroup
          className="pb-3"
          options={available.map((g) => ({
            value: g,
            label: `${t(measurementMeta[g].label)} (${measurementUnit(g, units)})`,
          }))}
          value={shown}
          onChange={setType}
        />
      )}
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={chartData}
            margin={{ top: 4, right: 4, left: -22, bottom: 0 }}
          >
            <XAxis
              dataKey="age"
              type="number"
              domain={[0, maxAge]}
              tickCount={Math.min(7, maxAge + 1)}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "var(--color-muted)" }}
            />
            <YAxis
              domain={["auto", "auto"]}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "var(--color-muted)" }}
            />
            {referenceCurves.map((curve) => (
              <Line
                key={curve.label}
                dataKey={curve.label}
                stroke="var(--color-line)"
                strokeWidth={curve.z === 0 ? 2 : 1}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ))}
            <Scatter
              dataKey="baby"
              fill="var(--color-growth)"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="pt-1 text-[11px] text-muted">
        {t("Reference lines: WHO P3 / P50 / P97 · months on the x-axis")}
      </p>
    </Card>
  );
}

export function StatsScreen() {
  const { baby } = useSelectedBaby();
  // Each card follows its switch (spec
  // 2026-09-17-per-baby-tracking-design.md).
  const track = useTracking(baby);
  const [days, setDays] = useState<1 | 7 | 30>(7);
  const [measureOpen, setMeasureOpen] = useState(false);
  const stats = useStats(baby?.id, days);
  const units = useUnits();
  const s = stats.data;

  const chartData = (s?.days ?? []).map((d) => {
    const date = new Date(`${d.date}T00:00:00`);
    // Stacked: night on the bottom, day sleep (naps + untyped) on top,
    // both in the sleep tint (issue #50 — two shades, not a new colour).
    return {
      label:
        days === 30
          ? String(date.getDate())
          : weekdayFmt.format(date).replace(".", ""),
      night: Math.round((d.nightSleepMin / 60) * 10) / 10,
      day: Math.round(((d.sleepMin - d.nightSleepMin) / 60) * 10) / 10,
      // `?? false`: absent from a snapshot cached before the field existed.
      date: d.date,
      daycare: d.daycare ?? false,
      ill: d.ill ?? false,
    };
  });
  const anyDaycare = track.has("daycare") && chartData.some((d) => d.daycare);
  const anyIll = track.has("illness") && chartData.some((d) => d.ill);
  const ill = s
    ? illLine(s.illDays ?? 0, s.illEpisodes ?? 0, s.days.length, {
        of: t("of"),
        days: t("days"),
        episode: t("episode"),
        episodes: t("episodes"),
      })
    : null;
  const split = s?.daycareSplit ?? null;
  const night = s ? lastNight(s.nights) : null;
  // "3.2 bottle · 1.5 breast" — only the types with any feeds at all.
  const feedTypes = s
    ? (
        [
          ["bottle", s.avgFeedsByType.bottle],
          ["breast", s.avgFeedsByType.breast],
          ["solids", s.avgFeedsByType.solids],
        ] as const
      )
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${v} ${t(k)}`)
        .join(" · ")
    : "";

  const weightDelta =
    s?.weight?.prevValue != null
      ? Math.round((s.weight.value - s.weight.prevValue) * 1000)
      : null;

  const percentile =
    s?.weight && baby?.sex
      ? weightPercentile(
          baby.sex,
          ageInMonths(new Date(baby.birthDate), new Date(s.weight.time)),
          s.weight.value,
        )
      : null;

  return (
    <div className="mx-auto max-w-md px-4 pt-safe md:max-w-3xl md:px-6">
      <BabyHeader />
      <div className="flex items-center justify-between gap-2 pt-1 pb-2">
        <h1 className="text-2xl font-extrabold text-ink">{t("Stats")}</h1>
      </div>
      {!track.has("sleep") && !track.has("feeds") ? (
        <p
          className="py-16 text-center text-sm text-muted"
          data-testid="stats-off"
        >
          {t("Turn on Sleep or Feeds to see stats")}
        </p>
      ) : (
        <>
          {/* Own row: sharing the title line made the chips wrap on narrow
          phones. */}
          <ChipGroup
            className="pb-3"
            options={[
              { value: "1", label: t("Day") },
              { value: "7", label: t("Week") },
              { value: "30", label: t("Month") },
            ]}
            value={String(days)}
            onChange={(v) => setDays(Number(v) as 1 | 7 | 30)}
          />

          <div className="space-y-3 pb-tabbar">
            {stats.isError && (
              <ErrorState onRetry={() => void stats.refetch()} />
            )}
            <div className="flex gap-3">
              {track.has("sleep") && (
                <StatCard
                  icon={IconMoon}
                  tint="text-sleep"
                  label={days === 1 ? t("Sleep today") : t("Sleep / day")}
                  value={s ? sleepFmt(s.avgSleepMin) : "—"}
                  sub={
                    s
                      ? `${sleepFmt(s.avgNightSleepMin)} ${t("night")} · ${sleepFmt(s.avgSleepMin - s.avgNightSleepMin)} ${t("day")}`
                      : undefined
                  }
                  sub2={
                    napLine(s?.avgNapMin ?? 0, s?.avgNaps ?? 0, sleepFmt, {
                      nap: t("Nap"),
                      naps: t("naps"),
                    }) ?? undefined
                  }
                />
              )}
              {track.has("feeds") && (
                <StatCard
                  icon={IconBabyBottle}
                  tint="text-feed"
                  label={days === 1 ? t("Intake today") : t("Intake / day")}
                  value={s ? formatVolume(s.avgIntakeMl, units) : "—"}
                  sub={
                    s
                      ? `${s.avgFeeds} ${t("feeds")}${track.has("diapers") ? ` · ${s.avgDiapers} ${t("diapers")}` : ""}`
                      : undefined
                  }
                  sub2={feedTypes || undefined}
                />
              )}
            </div>

            {/* The number a parent of a newborn asks the next morning (issue
            #50): the longest single night session, with the trend against
            the window's earlier nights the way the weight row shows its Δ. */}
            {track.has("sleep") && (
              <Card className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-sleep">
                  <IconMoonStars className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                    {t("Longest stretch")}
                  </p>
                  {night ? (
                    <p className="text-base font-bold text-ink">
                      {sleepFmt(night.night.longestStretchMin)}
                      {night.deltaMin != null && night.deltaMin !== 0 && (
                        <span className="ml-1.5 font-medium text-ink-soft">
                          {night.deltaMin > 0 ? "+" : "−"}
                          {sleepFmt(Math.abs(night.deltaMin))}
                        </span>
                      )}
                      <span className="block text-xs font-medium text-muted">
                        {night.night.wakings === 1
                          ? `1 ${t("waking")}`
                          : `${night.night.wakings} ${t("wakings")}`}
                        {" · "}
                        {t("night of")}{" "}
                        {formatDay(new Date(`${night.night.date}T00:00:00`))}
                      </span>
                    </p>
                  ) : (
                    <p className="text-sm text-muted">
                      {t(
                        "Log a night sleep to see last night's longest stretch",
                      )}
                    </p>
                  )}
                </div>
              </Card>
            )}

            {track.has("sleep") && (
              <Card>
                <p className="pb-3 text-xs font-semibold tracking-wide text-muted uppercase">
                  {t("Sleep per day")}
                </p>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={chartData}
                      margin={{ top: 4, right: 0, left: 0, bottom: 0 }}
                    >
                      <XAxis
                        dataKey="label"
                        tickLine={false}
                        axisLine={false}
                        interval={days === 30 ? 4 : 0}
                        tick={{
                          fontSize: 11,
                          fill: "var(--color-muted)",
                        }}
                      />
                      <Tooltip
                        cursor={{ fill: "var(--color-surface-2)" }}
                        contentStyle={{
                          background: "var(--color-surface)",
                          border: "1px solid var(--color-line)",
                          borderRadius: 12,
                          fontSize: 12,
                          color: "var(--color-ink)",
                        }}
                        formatter={(value, name) => [
                          `${value as number} ${t("h")}`,
                          name === "night" ? t("Night") : t("Day"),
                        ]}
                        labelStyle={{ color: "var(--color-muted)" }}
                      />
                      <Bar
                        dataKey="night"
                        stackId="sleep"
                        fill="var(--color-sleep)"
                        maxBarSize={days === 30 ? 8 : 28}
                      />
                      <Bar
                        dataKey="day"
                        stackId="sleep"
                        fill="var(--color-sleep)"
                        fillOpacity={0.45}
                        radius={[5, 5, 0, 0]}
                        maxBarSize={days === 30 ? 8 : 28}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {(anyDaycare || anyIll) && (
                  // Barnehage days (issue #111) and ill days (issue #127), marked
                  // under their bars. An HTML row rather than a chart series: the
                  // chart has no margins and no Y axis, so n equal cells sit
                  // exactly under n bands. Two SHAPES, a dot and a ring, because
                  // the accent and the coral are close, colour alone fails for
                  // colour blindness, and night mode collapses both onto amber.
                  <>
                    <div
                      className="flex pt-1"
                      aria-hidden
                      data-testid="daycare-marks"
                    >
                      {chartData.map((d) => (
                        <span
                          key={d.date}
                          className="flex h-1.5 flex-1 justify-center gap-0.5"
                        >
                          {/* Only the marks that apply, so one mark sits centred
                        under its bar and two sit either side of the centre:
                        a reserved-but-invisible slot pushed a lone ring off
                        its label. The fixed height keeps an empty cell's
                        row. */}
                          {d.daycare && (
                            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                          )}
                          {d.ill && (
                            <span
                              data-ill="true"
                              className="h-1.5 w-1.5 rounded-full border border-growth"
                            />
                          )}
                        </span>
                      ))}
                    </div>
                    <p className="flex flex-wrap gap-x-4 pt-2 text-xs text-muted">
                      {anyDaycare && (
                        <span>
                          <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" />
                          {t("at daycare that day")}
                        </span>
                      )}
                      {anyIll && (
                        <span>
                          <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full border border-growth align-middle" />
                          {t("ill that day")}
                        </span>
                      )}
                    </p>
                  </>
                )}
              </Card>
            )}

            {track.has("illness") && ill && (
              // "How much has she actually been ill?" (issue #127) One quiet
              // row, only when the window has any: a healthy month needs none.
              <Card className="flex items-center gap-3" data-testid="ill-days">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-growth">
                  <illnessMeta.icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                    {t("Ill days")}
                  </p>
                  <p
                    className="text-base font-bold text-ink"
                    data-testid="ill-days-value"
                  >
                    {ill}
                  </p>
                </div>
              </Card>
            )}

            {track.has("daycare") && split && (
              // Is the barnehage rhythm costing sleep? (issue #111) One card,
              // two lines, only once the window holds both kinds of day.
              <Card
                className="flex items-start gap-3"
                data-testid="daycare-split"
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-accent">
                  <daycareMeta.icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                    {t("Daycare days and home days")}
                  </p>
                  {(
                    [
                      ["Daycare days", split.daycare],
                      ["Home days", split.home],
                    ] as const
                  ).map(([label, g]) => (
                    <p key={label} className="text-sm text-ink">
                      <span className="font-bold">
                        {t(label)} ({g.days})
                      </span>
                      <span className="block text-ink-soft">
                        {dayGroupLine(g, sleepFmt, {
                          nap: t("nap"),
                          bed: t("bed"),
                          night: t("night"),
                        })}
                      </span>
                    </p>
                  ))}
                </div>
              </Card>
            )}

            {track.has("measurements") && (
              <button
                type="button"
                onClick={() => setMeasureOpen(true)}
                className="flex w-full items-center gap-3 rounded-xl2 border border-line bg-surface p-4 text-left active:bg-surface-2"
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-growth">
                  <IconRuler className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                    {t("Weight")}
                  </p>
                  {s?.weight ? (
                    <p className="text-base font-bold text-ink">
                      {formatMeasurementIn("weight", s.weight.value, units)}
                      {weightDelta != null && (
                        <span className="ml-1.5 font-medium text-ink-soft">
                          {weightDelta >= 0 ? "+" : "−"}
                          {units === "imperial"
                            ? `${(Math.abs(weightDelta) / 1000 / KG_PER_LB).toFixed(2)} lb`
                            : `${Math.abs(weightDelta)} g`}
                        </span>
                      )}
                      <span className="block text-xs font-medium text-muted">
                        {formatRelative(new Date(s.weight.time))}
                        {percentile != null
                          ? ` · ${t("~")}${formatPercentile(percentile)}${t(". percentile (WHO)")}`
                          : baby?.sex
                            ? ""
                            : ` · ${t("set sex in Settings for percentiles")}`}
                      </span>
                    </p>
                  ) : (
                    <p className="text-sm text-muted">
                      {t("Log a weight under More → Measurement")}
                    </p>
                  )}
                </div>
              </button>
            )}
            {baby && (
              <OtherLogSheet
                open={measureOpen}
                onOpenChange={setMeasureOpen}
                babyId={baby.id}
                kind="measurement"
              />
            )}

            {track.has("measurements") && baby && <GrowthChart baby={baby} />}
          </div>
        </>
      )}
    </div>
  );
}
