import { z } from "zod";

// Client-side shapes for the SPA. These used to be the single source of
// truth: the TypeScript backend validated requests with them and
// @hono/zod-openapi turned the same objects into the OpenAPI document, so
// every `.openapi("Name")` tag named a schema in that generated spec.
//
// The Go server owns both jobs now — openapi/pjokk.yaml is the hand-written
// spec, oapi-codegen generates the server from it, and openapi-typescript
// generates apps/frontend/src/lib/api-schema.d.ts for wire types. The
// `.openapi()` tags are therefore gone and the import is plain zod: what is
// left is a convenience layer of named, inferrable domain types the SPA's
// components read (Baby, FeedLog, TimelineEntry, …) plus the enum tuples it
// renders chips from. Nothing here validates a request any more.

export const feedTypes = ["bottle", "breast", "solids"] as const;
export const feedSides = ["left", "right", "both"] as const;
export const diaperTypes = ["wet", "dirty", "both"] as const;
export const inviteRoles = ["admin", "member"] as const;

const isoTime = () => z.iso.datetime({ offset: true });

// --- Babies ---

export const babySexes = ["girl", "boy"] as const;

export const BabySchema = z.object({
  id: z.string(),
  name: z.string(),
  birthDate: isoTime(),
  sex: z.enum(babySexes).nullable(),
});

export const CreateBabySchema = z.object({
  name: z.string().min(1).max(100),
  birthDate: isoTime(),
  sex: z.enum(babySexes).optional(),
});

export const UpdateBabySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  birthDate: isoTime().optional(),
  sex: z.enum(babySexes).nullable().optional(),
});

// --- Logs ---

const logBase = {
  id: z.string(),
  babyId: z.string(),
  caretakerId: z.string(),
  caretakerName: z.string(),
  notes: z.string().nullable(),
};

export const FeedLogSchema = z.object({
  ...logBase,
  time: isoTime(),
  type: z.enum(feedTypes),
  amountMl: z.number().int().nullable(),
  side: z.enum(feedSides).nullable(),
  durationMin: z.number().int().nullable(),
  leftMin: z.number().int().nullable(),
  rightMin: z.number().int().nullable(),
});

export const CreateFeedSchema = z.object({
  babyId: z.string(),
  time: isoTime(),
  type: z.enum(feedTypes),
  amountMl: z.number().int().min(0).max(1000).optional(),
  side: z.enum(feedSides).optional(),
  durationMin: z.number().int().min(0).max(600).optional(),
  leftMin: z.number().int().min(0).max(600).nullable().optional(),
  rightMin: z.number().int().min(0).max(600).nullable().optional(),
  notes: z.string().max(1000).optional(),
});

// Update schemas allow null to CLEAR a field (e.g. switching a feed from
// bottle to breast nulls amountMl); omitted fields stay untouched.
export const UpdateFeedSchema = z.object({
  time: isoTime().optional(),
  type: z.enum(feedTypes).optional(),
  amountMl: z.number().int().min(0).max(1000).nullable().optional(),
  side: z.enum(feedSides).nullable().optional(),
  durationMin: z.number().int().min(0).max(600).nullable().optional(),
  leftMin: z.number().int().min(0).max(600).nullable().optional(),
  rightMin: z.number().int().min(0).max(600).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

export const DiaperLogSchema = z.object({
  ...logBase,
  time: isoTime(),
  type: z.enum(diaperTypes),
});

export const CreateDiaperSchema = z.object({
  babyId: z.string(),
  time: isoTime(),
  type: z.enum(diaperTypes),
  notes: z.string().max(1000).optional(),
});

export const UpdateDiaperSchema = z.object({
  time: isoTime().optional(),
  type: z.enum(diaperTypes).optional(),
  notes: z.string().max(1000).nullable().optional(),
});

export const SleepLogSchema = z.object({
  ...logBase,
  startTime: isoTime(),
  endTime: isoTime().nullable(),
  location: z.string().nullable(),
});

export const CreateSleepSchema = z.object({
  babyId: z.string(),
  startTime: isoTime(),
  // Omitted endTime = start an active sleep session.
  endTime: isoTime().optional(),
  location: z.string().max(100).optional(),
  notes: z.string().max(1000).optional(),
});

export const UpdateSleepSchema = z.object({
  startTime: isoTime().optional(),
  endTime: isoTime().nullable().optional(),
  location: z.string().max(100).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

export const WakeSchema = z.object({
  // Defaults to now on the server when omitted.
  endTime: isoTime().optional(),
});

// Custom, per-family sleep-location chips (e.g. "Crib", "Grandma's").
export const SleepLocationSchema = z.object({
  id: z.string(),
  name: z.string(),
});

// --- Phase 3 activity types: same structural pattern as the core three ---

export const medicineUnits = ["ml", "mg", "drops", "dose"] as const;
export const measurementTypes = ["weight", "length", "head"] as const;

const createBase = {
  babyId: z.string(),
  time: isoTime(),
  notes: z.string().max(1000).optional(),
};

const patchBase = {
  time: isoTime().optional(),
  notes: z.string().max(1000).nullable().optional(),
};

export const MedicineLogSchema = z.object({
  ...logBase,
  time: isoTime(),
  name: z.string(),
  amount: z.number().nullable(),
  unit: z.enum(medicineUnits).nullable(),
});

export const CreateMedicineSchema = z.object({
  ...createBase,
  name: z.string().min(1).max(100),
  amount: z.number().min(0).max(1000).optional(),
  unit: z.enum(medicineUnits).optional(),
});

export const UpdateMedicineSchema = z.object({
  ...patchBase,
  name: z.string().min(1).max(100).optional(),
  amount: z.number().min(0).max(1000).nullable().optional(),
  unit: z.enum(medicineUnits).nullable().optional(),
});

export const BathLogSchema = z.object({ ...logBase, time: isoTime() });

export const CreateBathSchema = z.object(createBase);

export const UpdateBathSchema = z.object(patchBase);

export const NoteLogSchema = z.object({
  ...logBase,
  time: isoTime(),
  content: z.string(),
});

export const CreateNoteSchema = z.object({
  ...createBase,
  content: z.string().min(1).max(2000),
});

export const UpdateNoteSchema = z.object({
  ...patchBase,
  content: z.string().min(1).max(2000).optional(),
});

export const MilestoneLogSchema = z.object({
  ...logBase,
  time: isoTime(),
  title: z.string(),
});

export const CreateMilestoneSchema = z.object({
  ...createBase,
  title: z.string().min(1).max(200),
});

export const UpdateMilestoneSchema = z.object({
  ...patchBase,
  title: z.string().min(1).max(200).optional(),
});

// Units implied by type: weight in kg, length/head in cm.
export const MeasurementLogSchema = z.object({
  ...logBase,
  time: isoTime(),
  type: z.enum(measurementTypes),
  value: z.number(),
});

export const CreateMeasurementSchema = z.object({
  ...createBase,
  type: z.enum(measurementTypes),
  value: z.number().min(0).max(200),
});

export const UpdateMeasurementSchema = z.object({
  ...patchBase,
  type: z.enum(measurementTypes).optional(),
  value: z.number().min(0).max(200).optional(),
});

export const PumpLogSchema = z.object({
  ...logBase,
  time: isoTime(),
  side: z.enum(feedSides).nullable(),
  amountMl: z.number().int().nullable(),
  durationMin: z.number().int().nullable(),
});

export const CreatePumpSchema = z.object({
  ...createBase,
  side: z.enum(feedSides).optional(),
  amountMl: z.number().int().min(0).max(1000).optional(),
  durationMin: z.number().int().min(0).max(600).optional(),
});

export const UpdatePumpSchema = z.object({
  ...patchBase,
  side: z.enum(feedSides).nullable().optional(),
  amountMl: z.number().int().min(0).max(1000).nullable().optional(),
  durationMin: z.number().int().min(0).max(600).nullable().optional(),
});

// --- Vaccines (free log; documents are premium to upload) ---

export const VaccineDocumentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  // Fetch through /api/files/{id} — the R2 bucket is never public.
  url: z.string(),
});

export const VaccineLogSchema = z.object({
  ...logBase,
  time: isoTime(),
  name: z.string(),
  doseNumber: z.number().int().nullable(),
  // Slot key from the bundled programme, or null for an off-programme dose.
  scheduleSlot: z.string().nullable(),
  documents: z.array(VaccineDocumentSchema),
});

// A programme slot waved away for one baby. slotKey is a key into the
// bundled programme, deliberately not validated against it: the programme
// is data that can change without an API change.
export const VaccineDismissalSchema = z.object({
  id: z.string(),
  babyId: z.string(),
  slotKey: z.string(),
});

export const CreateVaccineDismissalSchema = z.object({
  babyId: z.string(),
  slotKey: z.string().min(1).max(60),
});

export const CreateVaccineSchema = z.object({
  babyId: z.string(),
  time: isoTime(),
  name: z.string().min(1).max(120),
  doseNumber: z.number().int().min(1).max(20).optional(),
  scheduleSlot: z.string().max(60).optional(),
  notes: z.string().max(1000).optional(),
});

export const UpdateVaccineSchema = z.object({
  time: isoTime().optional(),
  name: z.string().min(1).max(120).optional(),
  doseNumber: z.number().int().min(1).max(20).nullable().optional(),
  scheduleSlot: z.string().max(60).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

// --- Play (premium): timed activities, same session shape as sleep ---

export const playTypes = ["tummy", "walk", "play"] as const;

export const PlayLogSchema = z.object({
  ...logBase,
  type: z.enum(playTypes),
  startTime: isoTime(),
  // null = still running.
  endTime: isoTime().nullable(),
});

export const CreatePlaySchema = z.object({
  babyId: z.string(),
  type: z.enum(playTypes),
  startTime: isoTime(),
  // Omit to start a running session; supply both to log after the fact.
  endTime: isoTime().nullable().optional(),
  notes: z.string().max(2000).optional(),
});

export const UpdatePlaySchema = z.object({
  type: z.enum(playTypes).optional(),
  startTime: isoTime().optional(),
  endTime: isoTime().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const StopPlaySchema = z.object({ endTime: isoTime().optional() });

// --- Timeline: the merged, day-groupable feed of everything ---

// "other" = all Phase 3 activity types together.
export const timelineFilters = ["feeds", "diapers", "sleep", "other"] as const;

export const TimelineEntrySchema = z.discriminatedUnion("kind", [
  FeedLogSchema.extend({ kind: z.literal("feed") }),
  DiaperLogSchema.extend({ kind: z.literal("diaper") }),
  SleepLogSchema.extend({ kind: z.literal("sleep") }),
  MedicineLogSchema.extend({ kind: z.literal("medicine") }),
  BathLogSchema.extend({ kind: z.literal("bath") }),
  NoteLogSchema.extend({ kind: z.literal("note") }),
  MilestoneLogSchema.extend({ kind: z.literal("milestone") }),
  MeasurementLogSchema.extend({ kind: z.literal("measurement") }),
  PumpLogSchema.extend({ kind: z.literal("pump") }),
  PlayLogSchema.extend({ kind: z.literal("play") }),
  VaccineLogSchema.extend({ kind: z.literal("vaccine") }),
]);

export const TimelineSchema = z.object({
  entries: z.array(TimelineEntrySchema),
  // Opaque keyset cursor ("<ms>|<id>"); pass back as ?before= for the next
  // (older) page.
  nextCursor: z.string().nullable(),
});

// --- Home screen summary: one query answers "when did she last …" ---

export const SummarySchema = z.object({
  lastFeed: FeedLogSchema.nullable(),
  lastDiaper: DiaperLogSchema.nullable(),
  activeSleep: SleepLogSchema.nullable(),
  lastSleep: SleepLogSchema.nullable(),
  // The running timed activity (tummy time, a walk), or null.
  activePlay: PlayLogSchema.nullable(),
  // Local-day totals for the requester's timezone (see the `tz` query param).
  today: z.object({
    feeds: z.number().int(),
    intakeMl: z.number().int(),
    solidsG: z.number().int(),
    wet: z.number().int(),
    dirty: z.number().int(),
    both: z.number().int(),
    sleepMin: z.number().int(),
  }),
});

// --- Stats (Phase 4): deliberately minimal ---

export const StatsDaySchema = z.object({
  date: z.string(), // YYYY-MM-DD in the requester's local time
  sleepMin: z.number(),
  intakeMl: z.number(),
  feeds: z.number().int(),
  diapers: z.number().int(),
});

export const StatsSchema = z.object({
  days: z.array(StatsDaySchema),
  avgSleepMin: z.number(),
  avgIntakeMl: z.number(),
  avgFeeds: z.number(),
  avgDiapers: z.number(),
  weight: z
    .object({
      value: z.number(),
      time: isoTime(),
      prevValue: z.number().nullable(),
      prevTime: isoTime().nullable(),
    })
    .nullable(),
});

// --- System admin (Phase 8) ---

export const AdminStatsSchema = z.object({
  families: z.number().int(),
  users: z.number().int(),
  babies: z.number().int(),
  coreLogs: z.number().int(),
  pushSubscriptions: z.number().int(),
  usersLast7d: z.number().int(),
});

export const AdminFamilySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  plan: z.string(),
  createdAt: isoTime(),
  members: z.number().int(),
  babies: z.number().int(),
  lastFeedAt: isoTime().nullable(),
});

export const AdminSetPlanSchema = z.object({ plan: z.enum(["free", "comp"]) });

export const AuditEntrySchema = z.object({
  id: z.string(),
  adminId: z.string(),
  adminName: z.string(),
  action: z.string(),
  target: z.string(),
  detail: z.string().nullable(),
  createdAt: isoTime(),
});

export const AuditNoteSchema = z.object({
  action: z.string().min(1).max(60),
  target: z.string().min(1).max(200),
  detail: z.string().max(500).optional(),
});

// --- API keys (Phase 7) ---

export const ApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: isoTime(),
  lastUsedAt: isoTime().nullable(),
  revokedAt: isoTime().nullable(),
  expiresAt: isoTime().nullable(),
  readOnly: z.boolean(),
});

export const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(60),
  // Omitted = never expires.
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  readOnly: z.boolean().default(false),
});

// The full key appears here ONCE and is never retrievable again.
export const ApiKeyCreatedSchema = ApiKeySchema.extend({
  key: z.string(),
});

// --- Web push (Phase 5) ---

export const feedReminderChoices = [0, 3, 4, 6] as const;

export const PushConfigSchema = z.object({ publicKey: z.string() });

export const SubscribeSchema = z.object({
  endpoint: z.string().url().max(1000),
  p256dh: z.string().min(1).max(300),
  auth: z.string().min(1).max(100),
});

export const UnsubscribeSchema = z.object({ endpoint: z.string().max(1000) });

export const PushPrefsSchema = z.object({
  feedReminderHours: z
    .union([z.literal(0), z.literal(3), z.literal(4), z.literal(6)])
    .default(0),
});

export const PushTestResultSchema = z.object({ sent: z.number().int() });

// --- Family / members ---

export const MemberSchema = z.object({
  // The member-row id better-auth's remove/update-role APIs address.
  memberId: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string(),
  image: z.string().nullable(),
});

export const FamilySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  plan: z.string(),
});

export const CheckoutUrlSchema = z.object({ url: z.string() });

// --- Invites ---

export const InviteSchema = z.object({
  code: z.string(),
  familyId: z.string(),
  role: z.enum(inviteRoles),
  expiresAt: isoTime(),
  maxUses: z.number().int(),
  usedCount: z.number().int(),
  revokedAt: isoTime().nullable(),
  url: z.string(),
});

export const CreateInviteSchema = z.object({
  role: z.enum(inviteRoles).default("member"),
  // 72h default expiry, single-digit default uses; both capped server-side.
  expiresInHours: z.number().int().min(1).max(720).default(72),
  maxUses: z.number().int().min(1).max(50).default(5),
});

export const InviteInfoSchema = z.object({
  valid: z.boolean(),
  familyName: z.string().nullable(),
  role: z.enum(inviteRoles).nullable(),
  reason: z.enum(["revoked", "expired", "exhausted", "not_found"]).nullable(),
});

export const RedeemSchema = z.object({
  code: z.string().min(1).max(64),
});

export const RedeemResultSchema = z.object({
  familyId: z.string(),
  familyName: z.string(),
  role: z.enum(inviteRoles),
  alreadyMember: z.boolean(),
});

// --- Contacts (premium): the family's people ---

// A small fixed set, mapped to Tabler glyphs in the UI. Free-form `role`
// carries the meaning; the icon is just recognition at a glance.
export const contactIcons = [
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
] as const;

// Website is deliberately free text, not z.url(): people type
// "legesenteret.no" and being right about URLs matters less than the
// contact getting saved. The UI prepends https:// when opening it.
export const ContactSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  icon: z.enum(contactIcons).nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  website: z.string().nullable(),
  notes: z.string().nullable(),
  // Zero babies = a contact the whole family shares.
  babies: z.array(z.object({ id: z.string(), name: z.string() })),
});

export const CreateContactSchema = z.object({
  name: z.string().min(1).max(100),
  role: z.string().max(60).optional(),
  icon: z.enum(contactIcons).optional(),
  phone: z.string().max(40).optional(),
  email: z.email().max(200).optional(),
  website: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  babyIds: z.array(z.string()).max(10).default([]),
});

export const UpdateContactSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  role: z.string().max(60).nullable().optional(),
  icon: z.enum(contactIcons).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.email().max(200).nullable().optional(),
  website: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  // Present = replace the link set; omitted = untouched.
  babyIds: z.array(z.string()).max(10).optional(),
});

// --- Calendar (premium): family-wide planned events ---

export const calendarCategories = [
  "doctor",
  "vaccination",
  "babysitting",
  "family",
  "other",
] as const;

export const CalendarEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  category: z.enum(calendarCategories),
  startTime: isoTime(),
  allDay: z.boolean(),
  durationMin: z.number().int().nullable(),
  remindMinutesBefore: z.number().int().nullable(),
  createdBy: z.string(),
  createdByName: z.string(),
  // Zero babies = family-wide event.
  babies: z.array(z.object({ id: z.string(), name: z.string() })),
  assignees: z.array(z.object({ userId: z.string(), name: z.string() })),
});

export const CreateCalendarEventSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  location: z.string().max(200).optional(),
  category: z.enum(calendarCategories).default("other"),
  startTime: isoTime(),
  // All-day events are single-day; the server nulls durationMin when set.
  allDay: z.boolean().default(false),
  durationMin: z.number().int().min(5).max(1440).optional(),
  remindMinutesBefore: z.number().int().min(15).max(10080).optional(),
  babyIds: z.array(z.string()).max(10).default([]),
  assigneeUserIds: z.array(z.string()).max(20).default([]),
});

export const UpdateCalendarEventSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  category: z.enum(calendarCategories).optional(),
  startTime: isoTime().optional(),
  allDay: z.boolean().optional(),
  durationMin: z.number().int().min(5).max(1440).nullable().optional(),
  remindMinutesBefore: z
    .number()
    .int()
    .min(15)
    .max(10080)
    .nullable()
    .optional(),
  // Present = replace the link set; omitted = untouched.
  babyIds: z.array(z.string()).max(10).optional(),
  assigneeUserIds: z.array(z.string()).max(20).optional(),
});

// --- Errors ---

export const ErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});

export type Baby = z.infer<typeof BabySchema>;
export type FeedLog = z.infer<typeof FeedLogSchema>;
export type DiaperLog = z.infer<typeof DiaperLogSchema>;
export type SleepLog = z.infer<typeof SleepLogSchema>;
export type SleepLocation = z.infer<typeof SleepLocationSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type Member = z.infer<typeof MemberSchema>;
export type Invite = z.infer<typeof InviteSchema>;
export type Family = z.infer<typeof FamilySchema>;
export type FeedType = (typeof feedTypes)[number];
export type DiaperType = (typeof diaperTypes)[number];
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;
export type Timeline = z.infer<typeof TimelineSchema>;
export type TimelineFilter = (typeof timelineFilters)[number];
export type MedicineLog = z.infer<typeof MedicineLogSchema>;
export type BathLog = z.infer<typeof BathLogSchema>;
export type NoteLog = z.infer<typeof NoteLogSchema>;
export type MilestoneLog = z.infer<typeof MilestoneLogSchema>;
export type MeasurementLog = z.infer<typeof MeasurementLogSchema>;
export type PumpLog = z.infer<typeof PumpLogSchema>;
export type MedicineUnit = (typeof medicineUnits)[number];
export type MeasurementType = (typeof measurementTypes)[number];
export type Stats = z.infer<typeof StatsSchema>;
export type StatsDay = z.infer<typeof StatsDaySchema>;
export type BabySex = (typeof babySexes)[number];
export type ApiKey = z.infer<typeof ApiKeySchema>;
export type ApiKeyCreated = z.infer<typeof ApiKeyCreatedSchema>;
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;
export type CreateCalendarEvent = z.infer<typeof CreateCalendarEventSchema>;
export type UpdateCalendarEvent = z.infer<typeof UpdateCalendarEventSchema>;
export type CalendarCategory = (typeof calendarCategories)[number];
export type Contact = z.infer<typeof ContactSchema>;
export type CreateContact = z.infer<typeof CreateContactSchema>;
export type UpdateContact = z.infer<typeof UpdateContactSchema>;
export type ContactIcon = (typeof contactIcons)[number];
export type PlayLog = z.infer<typeof PlayLogSchema>;
export type PlayType = (typeof playTypes)[number];
export type VaccineLog = z.infer<typeof VaccineLogSchema>;
export type VaccineDocument = z.infer<typeof VaccineDocumentSchema>;
export type VaccineDismissal = z.infer<typeof VaccineDismissalSchema>;
