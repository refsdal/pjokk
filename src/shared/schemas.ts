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

export const UpdateFeedSchema = CreateFeedSchema.omit({ babyId: true })
  .partial()
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

export const UpdateDiaperSchema = CreateDiaperSchema.omit({ babyId: true })
  .partial()
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

// --- Home screen summary: one query answers "when did she last …" ---

export const SummarySchema = z
  .object({
    lastFeed: FeedLogSchema.nullable(),
    lastDiaper: DiaperLogSchema.nullable(),
    activeSleep: SleepLogSchema.nullable(),
    lastSleep: SleepLogSchema.nullable(),
  })
  .openapi("Summary");

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
