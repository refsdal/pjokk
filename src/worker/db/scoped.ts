import { and, desc, eq, gt, gte, isNull, lt, or } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "./index";
import {
  apiKey,
  baby,
  bathLog,
  diaperLog,
  familyInvite,
  feedLog,
  measurementLog,
  medicineLog,
  member,
  milestoneLog,
  noteLog,
  organization,
  pumpLog,
  sleepLog,
  user,
} from "./schema";

// The ONLY sanctioned way to touch domain tables. Every query in here is
// scoped to one familyId; handlers never build their own domain queries.

const feedCols = {
  id: feedLog.id,
  babyId: feedLog.babyId,
  caretakerId: feedLog.caretakerId,
  caretakerName: user.name,
  time: feedLog.time,
  type: feedLog.type,
  amountMl: feedLog.amountMl,
  side: feedLog.side,
  durationMin: feedLog.durationMin,
  notes: feedLog.notes,
};

const diaperCols = {
  id: diaperLog.id,
  babyId: diaperLog.babyId,
  caretakerId: diaperLog.caretakerId,
  caretakerName: user.name,
  time: diaperLog.time,
  type: diaperLog.type,
  notes: diaperLog.notes,
};

const sleepCols = {
  id: sleepLog.id,
  babyId: sleepLog.babyId,
  caretakerId: sleepLog.caretakerId,
  caretakerName: user.name,
  startTime: sleepLog.startTime,
  endTime: sleepLog.endTime,
  location: sleepLog.location,
  notes: sleepLog.notes,
};

// The Phase 3 activity types share one structural shape (id, familyId,
// babyId, caretakerId, time, …specifics, notes) — this generic CRUD is that
// pattern built once. Row/Insert types are supplied per instantiation; the
// narrow `as never` casts are the price of a table-generic drizzle query and
// are contained here.

type SimpleLogTable = SQLiteTable & {
  id: SQLiteColumn;
  familyId: SQLiteColumn;
  babyId: SQLiteColumn;
  caretakerId: SQLiteColumn;
  time: SQLiteColumn;
};

export type ListOpts = { babyId?: string; limit?: number; before?: Date };

export type LogCrud<Row, Insert> = {
  list(opts?: ListOpts): Promise<Row[]>;
  get(id: string): Promise<Row | null>;
  create(
    values: Insert & { babyId: string; caretakerId: string; time: Date },
  ): Promise<Row | null>;
  update(
    id: string,
    patch: Partial<Insert> & { time?: Date },
  ): Promise<Row | null>;
  del(id: string): Promise<boolean>;
};

function logCrud<Row, Insert>(
  db: Db,
  familyId: string,
  table: SimpleLogTable,
  extraCols: Record<string, SQLiteColumn>,
): LogCrud<Row, Insert> {
  const cols = {
    id: table.id,
    babyId: table.babyId,
    caretakerId: table.caretakerId,
    caretakerName: user.name,
    time: table.time,
    ...extraCols,
  };
  const scope = (babyId?: string) =>
    and(
      eq(table.familyId, familyId),
      babyId ? eq(table.babyId, babyId) : undefined,
    );
  return {
    async list(opts: ListOpts = {}) {
      const rows = await db
        .select(cols)
        .from(table)
        .innerJoin(user, eq(table.caretakerId, user.id))
        .where(
          and(
            scope(opts.babyId),
            opts.before ? lt(table.time, opts.before) : undefined,
          ),
        )
        .orderBy(desc(table.time))
        .limit(opts.limit ?? 50);
      return rows as Row[];
    },
    async get(id: string) {
      const rows = await db
        .select(cols)
        .from(table)
        .innerJoin(user, eq(table.caretakerId, user.id))
        .where(and(eq(table.id, id), eq(table.familyId, familyId)));
      return (rows[0] as Row) ?? null;
    },
    async create(values) {
      const rows = await db
        .insert(table)
        .values({ ...values, familyId } as never)
        .returning({ id: table.id });
      return this.get((rows[0] as { id: string }).id);
    },
    async update(id, patch) {
      const rows = await db
        .update(table)
        .set(patch as never)
        .where(and(eq(table.id, id), eq(table.familyId, familyId)))
        .returning({ id: table.id });
      return rows[0] ? this.get(id) : null;
    },
    async del(id) {
      const rows = await db
        .delete(table)
        .where(and(eq(table.id, id), eq(table.familyId, familyId)))
        .returning({ id: table.id });
      return rows.length > 0;
    },
  };
}

type WithNotes = { notes?: string | null };

export type MedicineRow = {
  id: string;
  babyId: string;
  caretakerId: string;
  caretakerName: string;
  time: Date;
  name: string;
  amount: number | null;
  unit: "ml" | "mg" | "drops" | "dose" | null;
  notes: string | null;
};

export type BathRow = Omit<MedicineRow, "name" | "amount" | "unit">;
export type NoteRow = BathRow & { content: string };
export type MilestoneRow = BathRow & { title: string };
export type MeasurementRow = BathRow & {
  type: "weight" | "length" | "head";
  value: number;
};
export type PumpRow = BathRow & {
  side: "left" | "right" | "both" | null;
  amountMl: number | null;
  durationMin: number | null;
};

export function familyScope(db: Db, familyId: string) {
  const feedScope = (babyId?: string) =>
    and(
      eq(feedLog.familyId, familyId),
      babyId ? eq(feedLog.babyId, babyId) : undefined,
    );
  const diaperScope = (babyId?: string) =>
    and(
      eq(diaperLog.familyId, familyId),
      babyId ? eq(diaperLog.babyId, babyId) : undefined,
    );
  const sleepScope = (babyId?: string) =>
    and(
      eq(sleepLog.familyId, familyId),
      babyId ? eq(sleepLog.babyId, babyId) : undefined,
    );

  return {
    familyId,

    // --- family ---
    async family() {
      const rows = await db
        .select({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          plan: organization.plan,
        })
        .from(organization)
        .where(eq(organization.id, familyId));
      return rows[0] ?? null;
    },

    async members() {
      return db
        .select({
          userId: member.userId,
          name: user.name,
          email: user.email,
          role: member.role,
          image: user.image,
        })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(eq(member.organizationId, familyId));
    },

    // --- babies ---
    async listBabies() {
      return db
        .select()
        .from(baby)
        .where(eq(baby.familyId, familyId))
        .orderBy(baby.createdAt);
    },

    async getBaby(id: string) {
      const rows = await db
        .select()
        .from(baby)
        .where(and(eq(baby.id, id), eq(baby.familyId, familyId)));
      return rows[0] ?? null;
    },

    async createBaby(data: {
      name: string;
      birthDate: Date;
      sex?: "girl" | "boy" | null;
    }) {
      const rows = await db
        .insert(baby)
        .values({ ...data, familyId })
        .returning();
      return rows[0]!;
    },

    async updateBaby(
      id: string,
      patch: Partial<{
        name: string;
        birthDate: Date;
        sex: "girl" | "boy" | null;
      }>,
    ) {
      const rows = await db
        .update(baby)
        .set(patch)
        .where(and(eq(baby.id, id), eq(baby.familyId, familyId)))
        .returning();
      return rows[0] ?? null;
    },

    // --- feeds ---
    async listFeeds(
      opts: { babyId?: string; limit?: number; before?: Date } = {},
    ) {
      return db
        .select(feedCols)
        .from(feedLog)
        .innerJoin(user, eq(feedLog.caretakerId, user.id))
        .where(
          and(
            feedScope(opts.babyId),
            opts.before ? lt(feedLog.time, opts.before) : undefined,
          ),
        )
        .orderBy(desc(feedLog.time))
        .limit(opts.limit ?? 50);
    },

    async getFeed(id: string) {
      const rows = await db
        .select(feedCols)
        .from(feedLog)
        .innerJoin(user, eq(feedLog.caretakerId, user.id))
        .where(and(eq(feedLog.id, id), eq(feedLog.familyId, familyId)));
      return rows[0] ?? null;
    },

    async createFeed(data: {
      babyId: string;
      caretakerId: string;
      time: Date;
      type: "bottle" | "breast" | "solids";
      amountMl?: number | null;
      side?: "left" | "right" | "both" | null;
      durationMin?: number | null;
      notes?: string | null;
    }) {
      const rows = await db
        .insert(feedLog)
        .values({ ...data, familyId })
        .returning({ id: feedLog.id });
      return this.getFeed(rows[0]!.id);
    },

    async updateFeed(
      id: string,
      patch: Partial<{
        time: Date;
        type: "bottle" | "breast" | "solids";
        amountMl: number | null;
        side: "left" | "right" | "both" | null;
        durationMin: number | null;
        notes: string | null;
      }>,
    ) {
      const rows = await db
        .update(feedLog)
        .set(patch)
        .where(and(eq(feedLog.id, id), eq(feedLog.familyId, familyId)))
        .returning({ id: feedLog.id });
      return rows[0] ? this.getFeed(id) : null;
    },

    async deleteFeed(id: string) {
      const rows = await db
        .delete(feedLog)
        .where(and(eq(feedLog.id, id), eq(feedLog.familyId, familyId)))
        .returning({ id: feedLog.id });
      return rows.length > 0;
    },

    // --- diapers ---
    async listDiapers(
      opts: { babyId?: string; limit?: number; before?: Date } = {},
    ) {
      return db
        .select(diaperCols)
        .from(diaperLog)
        .innerJoin(user, eq(diaperLog.caretakerId, user.id))
        .where(
          and(
            diaperScope(opts.babyId),
            opts.before ? lt(diaperLog.time, opts.before) : undefined,
          ),
        )
        .orderBy(desc(diaperLog.time))
        .limit(opts.limit ?? 50);
    },

    async getDiaper(id: string) {
      const rows = await db
        .select(diaperCols)
        .from(diaperLog)
        .innerJoin(user, eq(diaperLog.caretakerId, user.id))
        .where(and(eq(diaperLog.id, id), eq(diaperLog.familyId, familyId)));
      return rows[0] ?? null;
    },

    async createDiaper(data: {
      babyId: string;
      caretakerId: string;
      time: Date;
      type: "wet" | "dirty" | "both";
      notes?: string | null;
    }) {
      const rows = await db
        .insert(diaperLog)
        .values({ ...data, familyId })
        .returning({ id: diaperLog.id });
      return this.getDiaper(rows[0]!.id);
    },

    async updateDiaper(
      id: string,
      patch: Partial<{
        time: Date;
        type: "wet" | "dirty" | "both";
        notes: string | null;
      }>,
    ) {
      const rows = await db
        .update(diaperLog)
        .set(patch)
        .where(and(eq(diaperLog.id, id), eq(diaperLog.familyId, familyId)))
        .returning({ id: diaperLog.id });
      return rows[0] ? this.getDiaper(id) : null;
    },

    async deleteDiaper(id: string) {
      const rows = await db
        .delete(diaperLog)
        .where(and(eq(diaperLog.id, id), eq(diaperLog.familyId, familyId)))
        .returning({ id: diaperLog.id });
      return rows.length > 0;
    },

    // --- sleep ---
    async listSleeps(
      opts: { babyId?: string; limit?: number; before?: Date } = {},
    ) {
      return db
        .select(sleepCols)
        .from(sleepLog)
        .innerJoin(user, eq(sleepLog.caretakerId, user.id))
        .where(
          and(
            sleepScope(opts.babyId),
            opts.before ? lt(sleepLog.startTime, opts.before) : undefined,
          ),
        )
        .orderBy(desc(sleepLog.startTime))
        .limit(opts.limit ?? 50);
    },

    async getSleep(id: string) {
      const rows = await db
        .select(sleepCols)
        .from(sleepLog)
        .innerJoin(user, eq(sleepLog.caretakerId, user.id))
        .where(and(eq(sleepLog.id, id), eq(sleepLog.familyId, familyId)));
      return rows[0] ?? null;
    },

    // The active session for a baby (endTime IS NULL), if any.
    async activeSleep(babyId?: string) {
      const rows = await db
        .select(sleepCols)
        .from(sleepLog)
        .innerJoin(user, eq(sleepLog.caretakerId, user.id))
        .where(and(sleepScope(babyId), isNull(sleepLog.endTime)))
        .orderBy(desc(sleepLog.startTime))
        .limit(1);
      return rows[0] ?? null;
    },

    async createSleep(data: {
      babyId: string;
      caretakerId: string;
      startTime: Date;
      endTime?: Date | null;
      location?: string | null;
      notes?: string | null;
    }) {
      const rows = await db
        .insert(sleepLog)
        .values({ ...data, familyId })
        .returning({ id: sleepLog.id });
      return this.getSleep(rows[0]!.id);
    },

    // Ends the active session; the NULL guard makes double-wake harmless.
    async wakeSleep(id: string, endTime: Date) {
      const rows = await db
        .update(sleepLog)
        .set({ endTime })
        .where(
          and(
            eq(sleepLog.id, id),
            eq(sleepLog.familyId, familyId),
            isNull(sleepLog.endTime),
          ),
        )
        .returning({ id: sleepLog.id });
      return rows[0] ? this.getSleep(id) : null;
    },

    async updateSleep(
      id: string,
      patch: Partial<{
        startTime: Date;
        endTime: Date | null;
        location: string | null;
        notes: string | null;
      }>,
    ) {
      const rows = await db
        .update(sleepLog)
        .set(patch)
        .where(and(eq(sleepLog.id, id), eq(sleepLog.familyId, familyId)))
        .returning({ id: sleepLog.id });
      return rows[0] ? this.getSleep(id) : null;
    },

    async deleteSleep(id: string) {
      const rows = await db
        .delete(sleepLog)
        .where(and(eq(sleepLog.id, id), eq(sleepLog.familyId, familyId)))
        .returning({ id: sleepLog.id });
      return rows.length > 0;
    },

    // --- range queries for stats (no caretaker join needed) ---
    async feedsInRange(babyId: string, from: Date, to: Date) {
      return db
        .select({
          time: feedLog.time,
          type: feedLog.type,
          amountMl: feedLog.amountMl,
        })
        .from(feedLog)
        .where(
          and(
            eq(feedLog.familyId, familyId),
            eq(feedLog.babyId, babyId),
            gte(feedLog.time, from),
            lt(feedLog.time, to),
          ),
        );
    },

    async diapersInRange(babyId: string, from: Date, to: Date) {
      return db
        .select({ time: diaperLog.time })
        .from(diaperLog)
        .where(
          and(
            eq(diaperLog.familyId, familyId),
            eq(diaperLog.babyId, babyId),
            gte(diaperLog.time, from),
            lt(diaperLog.time, to),
          ),
        );
    },

    // Sessions OVERLAPPING the range (they can span midnight and the range
    // edges); active sessions have endTime null.
    async sleepsInRange(babyId: string, from: Date, to: Date) {
      return db
        .select({ startTime: sleepLog.startTime, endTime: sleepLog.endTime })
        .from(sleepLog)
        .where(
          and(
            eq(sleepLog.familyId, familyId),
            eq(sleepLog.babyId, babyId),
            lt(sleepLog.startTime, to),
            or(isNull(sleepLog.endTime), gt(sleepLog.endTime, from)),
          ),
        );
    },

    // One query bundle for the home screen glance.
    async summary(babyId: string) {
      const [feeds, diapers, active, sleeps] = await Promise.all([
        this.listFeeds({ babyId, limit: 1 }),
        this.listDiapers({ babyId, limit: 1 }),
        this.activeSleep(babyId),
        this.listSleeps({ babyId, limit: 1 }),
      ]);
      return {
        lastFeed: feeds[0] ?? null,
        lastDiaper: diapers[0] ?? null,
        activeSleep: active,
        lastSleep: sleeps[0] ?? null,
      };
    },

    // --- Phase 3 activity types (generic CRUD instantiations) ---
    medicine: logCrud<
      MedicineRow,
      WithNotes & {
        name: string;
        amount?: number | null;
        unit?: "ml" | "mg" | "drops" | "dose" | null;
      }
    >(db, familyId, medicineLog, {
      name: medicineLog.name,
      amount: medicineLog.amount,
      unit: medicineLog.unit,
      notes: medicineLog.notes,
    }),

    bath: logCrud<BathRow, WithNotes>(db, familyId, bathLog, {
      notes: bathLog.notes,
    }),

    note: logCrud<NoteRow, WithNotes & { content: string }>(
      db,
      familyId,
      noteLog,
      { content: noteLog.content, notes: noteLog.notes },
    ),

    milestone: logCrud<MilestoneRow, WithNotes & { title: string }>(
      db,
      familyId,
      milestoneLog,
      { title: milestoneLog.title, notes: milestoneLog.notes },
    ),

    measurement: logCrud<
      MeasurementRow,
      WithNotes & { type: "weight" | "length" | "head"; value: number }
    >(db, familyId, measurementLog, {
      type: measurementLog.type,
      value: measurementLog.value,
      notes: measurementLog.notes,
    }),

    pump: logCrud<
      PumpRow,
      WithNotes & {
        side?: "left" | "right" | "both" | null;
        amountMl?: number | null;
        durationMin?: number | null;
      }
    >(db, familyId, pumpLog, {
      side: pumpLog.side,
      amountMl: pumpLog.amountMl,
      durationMin: pumpLog.durationMin,
      notes: pumpLog.notes,
    }),

    // --- API keys (admin-managed; the raw key exists only in the return) ---
    async createApiKey(data: { name: string; createdBy: string }) {
      const raw = generateApiKey();
      const rows = await db
        .insert(apiKey)
        .values({
          familyId,
          name: data.name,
          createdBy: data.createdBy,
          keyHash: await sha256Hex(raw),
          prefix: raw.slice(0, 12),
        })
        .returning();
      return { row: rows[0]!, key: raw };
    },

    async listApiKeys() {
      return db
        .select()
        .from(apiKey)
        .where(eq(apiKey.familyId, familyId))
        .orderBy(desc(apiKey.createdAt));
    },

    async revokeApiKey(id: string) {
      const rows = await db
        .update(apiKey)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiKey.id, id),
            eq(apiKey.familyId, familyId),
            isNull(apiKey.revokedAt),
          ),
        )
        .returning({ id: apiKey.id });
      return rows.length > 0;
    },

    // --- invites (create/list/revoke; redeem lives outside the scope) ---
    async createInvite(data: {
      role: "admin" | "member";
      expiresAt: Date;
      maxUses: number;
      createdBy: string;
    }) {
      const code = generateInviteCode();
      const rows = await db
        .insert(familyInvite)
        .values({ ...data, code, familyId })
        .returning();
      return rows[0]!;
    },

    async listInvites() {
      return db
        .select()
        .from(familyInvite)
        .where(eq(familyInvite.familyId, familyId))
        .orderBy(desc(familyInvite.createdAt));
    },

    async revokeInvite(code: string) {
      const rows = await db
        .update(familyInvite)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(familyInvite.code, code),
            eq(familyInvite.familyId, familyId),
            isNull(familyInvite.revokedAt),
          ),
        )
        .returning({ code: familyInvite.code });
      return rows.length > 0;
    },
  };
}

export type FamilyScope = ReturnType<typeof familyScope>;

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `pjk_${b64}`;
}

// Unambiguous alphabet (no 0/O/1/I) — codes get read aloud across a dinner
// table.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateInviteCode(length = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(
    "",
  );
}
