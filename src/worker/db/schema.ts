import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
