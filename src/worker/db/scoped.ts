import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  or,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "./index";
import {
  apiKey,
  baby,
  bathLog,
  calendarAssignee,
  calendarEvent,
  calendarEventBaby,
  contact,
  contactBaby,
  diaperLog,
  familyInvite,
  feedLog,
  measurementLog,
  medicineLog,
  member,
  milestoneLog,
  noteLog,
  organization,
  playLog,
  pumpLog,
  sleepLocation,
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
  leftMin: feedLog.leftMin,
  rightMin: feedLog.rightMin,
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

export type PlayTypeKey = "tummy" | "walk" | "play";

const playCols = {
  id: playLog.id,
  babyId: playLog.babyId,
  caretakerId: playLog.caretakerId,
  caretakerName: user.name,
  type: playLog.type,
  startTime: playLog.startTime,
  endTime: playLog.endTime,
  notes: playLog.notes,
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

// Keyset cursor over the global order (time DESC, id DESC). The id tiebreak
// makes pagination lossless when entries share a timestamp.
export type Cursor = { time: Date; id: string };

export type ListOpts = { babyId?: string; limit?: number; before?: Cursor };

function beforeCursor(
  timeCol: SQLiteColumn,
  idCol: SQLiteColumn,
  cursor: Cursor | undefined,
) {
  if (!cursor) return undefined;
  return or(
    lt(timeCol, cursor.time),
    and(eq(timeCol, cursor.time), lt(idCol, cursor.id)),
  );
}

// Drizzle's .set() throws on an object with no defined values, so every
// update strips undefineds first and treats an empty patch as a no-op read.
function compactPatch<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

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
            beforeCursor(table.time, table.id, opts.before),
          ),
        )
        .orderBy(desc(table.time), desc(table.id))
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
      const set = compactPatch(patch);
      if (Object.keys(set).length === 0) return this.get(id);
      const rows = await db
        .update(table)
        .set(set as never)
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

export type CalendarCategory =
  | "doctor"
  | "vaccination"
  | "babysitting"
  | "family"
  | "other";

export type CalendarEventRow = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  category: CalendarCategory;
  startTime: Date;
  allDay: boolean;
  durationMin: number | null;
  remindMinutesBefore: number | null;
  createdBy: string;
  createdByName: string;
  babies: { id: string; name: string }[];
  assignees: { userId: string; name: string }[];
};

const calendarCols = {
  id: calendarEvent.id,
  title: calendarEvent.title,
  description: calendarEvent.description,
  location: calendarEvent.location,
  category: calendarEvent.category,
  startTime: calendarEvent.startTime,
  allDay: calendarEvent.allDay,
  durationMin: calendarEvent.durationMin,
  remindMinutesBefore: calendarEvent.remindMinutesBefore,
  createdBy: calendarEvent.createdBy,
  createdByName: user.name,
};

export type ContactIconKey =
  | "user"
  | "doctor"
  | "nurse"
  | "hospital"
  | "dental"
  | "family"
  | "grandparent"
  | "daycare"
  | "friend"
  | "phone";

export type ContactRow = {
  id: string;
  name: string;
  role: string | null;
  icon: ContactIconKey | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  notes: string | null;
  babies: { id: string; name: string }[];
};

const contactCols = {
  id: contact.id,
  name: contact.name,
  role: contact.role,
  icon: contact.icon,
  phone: contact.phone,
  email: contact.email,
  website: contact.website,
  notes: contact.notes,
};

type ContactBaseRow = Omit<ContactRow, "babies">;

// One IN-query + client-side grouping, same shape as the calendar hydrate.
async function hydrateContacts(
  db: Db,
  rows: ContactBaseRow[],
): Promise<ContactRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const linkRows = await db
    .select({
      contactId: contactBaby.contactId,
      id: baby.id,
      name: baby.name,
    })
    .from(contactBaby)
    .innerJoin(baby, eq(contactBaby.babyId, baby.id))
    .where(inArray(contactBaby.contactId, ids));
  return rows.map((r) => ({
    ...r,
    babies: linkRows
      .filter((l) => l.contactId === r.id)
      .map(({ id, name }) => ({ id, name })),
  }));
}

type CalendarBaseRow = Omit<CalendarEventRow, "babies" | "assignees">;

// Two IN-queries + client-side grouping beats N+1 per event at family scale.
async function hydrateCalendarEvents(
  db: Db,
  rows: CalendarBaseRow[],
): Promise<CalendarEventRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [babyRows, assigneeRows] = await Promise.all([
    db
      .select({
        eventId: calendarEventBaby.eventId,
        id: baby.id,
        name: baby.name,
      })
      .from(calendarEventBaby)
      .innerJoin(baby, eq(calendarEventBaby.babyId, baby.id))
      .where(inArray(calendarEventBaby.eventId, ids)),
    db
      .select({
        eventId: calendarAssignee.eventId,
        userId: user.id,
        name: user.name,
      })
      .from(calendarAssignee)
      .innerJoin(user, eq(calendarAssignee.userId, user.id))
      .where(inArray(calendarAssignee.eventId, ids)),
  ]);
  return rows.map((r) => ({
    ...r,
    babies: babyRows
      .filter((b) => b.eventId === r.id)
      .map(({ id, name }) => ({ id, name })),
    assignees: assigneeRows
      .filter((a) => a.eventId === r.id)
      .map(({ userId, name }) => ({ userId, name })),
  }));
}

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
  const playScope = (babyId?: string) =>
    and(
      eq(playLog.familyId, familyId),
      babyId ? eq(playLog.babyId, babyId) : undefined,
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

    // Narrow, billing-only lookup — deliberately NOT folded into family()
    // above, whose result is returned verbatim by GET /api/family to every
    // member (not just admins); stripeCustomerId must never ride along.
    async stripeCustomerId() {
      const rows = await db
        .select({ stripeCustomerId: organization.stripeCustomerId })
        .from(organization)
        .where(eq(organization.id, familyId));
      return rows[0]?.stripeCustomerId ?? null;
    },

    async members() {
      return db
        .select({
          memberId: member.id,
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

    async deleteBaby(id: string) {
      // FKs cascade: every log for the baby goes with it.
      const rows = await db
        .delete(baby)
        .where(and(eq(baby.id, id), eq(baby.familyId, familyId)))
        .returning({ id: baby.id });
      return rows.length > 0;
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
      const set = compactPatch(patch);
      if (Object.keys(set).length === 0) return this.getBaby(id);
      const rows = await db
        .update(baby)
        .set(set)
        .where(and(eq(baby.id, id), eq(baby.familyId, familyId)))
        .returning();
      return rows[0] ?? null;
    },

    // --- feeds ---
    async listFeeds(opts: ListOpts = {}) {
      return db
        .select(feedCols)
        .from(feedLog)
        .innerJoin(user, eq(feedLog.caretakerId, user.id))
        .where(
          and(
            feedScope(opts.babyId),
            beforeCursor(feedLog.time, feedLog.id, opts.before),
          ),
        )
        .orderBy(desc(feedLog.time), desc(feedLog.id))
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
      leftMin?: number | null;
      rightMin?: number | null;
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
        leftMin: number | null;
        rightMin: number | null;
        notes: string | null;
      }>,
    ) {
      const set = compactPatch(patch);
      if (Object.keys(set).length === 0) return this.getFeed(id);
      const rows = await db
        .update(feedLog)
        .set(set)
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
    async listDiapers(opts: ListOpts = {}) {
      return db
        .select(diaperCols)
        .from(diaperLog)
        .innerJoin(user, eq(diaperLog.caretakerId, user.id))
        .where(
          and(
            diaperScope(opts.babyId),
            beforeCursor(diaperLog.time, diaperLog.id, opts.before),
          ),
        )
        .orderBy(desc(diaperLog.time), desc(diaperLog.id))
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
      const set = compactPatch(patch);
      if (Object.keys(set).length === 0) return this.getDiaper(id);
      const rows = await db
        .update(diaperLog)
        .set(set)
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
    async listSleeps(opts: ListOpts = {}) {
      return db
        .select(sleepCols)
        .from(sleepLog)
        .innerJoin(user, eq(sleepLog.caretakerId, user.id))
        .where(
          and(
            sleepScope(opts.babyId),
            beforeCursor(sleepLog.startTime, sleepLog.id, opts.before),
          ),
        )
        .orderBy(desc(sleepLog.startTime), desc(sleepLog.id))
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
      const set = compactPatch(patch);
      if (Object.keys(set).length === 0) return this.getSleep(id);
      const rows = await db
        .update(sleepLog)
        .set(set)
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
        .select({ time: diaperLog.time, type: diaperLog.type })
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
      const [feeds, diapers, active, sleeps, play] = await Promise.all([
        this.listFeeds({ babyId, limit: 1 }),
        this.listDiapers({ babyId, limit: 1 }),
        this.activeSleep(babyId),
        this.listSleeps({ babyId, limit: 1 }),
        this.activePlay(babyId),
      ]);
      return {
        lastFeed: feeds[0] ?? null,
        lastDiaper: diapers[0] ?? null,
        activeSleep: active,
        lastSleep: sleeps[0] ?? null,
        activePlay: play,
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
    async createApiKey(data: {
      name: string;
      createdBy: string;
      expiresAt?: Date | null;
      readOnly?: boolean;
    }) {
      const raw = generateApiKey();
      const rows = await db
        .insert(apiKey)
        .values({
          familyId,
          name: data.name,
          createdBy: data.createdBy,
          keyHash: await sha256Hex(raw),
          prefix: raw.slice(0, 12),
          expiresAt: data.expiresAt ?? null,
          readOnly: data.readOnly ?? false,
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

    // --- sleep locations (custom chips, e.g. "Crib", "Grandma's") ---
    async listSleepLocations() {
      return db
        .select({ id: sleepLocation.id, name: sleepLocation.name })
        .from(sleepLocation)
        .where(eq(sleepLocation.familyId, familyId))
        .orderBy(sleepLocation.createdAt);
    },

    async createSleepLocation(name: string) {
      const rows = await db
        .insert(sleepLocation)
        .values({ familyId, name })
        .returning();
      return rows[0]!;
    },

    async deleteSleepLocation(id: string) {
      const rows = await db
        .delete(sleepLocation)
        .where(
          and(eq(sleepLocation.id, id), eq(sleepLocation.familyId, familyId)),
        )
        .returning({ id: sleepLocation.id });
      return rows.length > 0;
    },

    // --- play (premium): timed activities, same session shape as sleep ---
    async listPlays(opts: ListOpts = {}) {
      return db
        .select(playCols)
        .from(playLog)
        .innerJoin(user, eq(playLog.caretakerId, user.id))
        .where(
          and(
            playScope(opts.babyId),
            beforeCursor(playLog.startTime, playLog.id, opts.before),
          ),
        )
        .orderBy(desc(playLog.startTime), desc(playLog.id))
        .limit(opts.limit ?? 50);
    },

    async getPlay(id: string) {
      const rows = await db
        .select(playCols)
        .from(playLog)
        .innerJoin(user, eq(playLog.caretakerId, user.id))
        .where(and(eq(playLog.id, id), eq(playLog.familyId, familyId)));
      return rows[0] ?? null;
    },

    // The running activity for a baby (endTime IS NULL), if any.
    async activePlay(babyId?: string) {
      const rows = await db
        .select(playCols)
        .from(playLog)
        .innerJoin(user, eq(playLog.caretakerId, user.id))
        .where(and(playScope(babyId), isNull(playLog.endTime)))
        .orderBy(desc(playLog.startTime))
        .limit(1);
      return rows[0] ?? null;
    },

    async createPlay(data: {
      babyId: string;
      caretakerId: string;
      type: PlayTypeKey;
      startTime: Date;
      endTime?: Date | null;
      notes?: string | null;
    }) {
      const rows = await db
        .insert(playLog)
        .values({ ...data, familyId })
        .returning({ id: playLog.id });
      return this.getPlay(rows[0]!.id);
    },

    // Ends the running activity; the NULL guard makes a double-stop harmless.
    async stopPlay(id: string, endTime: Date) {
      const rows = await db
        .update(playLog)
        .set({ endTime })
        .where(
          and(
            eq(playLog.id, id),
            eq(playLog.familyId, familyId),
            isNull(playLog.endTime),
          ),
        )
        .returning({ id: playLog.id });
      return rows[0] ? this.getPlay(id) : null;
    },

    async updatePlay(
      id: string,
      patch: Partial<{
        type: PlayTypeKey;
        startTime: Date;
        endTime: Date | null;
        notes: string | null;
      }>,
    ) {
      const set = compactPatch(patch);
      if (Object.keys(set).length === 0) return this.getPlay(id);
      const rows = await db
        .update(playLog)
        .set(set)
        .where(and(eq(playLog.id, id), eq(playLog.familyId, familyId)))
        .returning({ id: playLog.id });
      return rows[0] ? this.getPlay(id) : null;
    },

    async deletePlay(id: string) {
      const rows = await db
        .delete(playLog)
        .where(and(eq(playLog.id, id), eq(playLog.familyId, familyId)))
        .returning({ id: playLog.id });
      return rows.length > 0;
    },

    // --- contacts (premium): family people, hydrated with baby links ---
    async listContacts() {
      const rows = await db
        .select(contactCols)
        .from(contact)
        .where(eq(contact.familyId, familyId))
        .orderBy(asc(contact.name), asc(contact.id));
      return hydrateContacts(db, rows);
    },

    async getContact(id: string) {
      const rows = await db
        .select(contactCols)
        .from(contact)
        .where(and(eq(contact.id, id), eq(contact.familyId, familyId)));
      if (!rows[0]) return null;
      const hydrated = await hydrateContacts(db, rows);
      return hydrated[0] ?? null;
    },

    async createContact(data: {
      name: string;
      role?: string | null;
      icon?: ContactIconKey | null;
      phone?: string | null;
      email?: string | null;
      website?: string | null;
      notes?: string | null;
      babyIds: string[];
    }) {
      const id = crypto.randomUUID();
      // Contact row first, links after — same ordering rationale as
      // createCalendarEvent: never leave dangling link rows.
      const statements: BatchItem<"sqlite">[] = [
        db.insert(contact).values({
          id,
          familyId,
          name: data.name,
          role: data.role ?? null,
          icon: data.icon ?? null,
          phone: data.phone ?? null,
          email: data.email ?? null,
          website: data.website ?? null,
          notes: data.notes ?? null,
        }),
      ];
      if (data.babyIds.length > 0) {
        statements.push(
          db
            .insert(contactBaby)
            .values(data.babyIds.map((babyId) => ({ contactId: id, babyId }))),
        );
      }
      await db.batch(statements as never);
      return this.getContact(id);
    },

    async updateContact(
      id: string,
      patch: Partial<{
        name: string;
        role: string | null;
        icon: ContactIconKey | null;
        phone: string | null;
        email: string | null;
        website: string | null;
        notes: string | null;
      }>,
      links: { babyIds?: string[] },
    ) {
      const set = compactPatch(patch);
      if (Object.keys(set).length > 0) {
        const rows = await db
          .update(contact)
          .set(set)
          .where(and(eq(contact.id, id), eq(contact.familyId, familyId)))
          .returning({ id: contact.id });
        if (!rows[0]) return null;
      } else {
        // Ownership check even for a link-only update.
        const rows = await db
          .select({ id: contact.id })
          .from(contact)
          .where(and(eq(contact.id, id), eq(contact.familyId, familyId)));
        if (!rows[0]) return null;
      }
      if (links.babyIds !== undefined) {
        const statements: BatchItem<"sqlite">[] = [
          db.delete(contactBaby).where(eq(contactBaby.contactId, id)),
        ];
        if (links.babyIds.length > 0) {
          statements.push(
            db
              .insert(contactBaby)
              .values(
                links.babyIds.map((babyId) => ({ contactId: id, babyId })),
              ),
          );
        }
        await db.batch(statements as never);
      }
      return this.getContact(id);
    },

    async deleteContact(id: string) {
      // Link rows go with it via ON DELETE cascade.
      const rows = await db
        .delete(contact)
        .where(and(eq(contact.id, id), eq(contact.familyId, familyId)))
        .returning({ id: contact.id });
      return rows.length > 0;
    },

    // --- calendar (premium): family-wide events, hydrated with link rows ---
    async listCalendarEvents(from: Date, to: Date) {
      const rows = await db
        .select(calendarCols)
        .from(calendarEvent)
        .innerJoin(user, eq(calendarEvent.createdBy, user.id))
        .where(
          and(
            eq(calendarEvent.familyId, familyId),
            gte(calendarEvent.startTime, from),
            lt(calendarEvent.startTime, to),
          ),
        )
        .orderBy(asc(calendarEvent.startTime), asc(calendarEvent.id));
      return hydrateCalendarEvents(db, rows);
    },

    async getCalendarEvent(id: string) {
      const rows = await db
        .select(calendarCols)
        .from(calendarEvent)
        .innerJoin(user, eq(calendarEvent.createdBy, user.id))
        .where(
          and(eq(calendarEvent.id, id), eq(calendarEvent.familyId, familyId)),
        );
      if (!rows[0]) return null;
      const hydrated = await hydrateCalendarEvents(db, rows);
      return hydrated[0] ?? null;
    },

    async createCalendarEvent(data: {
      createdBy: string;
      title: string;
      description?: string | null;
      location?: string | null;
      category: CalendarCategory;
      startTime: Date;
      allDay: boolean;
      durationMin?: number | null;
      remindMinutesBefore?: number | null;
      babyIds: string[];
      assigneeUserIds: string[];
    }) {
      const id = crypto.randomUUID();
      // Event row first, link rows after: a partial batch failure leaves a
      // valid (if link-less) event, never dangling links (D1 has no
      // transactions; batch() is atomic anyway, this is belt-and-braces).
      const statements: BatchItem<"sqlite">[] = [
        db.insert(calendarEvent).values({
          id,
          familyId,
          createdBy: data.createdBy,
          title: data.title,
          description: data.description ?? null,
          location: data.location ?? null,
          category: data.category,
          startTime: data.startTime,
          allDay: data.allDay,
          durationMin: data.allDay ? null : (data.durationMin ?? null),
          remindMinutesBefore: data.remindMinutesBefore ?? null,
        }),
      ];
      if (data.babyIds.length > 0) {
        statements.push(
          db
            .insert(calendarEventBaby)
            .values(data.babyIds.map((babyId) => ({ eventId: id, babyId }))),
        );
      }
      if (data.assigneeUserIds.length > 0) {
        statements.push(
          db
            .insert(calendarAssignee)
            .values(
              data.assigneeUserIds.map((userId) => ({ eventId: id, userId })),
            ),
        );
      }
      await db.batch(statements as never);
      return this.getCalendarEvent(id);
    },

    async updateCalendarEvent(
      id: string,
      patch: Partial<{
        title: string;
        description: string | null;
        location: string | null;
        category: CalendarCategory;
        startTime: Date;
        allDay: boolean;
        durationMin: number | null;
        remindMinutesBefore: number | null;
        remindedAt: Date | null;
      }>,
      links: { babyIds?: string[]; assigneeUserIds?: string[] },
    ) {
      const set = compactPatch(patch);
      if (Object.keys(set).length > 0) {
        const rows = await db
          .update(calendarEvent)
          .set(set)
          .where(
            and(eq(calendarEvent.id, id), eq(calendarEvent.familyId, familyId)),
          )
          .returning({ id: calendarEvent.id });
        if (!rows[0]) return null;
      } else {
        // Ownership check even for a link-only update.
        const rows = await db
          .select({ id: calendarEvent.id })
          .from(calendarEvent)
          .where(
            and(eq(calendarEvent.id, id), eq(calendarEvent.familyId, familyId)),
          );
        if (!rows[0]) return null;
      }
      const statements: BatchItem<"sqlite">[] = [];
      if (links.babyIds !== undefined) {
        statements.push(
          db.delete(calendarEventBaby).where(eq(calendarEventBaby.eventId, id)),
        );
        if (links.babyIds.length > 0) {
          statements.push(
            db
              .insert(calendarEventBaby)
              .values(links.babyIds.map((babyId) => ({ eventId: id, babyId }))),
          );
        }
      }
      if (links.assigneeUserIds !== undefined) {
        statements.push(
          db.delete(calendarAssignee).where(eq(calendarAssignee.eventId, id)),
        );
        if (links.assigneeUserIds.length > 0) {
          statements.push(
            db.insert(calendarAssignee).values(
              links.assigneeUserIds.map((userId) => ({
                eventId: id,
                userId,
              })),
            ),
          );
        }
      }
      if (statements.length > 0) {
        await db.batch(statements as never);
      }
      return this.getCalendarEvent(id);
    },

    async deleteCalendarEvent(id: string) {
      // Link rows go with it via ON DELETE cascade.
      const rows = await db
        .delete(calendarEvent)
        .where(
          and(eq(calendarEvent.id, id), eq(calendarEvent.familyId, familyId)),
        )
        .returning({ id: calendarEvent.id });
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
