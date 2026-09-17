import type { Baby, MedicineCatalogueEntry } from "@pjokk/shared";
import { medicineIntervalLabel } from "@/lib/medicine-ui";

// A medicine sheet for the barnehage (issue #113). Staff may not give a
// child medicine without the parents' written instructions; families write
// that out by hand from a catalogue they already keep in Pjokk. One page,
// built in the browser, with the family's OWN entries and blank lines for
// what only a pen can add: when to give it, and a signature.
//
// The app states no dosing data of its own here either (issue #49): every
// number on the page is one the family typed into its catalogue.

export type MedicineSheetRow = { name: string; dose: string; interval: string };

export function medicineSheetRows(
  entries: MedicineCatalogueEntry[],
  t: (s: string) => string,
): MedicineSheetRow[] {
  return entries
    .filter((m) => !m.archived)
    .map((m) => ({
      name: m.isSupplement ? `${m.name} (${t("supplement")})` : m.name,
      dose:
        m.defaultAmount != null
          ? `${m.defaultAmount} ${m.unit ?? ""}`.trim()
          : "",
      interval: m.minIntervalMin
        ? `${t("at least")} ${medicineIntervalLabel(m.minIntervalMin)} ${t("apart")}`
        : "",
    }));
}

/** pjokk-<baby>-medicines.pdf, ASCII-safe (the report's slug rule). */
export function medicineSheetFilename(babyName: string): string {
  const slug =
    babyName
      .toLowerCase()
      .replace(/ø/g, "o")
      .replace(/æ/g, "ae")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "baby";
  return `pjokk-${slug}-medicines.pdf`;
}

export async function buildMedicineSheet(opts: {
  baby: Baby;
  rows: MedicineSheetRow[];
  t: (s: string) => string;
  now?: Date;
}): Promise<void> {
  const { baby, rows, t } = opts;
  const now = opts.now ?? new Date();
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const margin = 18;
  const width = 210 - margin * 2;
  let y = margin + 4;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text(`${t("Medicine at daycare")} · ${baby.name}`, margin, y);
  y += 7;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text(
    `${t("Born")} ${new Date(baby.birthDate).toLocaleDateString("nb-NO")} · ${now.toLocaleDateString("nb-NO")}`,
    margin,
    y,
  );
  doc.setTextColor(0);
  y += 11;

  const blank = (label: string) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(110);
    doc.text(label, margin, y);
    doc.setTextColor(0);
    doc.setDrawColor(170);
    doc.line(margin + 42, y + 0.5, margin + width, y + 0.5);
    y += 8;
  };

  for (const row of rows) {
    if (y > 297 - margin - 46) {
      doc.addPage();
      y = margin + 4;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(row.name, margin, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10.5);
    const facts = [row.dose && `${t("Dose")}: ${row.dose}`, row.interval]
      .filter(Boolean)
      .join("   ·   ");
    if (facts) {
      doc.text(facts, margin, y);
      y += 7;
    }
    blank(t("Give it when"));
    blank(t("How"));
    blank(t("From / until"));
    y += 4;
  }

  if (y > 297 - margin - 30) {
    doc.addPage();
    y = margin + 4;
  }
  y += 4;
  blank(t("Parent's signature"));
  blank(t("Date"));

  doc.setFontSize(8);
  doc.setTextColor(140);
  doc.text(
    t(
      "Doses and intervals are the family's own entries in Pjokk, not advice from the app.",
    ),
    margin,
    297 - 10,
  );
  doc.save(medicineSheetFilename(baby.name));
}
