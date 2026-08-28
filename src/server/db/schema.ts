import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  doublePrecision,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
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

// Every instant is a timestamptz. Drizzle maps it to a JS Date — exactly what
// the old epoch-ms integers mapped to — so application code is unchanged by
// the dialect switch, while the database gets a column it can reason about.
const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

const createdAt = () => ts("created_at").defaultNow().notNull();

export const baby = pgTable(
  "baby",
  {
    id: id(),
    familyId: familyId(),
    name: text("name").notNull(),
    birthDate: ts("birth_date").notNull(),
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
export const apiKey = pgTable(
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
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    // NULL = never expires.
    expiresAt: ts("expires_at"),
    readOnly: boolean("read_only").default(false).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("api_key_family_idx").on(t.familyId)],
);

export const sleepLog = pgTable(
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
    startTime: ts("start_time").notNull(),
    // NULL while the sleep session is active.
    endTime: ts("end_time"),
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

export const feedLog = pgTable(
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
    time: ts("time").notNull(),
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

export const diaperLog = pgTable(
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
    time: ts("time").notNull(),
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

const time = () => ts("time").notNull();

export const medicineLog = pgTable(
  "medicine_log",
  {
    id: id(),
    familyId: familyId(),
    babyId: babyId(),
    caretakerId: caretakerId(),
    time: time(),
    name: text("name").notNull(),
    // doublePrecision, not real: SQLite's REAL is an 8-byte IEEE double, but
    // Postgres' `real` is 4-byte single precision, which silently rounds a
    // dose of 8.4 to 8.399999618530273.
    amount: doublePrecision("amount"),
    unit: text("unit", { enum: ["ml", "mg", "drops", "dose"] }),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("medicine_family_time_idx").on(t.familyId, t.time)],
);

export const bathLog = pgTable(
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

export const noteLog = pgTable(
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

export const milestoneLog = pgTable(
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
export const measurementLog = pgTable(
  "measurement_log",
  {
    id: id(),
    familyId: familyId(),
    babyId: babyId(),
    caretakerId: caretakerId(),
    time: time(),
    type: text("type", { enum: ["weight", "length", "head"] }).notNull(),
    // doublePrecision for the same reason as medicine_log.amount: `real`
    // would round a recorded weight.
    value: doublePrecision("value").notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("measurement_family_time_idx").on(t.familyId, t.time)],
);

export const pumpLog = pgTable(
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
export const pushSubscription = pgTable(
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
export const pushPref = pgTable(
  "push_pref",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    familyId: familyId(),
    feedReminderHours: integer("feed_reminder_hours").default(0).notNull(),
    lastRemindedAt: ts("last_reminded_at"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.familyId] })],
);

// Audit trail for system-admin actions (Phase 8): impersonations, family
// deletes, password sets, bans. Append-only.
export const adminAudit = pgTable(
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
export const familyInvite = pgTable(
  "family_invite",
  {
    code: text("code").primaryKey(),
    familyId: familyId(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    expiresAt: ts("expires_at").notNull(),
    maxUses: integer("max_uses").notNull(),
    usedCount: integer("used_count").default(0).notNull(),
    revokedAt: ts("revoked_at"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [index("invite_family_idx").on(t.familyId)],
);

// Custom sleep locations (e.g. "Crib", "Grandma's"), per family — offered as
// chips alongside the free-text sleep_log.location field.
export const sleepLocation = pgTable(
  "sleep_location",
  {
    id: id(),
    familyId: familyId(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sleep_location_family_idx").on(t.familyId)],
);

// --- Vaccines (free): what was given, and when. The bundled Norwegian
// programme (web/data/no-vaccine-programme.json) is a reference overlay
// only — it never constrains what can be logged, so a vaccine given abroad
// or off-programme records exactly the same way.

export const vaccineLog = pgTable(
  "vaccine_log",
  {
    id: id(),
    familyId: familyId(),
    babyId: babyId(),
    caretakerId: caretakerId(),
    time: time(),
    name: text("name").notNull(),
    doseNumber: integer("dose_number"),
    // Slot key from the bundled programme ("mmr:1"); NULL when the dose
    // isn't part of it. Nullable and unvalidated on purpose: the programme
    // is data that can change without a migration.
    scheduleSlot: text("schedule_slot"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    index("vaccine_family_time_idx").on(t.familyId, t.time),
    index("vaccine_baby_idx").on(t.babyId),
  ],
);

// Attachments live in R2; this table is the authorization record. Uploading
// is premium, but reading and deleting never are.
export const vaccineDocument = pgTable(
  "vaccine_document",
  {
    id: id(),
    familyId: familyId(),
    vaccineLogId: text("vaccine_log_id")
      .notNull()
      .references(() => vaccineLog.id, { onDelete: "cascade" }),
    // R2 object key. Never derived from user input.
    objectKey: text("object_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    uploadedBy: text("uploaded_by")
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("vaccine_doc_log_idx").on(t.vaccineLogId),
    index("vaccine_doc_family_idx").on(t.familyId),
  ],
);

// Programme slots a family has waved away for one baby ("not for us", "we
// had that abroad", "not offered here"). Stores the slot KEY, not a foreign
// key: the bundled programme is data that can change without a migration,
// and a dismissal of a key that no longer exists simply stops matching.
export const vaccineDismissal = pgTable(
  "vaccine_dismissal",
  {
    id: id(),
    familyId: familyId(),
    babyId: babyId(),
    slotKey: text("slot_key").notNull(),
    dismissedBy: text("dismissed_by")
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("vaccine_dismissal_family_idx").on(t.familyId),
    // One dismissal per slot per baby, so a double-tap or an offline replay
    // can't duplicate a row.
    uniqueIndex("vaccine_dismissal_baby_slot").on(t.babyId, t.slotKey),
  ],
);

// --- Play (premium): timed activities — tummy time, a walk, playing.
// Structurally a sleep_log: end_time NULL means the session is running, and
// the partial unique index is what makes the timer server-side. No durable
// object needed; "active" is a row shape, and the client renders the counter
// from start_time.

export const playLog = pgTable(
  "play_log",
  {
    id: id(),
    familyId: familyId(),
    babyId: babyId(),
    caretakerId: caretakerId(),
    type: text("type", { enum: ["tummy", "walk", "play"] }).notNull(),
    startTime: ts("start_time").notNull(),
    // NULL while the activity is running.
    endTime: ts("end_time"),
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

export const contact = pgTable(
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

export const contactBaby = pgTable(
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

export const calendarEvent = pgTable(
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
    startTime: ts("start_time").notNull(),
    // All-day events are single-day; durationMin is NULL when set.
    allDay: boolean("all_day").default(false).notNull(),
    durationMin: integer("duration_min"),
    // NULL = no reminder. remindedAt is the sweep's idempotency latch.
    remindMinutesBefore: integer("remind_minutes_before"),
    remindedAt: ts("reminded_at"),
    createdAt: createdAt(),
  },
  (t) => [index("calendar_family_start_idx").on(t.familyId, t.startTime)],
);

export const calendarEventBaby = pgTable(
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

export const calendarAssignee = pgTable(
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

// --- Rate-limit counters (replaces the KV namespace) ---
//
// KV was globally replicated with no jurisdiction option, which is why the
// limiter could only ever store a HASH of the client IP. That constraint is
// gone — this table lives in the same EU database as everything else — but
// the hashing stays: there is no reason to start recording addresses, and a
// hash buckets each client identically.
//
// Postgres also removes the old caveat. KV's read-then-write increment was
// racy ("a brake, not an invariant", said the comment); here one
// INSERT … ON CONFLICT DO UPDATE … RETURNING is atomic, so the limit is
// exact even under concurrent requests — which matters once several replicas
// share one database.
export const rateLimit = pgTable(
  "rate_limit",
  {
    // "rl:<name>:<bucket>:<window>" — the window number is part of the key,
    // so a new fixed window is simply a new row.
    key: text("key").primaryKey(),
    count: integer("count").default(0).notNull(),
    // KV expired rows for us. Nothing does here, so the sweep in the cron
    // prunes them and this index keeps that cheap.
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("rate_limit_expires_idx").on(t.expiresAt)],
);
