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
import { IconBabyBottle, IconMoon, IconRuler } from "@tabler/icons-react";
import type { Baby } from "@pjokk/shared";
import { ErrorState } from "@/components/QueryStates";
import { ChipGroup } from "@/components/Chips";
import { Card } from "@/components/ui/card";
import { OtherLogSheet } from "@/components/sheets/OtherLogSheet";
import { BabySwitcher } from "@/components/BabySwitcher";
import { useMeasurements, useStats } from "@/lib/data";
import { useSelectedBaby } from "@/lib/selected-baby";
import {
  ageInMonths,
  formatPercentile,
  referenceCurves,
  referenceWeight,
  weightPercentile,
} from "@/lib/growth";
import { t } from "@/lib/i18n";
import { formatRelative } from "@/lib/time";
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
}: {
  icon: typeof IconMoon;
  tint: string;
  label: string;
  value: string;
  sub?: string;
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
    </Card>
  );
}

// WHO growth chart: the baby's weights against the P3/P50/P97 reference
// curves for their sex. Rendered only when sex is set and there's data.
function GrowthChart({ baby }: { baby: Baby }) {
  const measurements = useMeasurements(baby.id);
  const sex = baby.sex;
  if (!sex) return null;

  const weights = (measurements.data ?? [])
    .filter((m) => m.type === "weight")
    .map((m) => ({
      age: ageInMonths(new Date(baby.birthDate), new Date(m.time)),
      kg: m.value,
    }))
    .filter((m) => m.age >= 0 && m.age <= 60)
    .sort((a, b) => a.age - b.age);
  if (weights.length === 0) return null;

  const maxAge = Math.min(
    60,
    Math.max(12, Math.ceil(weights[weights.length - 1]!.age) + 2),
  );
  const chartData: Record<string, number | null>[] = [];
  for (let m = 0; m <= maxAge; m++) {
    const row: Record<string, number | null> = { age: m };
    for (const curve of referenceCurves) {
      row[curve.label] = referenceWeight(sex, m, curve.z);
    }
    chartData.push(row);
  }
  for (const w of weights) {
    chartData.push({ age: w.age, baby: w.kg });
  }
  chartData.sort((a, b) => (a.age ?? 0) - (b.age ?? 0));

  return (
    <Card>
      <p className="pb-3 text-xs font-semibold tracking-wide text-muted uppercase">
        {t("Growth (WHO weight-for-age)")}
      </p>
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
  const [days, setDays] = useState<1 | 7 | 30>(7);
  const [measureOpen, setMeasureOpen] = useState(false);
  const stats = useStats(baby?.id, days);
  const s = stats.data;

  const chartData = (s?.days ?? []).map((d) => {
    const date = new Date(`${d.date}T00:00:00`);
    return {
      label:
        days === 30
          ? String(date.getDate())
          : weekdayFmt.format(date).replace(".", ""),
      hours: Math.round((d.sleepMin / 60) * 10) / 10,
    };
  });

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
    <div className="mx-auto max-w-md px-4 pt-safe">
      <div className="flex items-center justify-between gap-2 pt-4 pb-2">
        <h1 className="text-2xl font-extrabold text-ink">{t("Stats")}</h1>
        <BabySwitcher compact />
      </div>
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
        {stats.isError && <ErrorState onRetry={() => void stats.refetch()} />}
        <div className="flex gap-3">
          <StatCard
            icon={IconMoon}
            tint="text-sleep"
            label={days === 1 ? t("Sleep today") : t("Sleep / day")}
            value={s ? sleepFmt(s.avgSleepMin) : "—"}
          />
          <StatCard
            icon={IconBabyBottle}
            tint="text-feed"
            label={days === 1 ? t("Intake today") : t("Intake / day")}
            value={s ? `${s.avgIntakeMl} ml` : "—"}
            sub={
              s
                ? `${s.avgFeeds} ${t("feeds")} · ${s.avgDiapers} ${t("diapers")}`
                : undefined
            }
          />
        </div>

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
                  formatter={(value) => [`${value as number} ${t("h")}`, null]}
                  labelStyle={{ color: "var(--color-muted)" }}
                />
                <Bar
                  dataKey="hours"
                  fill="var(--color-sleep)"
                  radius={[5, 5, 0, 0]}
                  maxBarSize={days === 30 ? 8 : 28}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

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
                {s.weight.value.toFixed(1)} kg
                {weightDelta != null && (
                  <span className="ml-1.5 font-medium text-ink-soft">
                    {weightDelta >= 0 ? "+" : "−"}
                    {Math.abs(weightDelta)} g
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
        {baby && (
          <OtherLogSheet
            open={measureOpen}
            onOpenChange={setMeasureOpen}
            babyId={baby.id}
            kind="measurement"
          />
        )}

        {baby && <GrowthChart baby={baby} />}
      </div>
    </div>
  );
}
