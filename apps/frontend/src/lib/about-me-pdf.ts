import type { Baby } from "@pjokk/shared";
import { type AboutSection, aboutFilename } from "@/lib/about-me";
import { t } from "@/lib/i18n";
import { formatAge } from "@/lib/time";

// The "About <name>" page (issue #109) as a PDF: one A4, built in the
// browser with the lazy-loaded jsPDF the report uses (lib/report.ts), never
// on the server. It prints exactly the sections it is handed — the preview
// in Settings and this file read the same list (lib/about-me.ts).
export async function buildAboutPdf(opts: {
  baby: Baby;
  sections: AboutSection[];
  now?: Date;
}): Promise<void> {
  const { baby, sections } = opts;
  const now = opts.now ?? new Date();
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const margin = 18;
  const width = 210 - margin * 2;
  const labelWidth = 48;
  let y = margin + 4;
  const room = (needed: number) => {
    if (y + needed > 297 - margin) {
      doc.addPage();
      y = margin + 4;
    }
  };

  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text(`${t("About")} ${baby.name}`, margin, y);
  y += 7;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(110);
  const birth = new Date(baby.birthDate);
  doc.text(
    `${t("Born")} ${birth.toLocaleDateString("nb-NO")} · ${formatAge(birth, now)} · ${now.toLocaleDateString("nb-NO")}`,
    margin,
    y,
  );
  doc.setTextColor(0);
  y += 10;

  for (const section of sections) {
    room(16);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(214, 118, 87);
    doc.text(section.title, margin, y);
    doc.setTextColor(0);
    y += 1.5;
    doc.setDrawColor(225);
    doc.line(margin, y, margin + width, y);
    y += 5.5;
    doc.setFontSize(10.5);
    for (const line of section.lines) {
      const value = doc.splitTextToSize(
        line.value,
        width - labelWidth,
      ) as string[];
      const label = doc.splitTextToSize(line.label, labelWidth - 4) as string[];
      const rows = Math.max(value.length, label.length);
      room(rows * 5 + 2);
      doc.setFont("helvetica", "bold");
      doc.text(label, margin, y);
      doc.setFont("helvetica", "normal");
      doc.text(value, margin + labelWidth, y);
      y += rows * 5 + 1.5;
    }
    y += 5;
  }

  doc.setFontSize(8);
  doc.setTextColor(140);
  doc.text(
    t(
      "Made with Pjokk from what the family has logged. Usual times are medians, rounded to five minutes.",
    ),
    margin,
    297 - 10,
  );
  doc.save(aboutFilename(baby.name));
}
