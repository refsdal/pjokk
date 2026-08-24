import { z } from "@hono/zod-openapi";

// Single source of truth for API shapes: runtime validation, OpenAPI spec,
// and inferred client types all derive from these schemas.

export const feedTypes = ["bottle", "breast", "solids"] as const;
export const feedSides = ["left", "right", "both"] as const;
export const diaperTypes = ["wet", "dirty", "both"] as const;
export const inviteRoles = ["admin", "member"] as const;

const isoTime = () => z.iso.datetime({ offset: true });

// --- Babies ---

export const BabySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    birthDate: isoTime(),
  })
  .openapi("Baby");

export const CreateBabySchema = z
  .object({
    name: z.string().min(1).max(100),
    birthDate: isoTime(),
  })
  .openapi("CreateBaby");

// --- Logs ---

const logBase = {
  id: z.string(),
  babyId: z.string(),
  caretakerId: z.string(),
  caretakerName: z.string(),
  notes: z.string().nullable(),
};

export const FeedLogSchema = z
  .object({
    ...logBase,
    time: isoTime(),
    type: z.enum(feedTypes),
    amountMl: z.number().int().nullable(),
    side: z.enum(feedSides).nullable(),
    durationMin: z.number().int().nullable(),
  })
  .openapi("FeedLog");

export const CreateFeedSchema = z
  .object({
    babyId: z.string(),
    time: isoTime(),
    type: z.enum(feedTypes),
    amountMl: z.number().int().min(0).max(1000).optional(),
    side: z.enum(feedSides).optional(),
    durationMin: z.number().int().min(0).max(600).optional(),
    notes: z.string().max(1000).optional(),
  })
  .openapi("CreateFeed");

// Update schemas allow null to CLEAR a field (e.g. switching a feed from
// bottle to breast nulls amountMl); omitted fields stay untouched.
export const UpdateFeedSchema = z
  .object({
    time: isoTime().optional(),
    type: z.enum(feedTypes).optional(),
    amountMl: z.number().int().min(0).max(1000).nullable().optional(),
    side: z.enum(feedSides).nullable().optional(),
    durationMin: z.number().int().min(0).max(600).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
  })
  .openapi("UpdateFeed");

export const DiaperLogSchema = z
  .object({
    ...logBase,
    time: isoTime(),
    type: z.enum(diaperTypes),
  })
  .openapi("DiaperLog");

export const CreateDiaperSchema = z
  .object({
    babyId: z.string(),
    time: isoTime(),
    type: z.enum(diaperTypes),
    notes: z.string().max(1000).optional(),
  })
  .openapi("CreateDiaper");

export const UpdateDiaperSchema = z
  .object({
    time: isoTime().optional(),
    type: z.enum(diaperTypes).optional(),
    notes: z.string().max(1000).nullable().optional(),
  })
  .openapi("UpdateDiaper");

export const SleepLogSchema = z
  .object({
    ...logBase,
    startTime: isoTime(),
    endTime: isoTime().nullable(),
    location: z.string().nullable(),
  })
  .openapi("SleepLog");

export const CreateSleepSchema = z
  .object({
    babyId: z.string(),
    startTime: isoTime(),
    // Omitted endTime = start an active sleep session.
    endTime: isoTime().optional(),
    location: z.string().max(100).optional(),
    notes: z.string().max(1000).optional(),
  })
  .openapi("CreateSleep");

export const UpdateSleepSchema = z
  .object({
    startTime: isoTime().optional(),
    endTime: isoTime().nullable().optional(),
    location: z.string().max(100).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
  })
  .openapi("UpdateSleep");

export const WakeSchema = z
  .object({
    // Defaults to now on the server when omitted.
    endTime: isoTime().optional(),
  })
  .openapi("Wake");

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

export const MedicineLogSchema = z
  .object({
    ...logBase,
    time: isoTime(),
    name: z.string(),
    amount: z.number().nullable(),
    unit: z.enum(medicineUnits).nullable(),
  })
  .openapi("MedicineLog");

export const CreateMedicineSchema = z
  .object({
    ...createBase,
    name: z.string().min(1).max(100),
    amount: z.number().min(0).max(1000).optional(),
    unit: z.enum(medicineUnits).optional(),
  })
  .openapi("CreateMedicine");

export const UpdateMedicineSchema = z
  .object({
    ...patchBase,
    name: z.string().min(1).max(100).optional(),
    amount: z.number().min(0).max(1000).nullable().optional(),
    unit: z.enum(medicineUnits).nullable().optional(),
  })
  .openapi("UpdateMedicine");

export const BathLogSchema = z
  .object({ ...logBase, time: isoTime() })
  .openapi("BathLog");

export const CreateBathSchema = z.object(createBase).openapi("CreateBath");

export const UpdateBathSchema = z.object(patchBase).openapi("UpdateBath");

export const NoteLogSchema = z
  .object({ ...logBase, time: isoTime(), content: z.string() })
  .openapi("NoteLog");

export const CreateNoteSchema = z
  .object({ ...createBase, content: z.string().min(1).max(2000) })
  .openapi("CreateNote");

export const UpdateNoteSchema = z
  .object({ ...patchBase, content: z.string().min(1).max(2000).optional() })
  .openapi("UpdateNote");

export const MilestoneLogSchema = z
  .object({ ...logBase, time: isoTime(), title: z.string() })
  .openapi("MilestoneLog");

export const CreateMilestoneSchema = z
  .object({ ...createBase, title: z.string().min(1).max(200) })
  .openapi("CreateMilestone");

export const UpdateMilestoneSchema = z
  .object({ ...patchBase, title: z.string().min(1).max(200).optional() })
  .openapi("UpdateMilestone");

// Units implied by type: weight in kg, length/head in cm.
export const MeasurementLogSchema = z
  .object({
    ...logBase,
    time: isoTime(),
    type: z.enum(measurementTypes),
    value: z.number(),
  })
  .openapi("MeasurementLog");

export const CreateMeasurementSchema = z
  .object({
    ...createBase,
    type: z.enum(measurementTypes),
    value: z.number().min(0).max(200),
  })
  .openapi("CreateMeasurement");

export const UpdateMeasurementSchema = z
  .object({
    ...patchBase,
    type: z.enum(measurementTypes).optional(),
    value: z.number().min(0).max(200).optional(),
  })
  .openapi("UpdateMeasurement");

export const PumpLogSchema = z
  .object({
    ...logBase,
    time: isoTime(),
    side: z.enum(feedSides).nullable(),
    amountMl: z.number().int().nullable(),
    durationMin: z.number().int().nullable(),
  })
  .openapi("PumpLog");

export const CreatePumpSchema = z
  .object({
    ...createBase,
    side: z.enum(feedSides).optional(),
    amountMl: z.number().int().min(0).max(1000).optional(),
    durationMin: z.number().int().min(0).max(600).optional(),
  })
  .openapi("CreatePump");

export const UpdatePumpSchema = z
  .object({
    ...patchBase,
    side: z.enum(feedSides).nullable().optional(),
    amountMl: z.number().int().min(0).max(1000).nullable().optional(),
    durationMin: z.number().int().min(0).max(600).nullable().optional(),
  })
  .openapi("UpdatePump");

// --- Timeline: the merged, day-groupable feed of everything ---

// "other" = all Phase 3 activity types together.
export const timelineFilters = ["feeds", "diapers", "sleep", "other"] as const;

export const TimelineEntrySchema = z
  .discriminatedUnion("kind", [
    FeedLogSchema.extend({ kind: z.literal("feed") }),
    DiaperLogSchema.extend({ kind: z.literal("diaper") }),
    SleepLogSchema.extend({ kind: z.literal("sleep") }),
    MedicineLogSchema.extend({ kind: z.literal("medicine") }),
    BathLogSchema.extend({ kind: z.literal("bath") }),
    NoteLogSchema.extend({ kind: z.literal("note") }),
    MilestoneLogSchema.extend({ kind: z.literal("milestone") }),
    MeasurementLogSchema.extend({ kind: z.literal("measurement") }),
    PumpLogSchema.extend({ kind: z.literal("pump") }),
  ])
  .openapi("TimelineEntry");

export const TimelineSchema = z
  .object({
    entries: z.array(TimelineEntrySchema),
    // Pass back as ?before= to fetch the next (older) page.
    nextCursor: isoTime().nullable(),
  })
  .openapi("Timeline");

// --- Home screen summary: one query answers "when did she last …" ---

export const SummarySchema = z
  .object({
    lastFeed: FeedLogSchema.nullable(),
    lastDiaper: DiaperLogSchema.nullable(),
    activeSleep: SleepLogSchema.nullable(),
    lastSleep: SleepLogSchema.nullable(),
  })
  .openapi("Summary");

// --- Stats (Phase 4): deliberately minimal ---

export const StatsDaySchema = z
  .object({
    date: z.string(), // YYYY-MM-DD in the requester's local time
    sleepMin: z.number(),
    intakeMl: z.number(),
    feeds: z.number().int(),
    diapers: z.number().int(),
  })
  .openapi("StatsDay");

export const StatsSchema = z
  .object({
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
  })
  .openapi("Stats");

// --- Web push (Phase 5) ---

export const feedReminderChoices = [0, 3, 4, 6] as const;

export const PushConfigSchema = z
  .object({ publicKey: z.string() })
  .openapi("PushConfig");

export const SubscribeSchema = z
  .object({
    endpoint: z.string().url().max(1000),
    p256dh: z.string().min(1).max(300),
    auth: z.string().min(1).max(100),
  })
  .openapi("Subscribe");

export const UnsubscribeSchema = z
  .object({ endpoint: z.string().max(1000) })
  .openapi("Unsubscribe");

export const PushPrefsSchema = z
  .object({
    feedReminderHours: z
      .union([z.literal(0), z.literal(3), z.literal(4), z.literal(6)])
      .default(0),
  })
  .openapi("PushPrefs");

export const PushTestResultSchema = z
  .object({ sent: z.number().int() })
  .openapi("PushTestResult");

// --- Family / members ---

export const MemberSchema = z
  .object({
    userId: z.string(),
    name: z.string(),
    email: z.string(),
    role: z.string(),
    image: z.string().nullable(),
  })
  .openapi("Member");

export const FamilySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    plan: z.string(),
  })
  .openapi("Family");

// --- Invites ---

export const InviteSchema = z
  .object({
    code: z.string(),
    familyId: z.string(),
    role: z.enum(inviteRoles),
    expiresAt: isoTime(),
    maxUses: z.number().int(),
    usedCount: z.number().int(),
    revokedAt: isoTime().nullable(),
    url: z.string(),
  })
  .openapi("Invite");

export const CreateInviteSchema = z
  .object({
    role: z.enum(inviteRoles).default("member"),
    // 72h default expiry, single-digit default uses; both capped server-side.
    expiresInHours: z.number().int().min(1).max(720).default(72),
    maxUses: z.number().int().min(1).max(50).default(5),
  })
  .openapi("CreateInvite");

export const InviteInfoSchema = z
  .object({
    valid: z.boolean(),
    familyName: z.string().nullable(),
    role: z.enum(inviteRoles).nullable(),
    reason: z.enum(["revoked", "expired", "exhausted", "not_found"]).nullable(),
  })
  .openapi("InviteInfo");

export const RedeemSchema = z
  .object({
    code: z.string().min(1).max(64),
  })
  .openapi("Redeem");

export const RedeemResultSchema = z
  .object({
    familyId: z.string(),
    familyName: z.string(),
    role: z.enum(inviteRoles),
    alreadyMember: z.boolean(),
  })
  .openapi("RedeemResult");

// --- Errors ---

export const ErrorSchema = z
  .object({
    error: z.string(),
    code: z.string().optional(),
  })
  .openapi("Error");

export type Baby = z.infer<typeof BabySchema>;
export type FeedLog = z.infer<typeof FeedLogSchema>;
export type DiaperLog = z.infer<typeof DiaperLogSchema>;
export type SleepLog = z.infer<typeof SleepLogSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type Member = z.infer<typeof MemberSchema>;
export type Invite = z.infer<typeof InviteSchema>;
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
