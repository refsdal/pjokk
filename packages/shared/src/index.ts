// The SPA's names for the API's shapes, all derived from the OpenAPI spec.
//
// openapi/pjokk.yaml is the single source of truth: oapi-codegen turns it
// into the Go server, and `bun run gen:client` turns it into
// ./api-schema.d.ts (generated — never edit it). This file only NAMES
// what that file already says, so a component can import `Baby` rather
// than spell `components["schemas"]["Baby"]`, and a shape changes in one
// place: the spec.
//
// It replaces schemas.ts, the zod layer left over from the TypeScript
// backend, which by then validated nothing and could silently disagree
// with the spec it was supposed to mirror.

import type { components, operations } from "./api-schema";

export type { components, operations, paths } from "./api-schema";

type Schemas = components["schemas"];

export type Baby = Schemas["Baby"];
export type FeedLog = Schemas["FeedLog"];
export type DiaperLog = Schemas["DiaperLog"];
export type SleepLog = Schemas["SleepLog"];
export type SleepLocation = Schemas["SleepLocation"];
export type Summary = Schemas["Summary"];
export type HelpRequest = Schemas["HelpRequest"];
export type Member = Schemas["Member"];
export type Invite = Schemas["Invite"];
export type Family = Schemas["Family"];
export type MedicineLog = Schemas["MedicineLog"];
export type BathLog = Schemas["BathLog"];
export type NoteLog = Schemas["NoteLog"];
export type MilestoneLog = Schemas["MilestoneLog"];
export type MilestonePhoto = Schemas["MilestonePhoto"];
export type MeasurementLog = Schemas["MeasurementLog"];
export type PumpLog = Schemas["PumpLog"];
export type MedicineCatalogueEntry = Schemas["MedicineCatalogueEntry"];
export type CreateMedicineCatalogueEntry =
  Schemas["CreateMedicineCatalogueEntry"];
export type UpdateMedicineCatalogueEntry =
  Schemas["UpdateMedicineCatalogueEntry"];
export type Stats = Schemas["Stats"];
export type StatsDay = Schemas["StatsDay"];
export type StatsNight = Schemas["StatsNight"];
export type ApiKey = Schemas["ApiKey"];
export type ApiKeyCreated = Schemas["ApiKeyCreated"];
export type CalendarEvent = Schemas["CalendarEvent"];
export type CreateCalendarEvent = Schemas["CreateCalendarEvent"];
export type UpdateCalendarEvent = Schemas["UpdateCalendarEvent"];
export type Contact = Schemas["Contact"];
export type CreateContact = Schemas["CreateContact"];
export type UpdateContact = Schemas["UpdateContact"];
export type PlayLog = Schemas["PlayLog"];
export type FeedTimer = Schemas["FeedTimer"];
export type VaccineLog = Schemas["VaccineLog"];
export type VaccineDocument = Schemas["VaccineDocument"];
export type VaccineDismissal = Schemas["VaccineDismissal"];

// The timeline's rows. The spec models TimelineEntry as an open object —
// oapi-codegen has no clean Go shape for eleven structurally different
// variants (see the schema's description) — but every row IS one of the log
// schemas plus its kind, so the SPA gets the discriminated union back, built
// from those schemas rather than written out by hand.
type Entry<K extends string, T> = T & { kind: K };
export type TimelineEntry =
  | Entry<"feed", FeedLog>
  | Entry<"diaper", DiaperLog>
  | Entry<"sleep", SleepLog>
  | Entry<"medicine", MedicineLog>
  | Entry<"bath", BathLog>
  | Entry<"note", NoteLog>
  | Entry<"milestone", MilestoneLog>
  | Entry<"measurement", MeasurementLog>
  | Entry<"pump", PumpLog>
  | Entry<"play", PlayLog>
  | Entry<"vaccine", VaccineLog>;
export type Timeline = Omit<Schemas["Timeline"], "entries"> & {
  entries: TimelineEntry[];
};

// Enums the spec declares on a field rather than as schemas of their own.
export type MeasurementType = MeasurementLog["type"];
export type PlayType = PlayLog["type"];
export type ContactIcon = NonNullable<Contact["icon"]>;
export type CalendarCategory = CalendarEvent["category"];
export type CalendarRecurrence = CalendarEvent["recurrence"];
export type MedicineUnit = NonNullable<MedicineCatalogueEntry["unit"]>;
export type TimelineFilter = NonNullable<
  NonNullable<operations["listTimeline"]["parameters"]["query"]>["filter"]
>;

/**
 * A runtime list of every member of a union the spec defines, for chips
 * and pickers. It fails to typecheck when the list names a value the spec
 * does not have, or misses one it does — so a new enum value in the spec
 * cannot be forgotten here.
 */
function everyOf<U extends string>() {
  return <const T extends readonly U[]>(
    list: T & ([U] extends [T[number]] ? unknown : never),
  ): T => list;
}

export const measurementTypes = everyOf<MeasurementType>()([
  "weight",
  "length",
  "head",
  "temperature",
]);

export const contactIcons = everyOf<ContactIcon>()([
  "user",
  "doctor",
  "nurse",
  "hospital",
  "dental",
  "family",
  "grandparent",
  "daycare",
  "friend",
  "phone",
]);

// Every timeline kind the spec lists, each of which the union above must
// have a variant for: a kind added to the spec fails here until it does.
export const timelineKinds = everyOf<Schemas["TimelineEntry"]["kind"]>()([
  "feed",
  "diaper",
  "sleep",
  "medicine",
  "bath",
  "note",
  "milestone",
  "measurement",
  "pump",
  "play",
  "vaccine",
]) satisfies readonly TimelineEntry["kind"][];
