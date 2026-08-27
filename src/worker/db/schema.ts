import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
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
    // Needed for WHO growth percentiles; nullable so existing babies keep
    // working until it's set.
    sex: text("sex", { enum: ["girl", "boy"] }),
    createdAt: createdAt(),
  },
  (t) => [index("baby_family_idx").on(t.familyId)],
);

// API keys (Phase 7): per-family bearer keys for Home Assistant/Grafana.
// The key itself is shown once; only its SHA-256 lands here. Keys act as the
// creating caretaker (attribution) and can read + write logs, but never
// touch admin/device endpoints.
export const apiKey = sqliteTable(
  "api_key",
  {
    id: id(),
    familyId: familyId(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    // First characters of the key, for recognizing it in the list UI.
    prefix: text("prefix").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    // NULL = never expires.
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    readOnly: integer("read_only", { mode: "boolean" })
      .default(false)
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("api_key_family_idx").on(t.familyId)],
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
    // One active session per baby, enforced at the DB so a double-tap or an
    // offline-queue replay can't race past the route's check.
    uniqueIndex("sleep_one_active_per_baby")
      .on(t.babyId)
      .where(sql`end_time IS NULL`),
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
    leftMin: integer("left_min"),
    rightMin: integer("right_min"),
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

// Audit trail for system-admin actions (Phase 8): impersonations, family
// deletes, password sets, bans. Append-only.
export const adminAudit = sqliteTable(
  "admin_audit",
  {
    id: id(),
    adminId: text("admin_id")
      .notNull()
      .references(() => user.id),
    action: text("action").notNull(),
    // Free-form target identifier (user id, family id, …) + context.
    target: text("target").notNull(),
    detail: text("detail"),
    createdAt: createdAt(),
  },
  (t) => [index("admin_audit_time_idx").on(t.createdAt)],
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

// Custom sleep locations (e.g. "Crib", "Grandma's"), per family — offered as
// chips alongside the free-text sleep_log.location field.
export const sleepLocation = sqliteTable(
  "sleep_location",
  {
    id: id(),
    familyId: familyId(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sleep_location_family_idx").on(t.familyId)],
);

// --- Play (premium): timed activities — tummy time, a walk, playing.
// Structurally a sleep_log: end_time NULL means the session is running, and
// the partial unique index is what makes the timer server-side. No durable
// object needed; "active" is a row shape, and the client renders the counter
// from start_time.

export const playLog = sqliteTable(
  "play_log",
  {
    id: id(),
    familyId: familyId(),
    babyId: babyId(),
    caretakerId: caretakerId(),
    type: text("type", { enum: ["tummy", "walk", "play"] }).notNull(),
    startTime: integer("start_time", { mode: "timestamp_ms" }).notNull(),
    // NULL while the activity is running.
    endTime: integer("end_time", { mode: "timestamp_ms" }),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    index("play_family_start_idx").on(t.familyId, t.startTime),
    index("play_baby_idx").on(t.babyId),
    // One running activity per baby, enforced at the DB so a double-tap or
    // an offline-queue replay can't race past the route's check — same
    // guarantee sleep_one_active_per_baby gives.
    uniqueIndex("play_one_active_per_baby")
      .on(t.babyId)
      .where(sql`end_time IS NULL`),
  ],
);

// --- Contacts (premium): the family's people — doctor, helsestasjon,
// grandparents. The first domain entity that is NOT a log: no time column,
// no caretaker attribution. Babies attach via contact_baby; zero rows means
// the contact belongs to the whole family (the doctor everyone shares),
// which is the same convention calendar_event_baby uses.

export const contact = sqliteTable(
  "contact",
  {
    id: id(),
    familyId: familyId(),
    name: text("name").notNull(),
    // Free-form by design: "doctor", "mormor", "barnehage" — a fixed enum
    // would never survive contact with a real family.
    role: text("role"),
    // Keep in step with contactIcons in shared/schemas.ts.
    icon: text("icon", {
      enum: [
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
      ],
    }),
    phone: text("phone"),
    email: text("email"),
    website: text("website"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("contact_family_idx").on(t.familyId)],
);

export const contactBaby = sqliteTable(
  "contact_baby",
  {
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    babyId: text("baby_id")
      .notNull()
      .references(() => baby.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.babyId] })],
);

// --- Calendar (premium): family-wide planned events. Babies and responsible
// members attach via join tables; zero baby rows = family-wide event.

export const calendarEvent = sqliteTable(
  "calendar_event",
  {
    id: id(),
    familyId: familyId(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    category: text("category", {
      enum: ["doctor", "vaccination", "babysitting", "family", "other"],
    })
      .default("other")
      .notNull(),
    startTime: integer("start_time", { mode: "timestamp_ms" }).notNull(),
    // All-day events are single-day; durationMin is NULL when set.
    allDay: integer("all_day", { mode: "boolean" }).default(false).notNull(),
    durationMin: integer("duration_min"),
    // NULL = no reminder. remindedAt is the sweep's idempotency latch.
    remindMinutesBefore: integer("remind_minutes_before"),
    remindedAt: integer("reminded_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("calendar_family_start_idx").on(t.familyId, t.startTime)],
);

export const calendarEventBaby = sqliteTable(
  "calendar_event_baby",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => calendarEvent.id, { onDelete: "cascade" }),
    babyId: text("baby_id")
      .notNull()
      .references(() => baby.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.babyId] })],
);

export const calendarAssignee = sqliteTable(
  "calendar_assignee",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => calendarEvent.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.userId] })],
);
