import { t } from "@/lib/i18n";

// Labels and detail-line formatting for the optional detail on the three
// core logs (issue #43): bottle contents, solids food + reaction, diaper
// colour/consistency, nap-vs-night. Kept out of the sheets and the timeline
// so the same words appear in both and can be unit-tested without React.
//
// Every label is an English source string passed through t() at the call
// site (CLAUDE.md's locale rule); the lowercase forms are what a timeline
// detail line reads ("120 ml · formula"), the capitalised ones are chips.

export type FeedContents = "formula" | "breast_milk" | "mixed";
export type FeedAppetite = "well" | "some" | "little";
export type DiaperColor =
  | "yellow"
  | "green"
  | "brown"
  | "black"
  | "red"
  | "other";
export type DiaperConsistency = "normal" | "loose" | "firm";
export type SleepType = "nap" | "night";

export const feedContentsOptions: { value: FeedContents; label: string }[] = [
  { value: "formula", label: "Formula" },
  { value: "breast_milk", label: "Breast milk" },
  { value: "mixed", label: "Mixed" },
];

// How much of a solids meal she ate (issue #113): what a barnehage reports,
// and what a parent knows about a lunch nobody weighed.
export const feedAppetiteOptions: { value: FeedAppetite; label: string }[] = [
  { value: "well", label: "Well" },
  { value: "some", label: "Some" },
  { value: "little", label: "Little" },
];

export const appetiteWord: Record<FeedAppetite, string> = {
  well: "ate well",
  some: "ate some",
  little: "ate little",
};

// Whether the solids sheet's grams are a measurement worth saving. The
// stepper always shows a number (last-value prefill), so an untouched one
// says nothing: stepping it always counts; otherwise an edit keeps what the
// row had (grams or none — a barnehage handover meal has none), and a new
// meal keeps the prefilled grams unless an appetite already says how it
// went. `editAmount` is undefined on create.
export function solidsAmountIsSaved(o: {
  touched: boolean;
  editAmount: number | null | undefined;
  appetite: FeedAppetite | null;
}): boolean {
  if (o.touched) return true;
  if (o.editAmount !== undefined) return o.editAmount !== null;
  return o.appetite === null;
}

export const diaperColorOptions: { value: DiaperColor; label: string }[] = [
  { value: "yellow", label: "Yellow" },
  { value: "green", label: "Green" },
  { value: "brown", label: "Brown" },
  { value: "black", label: "Black" },
  { value: "red", label: "Red" },
  { value: "other", label: "Other" },
];

export const diaperConsistencyOptions: {
  value: DiaperConsistency;
  label: string;
}[] = [
  { value: "normal", label: "Normal" },
  { value: "loose", label: "Loose" },
  { value: "firm", label: "Firm" },
];

const contentsWord: Record<FeedContents, string> = {
  formula: "formula",
  breast_milk: "breast milk",
  mixed: "mixed",
};

/** Detail line for a feed row: the amount first, then what the bottle held
 *  or what the solids were and how much of them she ate, then a reaction
 *  flag. Nulls simply drop out. */
export function feedDetail(
  amount: string | null,
  e: {
    type: "bottle" | "breast" | "solids";
    contents?: FeedContents | null;
    food?: string | null;
    appetite?: FeedAppetite | null;
    reaction?: boolean | null;
  },
): string | null {
  const parts = [
    amount,
    e.type === "bottle" && e.contents ? t(contentsWord[e.contents]) : null,
    e.type === "solids" && e.food ? e.food : null,
    e.type === "solids" && e.appetite ? t(appetiteWord[e.appetite]) : null,
    e.type === "solids" && e.reaction ? t("reaction") : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** Detail line for a diaper row: colour and consistency, lowercase. */
export function diaperDetail(e: {
  color?: DiaperColor | null;
  consistency?: DiaperConsistency | null;
}): string | null {
  const parts = [
    e.color ? t(e.color) : null,
    e.consistency ? t(e.consistency) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** Row title for a sleep entry: "Nap" / "Night sleep", or plain "Sleep" for
 *  rows logged before the type existed (or over the API without one). */
export function sleepTitle(type?: SleepType | null): string {
  if (type === "nap") return t("Nap");
  if (type === "night") return t("Night sleep");
  return t("Sleep");
}
