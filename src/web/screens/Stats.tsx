import { useState } from "react";
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";
import { Moon, Milk, Ruler } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useBabies, useStats } from "@/lib/data";
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
  icon: typeof Moon;
  tint: string;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card className="flex-1">
      <div className={cn("mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-surface-2", tint)}>
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

export function StatsScreen() {
  const babies = useBabies();
  const baby = babies.data?.[0];
  const [days, setDays] = useState<7 | 30>(7);
  const stats = useStats(baby?.id, days);
  const s = stats.data;

  const chartData = (s?.days ?? []).map((d) => {
    const date = new Date(`${d.date}T00:00:00`);
    return {
      label:
        days === 7
          ? weekdayFmt.format(date).replace(".", "")
          : String(date.getDate()),
      hours: Math.round((d.sleepMin / 60) * 10) / 10,
    };
  });

  const rangeChip = (value: 7 | 30, label: string) => (
    <button
      type="button"
      onClick={() => setDays(value)}
      className={cn(
        "h-9 rounded-full border px-4 text-sm font-semibold transition-colors select-none",
        days === value
          ? "border-accent bg-accent text-white"
          : "border-line bg-surface text-ink-soft",
      )}
    >
      {label}
    </button>
  );

  const weightDelta =
    s?.weight?.prevValue != null
      ? Math.round((s.weight.value - s.weight.prevValue) * 1000)
      : null;

  return (
    <div className="mx-auto max-w-md px-4 pt-safe">
      <div className="flex items-center justify-between py-4">
        <h1 className="text-2xl font-extrabold text-ink">{t("Stats")}</h1>
        <div className="flex gap-2">
          {rangeChip(7, t("Week"))}
          {rangeChip(30, t("Month"))}
        </div>
      </div>

      <div className="space-y-3 pb-tabbar">
        <div className="flex gap-3">
          <StatCard
            icon={Moon}
            tint="text-sleep"
            label={t("Sleep / day")}
            value={s ? sleepFmt(s.avgSleepMin) : "—"}
          />
          <StatCard
            icon={Milk}
            tint="text-feed"
            label={t("Intake / day")}
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
              <BarChart data={chartData} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  interval={days === 7 ? 0 : 4}
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
                  maxBarSize={days === 7 ? 28 : 8}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-growth">
            <Ruler className="h-5 w-5" />
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
                  {formatRelative(new Date(s.weight.time))} ·{" "}
                  {t("percentile curves come later")}
                </span>
              </p>
            ) : (
              <p className="text-sm text-muted">
                {t("Log a weight under More → Measurement")}
              </p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
