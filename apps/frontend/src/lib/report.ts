import type {
  Baby,
  MeasurementLog,
  MedicineLog,
  Stats,
  VaccineDismissal,
  VaccineLog,
} from "@pjokk/shared";
import { client, unwrap } from "./api";
import { ageInMonths, formatPercentile, growthPercentile } from "./growth";
import { t } from "./i18n";
import { isFever, measurementMeta } from "./measurements";
import { lastNight } from "./stats-ui";
import { formatClock, formatDay } from "./time";
import { formatMeasurementIn, formatVolume, type Units } from "./units";
import { buildSchedule } from "./vaccine-programme";

// The PDF report (issue #53): the last 7 or 30 days for one baby, rendered
// in the browser with jsPDF from the same API reads the screens use.
// Health data never goes through a server-side renderer, and the library
// is loaded on demand — the SPA is embedded in the binary, so bundle size
// is image size. Tables, not charts: it is what a nurse reads.

export type ReportRange = 7 | 30;

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function minutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} ${t("min")}`;
  return m === 0 ? `${h} ${t("h")}` : `${h} ${t("h")} ${m} ${t("min")}`;
}

/** File name: pjokk-<baby>-<from>-<to>.pdf, ASCII-safe. */
export function reportFilename(babyName: string, from: Date, to: Date): string {
  // ø and æ have no decomposition, so NFD alone would drop them (Bjørn →
  // bjrn); map the Norwegian letters first.
  const slug =
    babyName
      .toLowerCase()
      .replace(/ø/g, "o")
      .replace(/æ/g, "ae")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "baby";
  return `pjokk-${slug}-${isoDay(from)}-${isoDay(to)}.pdf`;
}

export async function buildReport(opts: {
  baby: Baby;
  days: ReportRange;
  units: Units;
  now?: Date;
}): Promise<void> {
  const { baby, days, units } = opts;
  const now = opts.now ?? new Date();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const from = new Date(to);
  from.setDate(to.getDate() - (days - 1));
  const sinceMs = from.getTime();

  const [
    { jsPDF },
    { default: autoTable },
    stats,
    measurements,
    medicines,
    vaccines,
    dismissals,
  ] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
    unwrap<Stats>(
      client.GET("/api/stats", {
        params: {
          query: { babyId: baby.id, days, tz: now.getTimezoneOffset() },
        },
      }),
    ),
    unwrap<MeasurementLog[]>(
      client.GET("/api/measurements", {
        params: { query: { babyId: baby.id, limit: 100 } },
      }),
    ),
    unwrap<MedicineLog[]>(
      client.GET("/api/medicine", {
        params: { query: { babyId: baby.id, limit: 100 } },
      }),
    ),
    unwrap<VaccineLog[]>(
      client.GET("/api/vaccines", { params: { query: { babyId: baby.id } } }),
    ),
    unwrap<VaccineDismissal[]>(
      client.GET("/api/vaccines/dismissals", {
        params: { query: { babyId: baby.id } },
      }),
    ),
  ]);

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const margin = 14;
  let y = margin;
  const heading = (text: string) => {
    if (y > 260) {
      doc.addPage();
      y = margin;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text(text, margin, y);
    y += 2;
  };
  const table = (head: string[], body: (string | number)[][]) => {
    autoTable(doc, {
      startY: y + 2,
      head: [head],
      body: body.length ? body : [[t("Nothing in this period")]],
      margin: { left: margin, right: margin },
      styles: { fontSize: 9, cellPadding: 1.6 },
      headStyles: { fillColor: [214, 118, 87] },
      theme: "grid",
    });
    y =
      (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;
  };

  // ---- Title ----------------------------------------------------------
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text(`Pjokk · ${baby.name}`, margin, y);
  y += 7;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const birth = new Date(baby.birthDate);
  doc.text(
    `${t("Born")} ${formatDay(birth)} · ${t("Period")} ${formatDay(from)} – ${formatDay(to)} · ${t("Generated")} ${formatDay(now)} ${formatClock(now)}`,
    margin,
    y,
  );
  y += 8;

  // ---- Averages -------------------------------------------------------
  heading(t("Averages per day"));
  const night = lastNight(stats.nights);
  const fbt = stats.avgFeedsByType;
  table(
    [t("Measure"), t("Value")],
    [
      [
        t("Sleep"),
        `${minutes(stats.avgSleepMin)} (${minutes(stats.avgNightSleepMin)} ${t("night")})`,
      ],
      [
        t("Longest night stretch"),
        night
          ? `${minutes(night.night.longestStretchMin)} · ${night.night.wakings} ${t("wakings")} (${formatDay(new Date(`${night.night.date}T00:00:00`))})`
          : "—",
      ],
      [t("Intake"), formatVolume(stats.avgIntakeMl, units)],
      [
        t("Feeds"),
        `${stats.avgFeeds} (${fbt.bottle} ${t("bottle")} · ${fbt.breast} ${t("breast")} · ${fbt.solids} ${t("solids")})`,
      ],
      [t("Diapers"), String(stats.avgDiapers)],
    ],
  );

  // ---- Per day --------------------------------------------------------
  heading(t("Day by day"));
  table(
    [t("Date"), t("Sleep"), t("Night"), t("Intake"), t("Feeds"), t("Diapers")],
    stats.days.map((d) => [
      formatDay(new Date(`${d.date}T00:00:00`)),
      minutes(d.sleepMin),
      minutes(d.nightSleepMin),
      formatVolume(d.intakeMl, units),
      d.feeds,
      d.diapers,
    ]),
  );

  // ---- Growth ---------------------------------------------------------
  heading(t("Growth (latest)"));
  const latestOf = (type: MeasurementLog["type"]) =>
    measurements.find((m) => m.type === type) ?? null;
  const growthRows: (string | number)[][] = [];
  for (const type of ["weight", "length", "head"] as const) {
    const m = latestOf(type);
    if (!m) continue;
    const p = baby.sex
      ? growthPercentile(
          type,
          baby.sex,
          ageInMonths(birth, new Date(m.time)),
          m.value,
        )
      : null;
    growthRows.push([
      t(measurementMeta[type].label),
      formatDay(new Date(m.time)),
      formatMeasurementIn(type, m.value, units),
      p == null ? "—" : `${formatPercentile(p)}. ${t("percentile (WHO)")}`,
    ]);
  }
  table([t("Measure"), t("Date"), t("Value"), t("Percentile")], growthRows);

  // ---- Temperatures ---------------------------------------------------
  heading(t("Temperatures"));
  table(
    [t("When"), t("Value"), ""],
    measurements
      .filter((m) => m.type === "temperature" && Date.parse(m.time) >= sinceMs)
      .map((m) => [
        `${formatDay(new Date(m.time))} ${formatClock(new Date(m.time))}`,
        formatMeasurementIn("temperature", m.value, units),
        isFever("temperature", m.value) ? t("fever") : "",
      ]),
  );

  // ---- Medicines ------------------------------------------------------
  heading(t("Medicines given"));
  table(
    [t("When"), t("Medicine"), t("Dose")],
    medicines
      .filter((m) => Date.parse(m.time) >= sinceMs)
      .map((m) => [
        `${formatDay(new Date(m.time))} ${formatClock(new Date(m.time))}`,
        m.name,
        m.amount != null ? `${m.amount} ${m.unit ?? ""}`.trim() : "",
      ]),
  );

  // ---- Vaccines -------------------------------------------------------
  heading(t("Vaccines"));
  const schedule = buildSchedule(
    birth,
    vaccines,
    dismissals.map((d) => d.slotKey),
    now,
  );
  const statusWord = {
    given: t("Given"),
    due: t("Due"),
    upcoming: t("Upcoming"),
    dismissed: t("Skipped"),
  };
  table(
    [t("Vaccine"), t("Programme age"), t("Status"), t("Date")],
    schedule.map((r) => [
      `${r.slot.name}${r.slot.dose ? ` (${r.slot.dose})` : ""}`,
      `${r.slot.ageMonths} ${t("mo")}`,
      statusWord[r.status],
      r.entry ? formatDay(new Date(r.entry.time)) : "",
    ]),
  );

  // ---- Footer ---------------------------------------------------------
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(
      `${t("Made with Pjokk")} · ${units === "imperial" ? t("Imperial units") : t("Metric units")} · ${i}/${pages}`,
      margin,
      290,
    );
  }
  doc.save(reportFilename(baby.name, from, to));
}
