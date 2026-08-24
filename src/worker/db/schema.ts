import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { organization, user } from "./auth-schema";

export * from "./auth-schema";

// Every domain table carries familyId (the better-auth organization id).
// Access is only allowed through the family-scoped helpers in ./scoped.ts.

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const familyId = () =>
  text("family_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull();

export const baby = sqliteTable(
  "baby",
  {
    id: id(),
    familyId: familyId(),
    name: text("name").notNull(),
    birthDate: integer("birth_date", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("baby_family_idx").on(t.familyId)],
);

export const sleepLog = sqliteTable(
  "sleep_log",
  {
    id: id(),
    familyId: familyId(),
    babyId: text("baby_id")
      .notNull()
      .references(() => baby.id, { onDelete: "cascade" }),
    caretakerId: text("caretaker_id")
      .notNull()
      .references(() => user.id),
    startTime: integer("start_time", { mode: "timestamp_ms" }).notNull(),
    // NULL while the sleep session is active.
    endTime: integer("end_time", { mode: "timestamp_ms" }),
    location: text("location"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    index("sleep_family_start_idx").on(t.familyId, t.startTime),
    index("sleep_baby_idx").on(t.babyId),
  ],
);

export const feedLog = sqliteTable(
  "feed_log",
  {
    id: id(),
    familyId: familyId(),
    babyId: text("baby_id")
      .notNull()
      .references(() => baby.id, { onDelete: "cascade" }),
    caretakerId: text("caretaker_id")
      .notNull()
      .references(() => user.id),
    time: integer("time", { mode: "timestamp_ms" }).notNull(),
    type: text("type", { enum: ["bottle", "breast", "solids"] }).notNull(),
    amountMl: integer("amount_ml"),
    side: text("side", { enum: ["left", "right", "both"] }),
    durationMin: integer("duration_min"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    index("feed_family_time_idx").on(t.familyId, t.time),
    index("feed_baby_idx").on(t.babyId),
  ],
);

export const diaperLog = sqliteTable(
  "diaper_log",
  {
    id: id(),
    familyId: familyId(),
    babyId: text("baby_id")
      .notNull()
      .references(() => baby.id, { onDelete: "cascade" }),
    caretakerId: text("caretaker_id")
      .notNull()
      .references(() => user.id),
    time: integer("time", { mode: "timestamp_ms" }).notNull(),
    type: text("type", { enum: ["wet", "dirty", "both"] }).notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    index("diaper_family_time_idx").on(t.familyId, t.time),
    index("diaper_baby_idx").on(t.babyId),
  ],
);

// --- Phase 3 activity types: structural copies of the Phase 1 log shape.
// All share (id, familyId, babyId, caretakerId, time, …specifics, notes) and
// are served by the generic CRUD in scoped.ts / routes/other-logs.ts.

const babyId = () =>
  text("baby_id")
    .notNull()
    .references(() => baby.id, { onDelete: "cascade" });

const caretakerId = () =>
  text("caretaker_id")
    .notNull()
    .references(() => user.id);

const time = () => integer("time", { mode: "timestamp_ms" }).notNull();

export const medicineLog = sqliteTable(
  "medicine_log",
  {
    id: id(),
    familyId: familyId(),
    babyId: babyId(),
    caretakerId: caretakerId(),
    time: time(),
    name: text("name").notNull(),
    amount: real("amount"),
    unit: text("unit", { enum: ["ml", "mg", "drops", "dose"] }),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("medicine_family_time_idx").on(t.familyId, t.time)],
);

export const bathLog = sqliteTable(
  "bath_log",
  {
    id: id(),
    familyId: familyId(),
    babyId: babyId(),
    caretakerId: caretakerId(),
    time: time(),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("bath_family_time_idx").on(t.familyId, t.time)],
);

export const noteLog = sqliteTable(
  "note_log",
  {
    id: id(),
    familyId: familyId(),
    babyId: babyId(),
    caretakerId: caretakerId(),
    time: time(),
    content: text("content").notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("note_family_time_idx").on(t.familyId, t.time)],
);

export const milestoneLog = sqliteTable(
  "milestone_log",
  {
    id: id(),
    familyId: familyId(),
    babyId: babyId(),
    caretakerId: caretakerId(),
    time: time(),
    title: text("title").notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("milestone_family_time_idx").on(t.familyId, t.time)],
);

// Units are implied by type: weight in kg, length/head in cm.
export const measurementLog = sqliteTable(
  "measurement_log",
  {
    id: id(),
    familyId: familyId(),
    babyId: babyId(),
    caretakerId: caretakerId(),
    time: time(),
    type: text("type", { enum: ["weight", "length", "head"] }).notNull(),
    value: real("value").notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("measurement_family_time_idx").on(t.familyId, t.time)],
);

export const pumpLog = sqliteTable(
  "pump_log",
  {
    id: id(),
    familyId: familyId(),
    babyId: babyId(),
    caretakerId: caretakerId(),
    time: time(),
    side: text("side", { enum: ["left", "right", "both"] }),
    amountMl: integer("amount_ml"),
    durationMin: integer("duration_min"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("pump_family_time_idx").on(t.familyId, t.time)],
);

// --- Web push (Phase 5) ---

// One row per browser/device push subscription. Endpoint is the identity;
// rows are deleted when the push service answers 404/410.
export const pushSubscription = sqliteTable(
  "push_subscription",
  {
    id: id(),
    familyId: familyId(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("push_sub_user_idx").on(t.userId)],
);

// Per-caretaker notification preferences (per family). feedReminderHours=0
// means off; lastRemindedAt implements one-nudge-per-gap.
export const pushPref = sqliteTable(
  "push_pref",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    familyId: familyId(),
    feedReminderHours: integer("feed_reminder_hours").default(0).notNull(),
    lastRemindedAt: integer("last_reminded_at", { mode: "timestamp_ms" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.familyId] })],
);

// Custom invite codes (QR-at-Sunday-dinner grain, not email-addressed).
// Codes are credentials: the redeem endpoint is rate-limited.
export const familyInvite = sqliteTable(
  "family_invite",
  {
    code: text("code").primaryKey(),
    familyId: familyId(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    maxUses: integer("max_uses").notNull(),
    usedCount: integer("used_count").default(0).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [index("invite_family_idx").on(t.familyId)],
);
