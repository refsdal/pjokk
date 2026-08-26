import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { schema } from "../src/worker/db";
import { familyScope } from "../src/worker/db/scoped";
import {
  addMember,
  api,
  createBaby,
  createFamily,
  createUser,
  db,
  rig,
  setPlan,
} from "./helpers";

const HOUR = 3600_000;

describe("calendar scoped helpers", () => {
  it("creates an event with babies + assignees and hydrates them back", async () => {
    const { user, family, baby } = await rig();
    const other = await createUser("Other parent");
    await addMember(other.id, family.id, "member");
    const fam = familyScope(db(), family.id);

    const start = new Date(Date.now() + 24 * HOUR);
    const created = await fam.createCalendarEvent({
      createdBy: user.id,
      title: "Doctor checkup",
      description: "6-month control",
      location: "Legesenteret",
      category: "doctor",
      startTime: start,
      allDay: false,
      durationMin: 30,
      remindMinutesBefore: 60,
      babyIds: [baby.id],
      assigneeUserIds: [user.id, other.id],
    });
    expect(created).not.toBeNull();
    expect(created!.title).toBe("Doctor checkup");
    expect(created!.createdByName).toBe("Rig admin");
    expect(created!.babies).toEqual([{ id: baby.id, name: "Rig baby" }]);
    expect(created!.assignees.map((a) => a.userId).sort()).toEqual(
      [user.id, other.id].sort(),
    );
  });

  it("lists only events inside the range, ascending, family-scoped", async () => {
    const { user, family } = await rig();
    const fam = familyScope(db(), family.id);
    const base = Date.now();
    const mk = (title: string, offsetH: number) =>
      fam.createCalendarEvent({
        createdBy: user.id,
        title,
        category: "other",
        startTime: new Date(base + offsetH * HOUR),
        allDay: false,
        babyIds: [],
        assigneeUserIds: [],
      });
    await mk("later", 48);
    await mk("sooner", 24);
    await mk("outside", 24 * 200);

    // Another family's event in the same window must not leak.
    const stranger = await createUser("Stranger");
    const otherFamily = await createFamily("Other family");
    await addMember(stranger.id, otherFamily.id, "admin");
    await familyScope(db(), otherFamily.id).createCalendarEvent({
      createdBy: stranger.id,
      title: "not yours",
      category: "other",
      startTime: new Date(base + 24 * HOUR),
      allDay: false,
      babyIds: [],
      assigneeUserIds: [],
    });

    const listed = await fam.listCalendarEvents(
      new Date(base),
      new Date(base + 96 * HOUR),
    );
    expect(listed.map((e) => e.title)).toEqual(["sooner", "later"]);
  });

  it("update replaces link rows exactly; empty arrays clear them", async () => {
    const { user, family, baby } = await rig();
    const baby2 = await createBaby(family.id, "Twin");
    const fam = familyScope(db(), family.id);
    const created = await fam.createCalendarEvent({
      createdBy: user.id,
      title: "Vaccine",
      category: "vaccination",
      startTime: new Date(Date.now() + 24 * HOUR),
      allDay: false,
      babyIds: [baby.id],
      assigneeUserIds: [user.id],
    });

    const updated = await fam.updateCalendarEvent(
      created!.id,
      { title: "Vaccine (both)" },
      { babyIds: [baby.id, baby2.id], assigneeUserIds: [] },
    );
    expect(updated!.title).toBe("Vaccine (both)");
    expect(updated!.babies.map((b) => b.id).sort()).toEqual(
      [baby.id, baby2.id].sort(),
    );
    expect(updated!.assignees).toEqual([]);

    // Omitted links stay untouched.
    const again = await fam.updateCalendarEvent(
      created!.id,
      { location: "Helsestasjonen" },
      {},
    );
    expect(again!.babies).toHaveLength(2);
  });

  it("update/delete of another family's event returns null/false", async () => {
    const { user, family } = await rig();
    const fam = familyScope(db(), family.id);
    const created = await fam.createCalendarEvent({
      createdBy: user.id,
      title: "Ours",
      category: "family",
      startTime: new Date(Date.now() + HOUR),
      allDay: true,
      babyIds: [],
      assigneeUserIds: [],
    });

    const stranger = await createUser("Stranger");
    const otherFamily = await createFamily("Other family");
    await addMember(stranger.id, otherFamily.id, "admin");
    const otherFam = familyScope(db(), otherFamily.id);
    expect(
      await otherFam.updateCalendarEvent(created!.id, { title: "Hijack" }, {}),
    ).toBeNull();
    expect(await otherFam.deleteCalendarEvent(created!.id)).toBe(false);
    expect(await fam.deleteCalendarEvent(created!.id)).toBe(true);
    expect(await fam.getCalendarEvent(created!.id)).toBeNull();
  });
});

describe("calendar API", () => {
  const HOUR = 3600_000;
  const futureIso = (h: number) =>
    new Date(Date.now() + h * HOUR).toISOString();
  const range = () =>
    `from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(futureIso(24 * 90))}`;

  it("create is 402 on free; full CRUD on premium; edit/delete stay open after downgrade", async () => {
    const { family, baby, cookie } = await rig();
    const body = {
      title: "Checkup",
      category: "doctor",
      startTime: futureIso(48),
      durationMin: 30,
      babyIds: [baby.id],
    };
    const denied = await api("/api/calendar/events", {
      method: "POST",
      cookie,
      body,
    });
    expect(denied.status).toBe(402);
    expect(((await denied.json()) as { code: string }).code).toBe(
      "PLAN_REQUIRED",
    );

    await setPlan(family.id, "premium");
    const created = await api("/api/calendar/events", {
      method: "POST",
      cookie,
      body,
    });
    expect(created.status).toBe(201);
    const event = (await created.json()) as {
      id: string;
      babies: { id: string }[];
      allDay: boolean;
    };
    expect(event.babies.map((b) => b.id)).toEqual([baby.id]);
    expect(event.allDay).toBe(false);

    await setPlan(family.id, "free");
    const list = await api(`/api/calendar/events?${range()}`, { cookie });
    expect(list.status).toBe(200);
    expect(((await list.json()) as unknown[]).length).toBe(1);
    const patched = await api(`/api/calendar/events/${event.id}`, {
      method: "PATCH",
      cookie,
      body: { title: "Checkup (moved)" },
    });
    expect(patched.status).toBe(200);
    const removed = await api(`/api/calendar/events/${event.id}`, {
      method: "DELETE",
      cookie,
    });
    expect(removed.status).toBe(200);
  });

  it("dedupes duplicate babyIds instead of throwing on the pair-PK insert", async () => {
    const { family, baby, cookie } = await rig();
    await setPlan(family.id, "premium");
    const created = await api("/api/calendar/events", {
      method: "POST",
      cookie,
      body: {
        title: "Checkup",
        startTime: futureIso(48),
        babyIds: [baby.id, baby.id],
      },
    });
    expect(created.status).toBe(201);
    const event = (await created.json()) as { babies: { id: string }[] };
    expect(event.babies.map((b) => b.id)).toEqual([baby.id]);
  });

  it("rejects foreign babyIds and non-member assignees", async () => {
    const a = await rig();
    await setPlan(a.family.id, "premium");
    const b = await rig("Other family");

    const foreignBaby = await api("/api/calendar/events", {
      method: "POST",
      cookie: a.cookie,
      body: { title: "X", startTime: futureIso(1), babyIds: [b.baby.id] },
    });
    expect(foreignBaby.status).toBe(400);
    expect(((await foreignBaby.json()) as { code: string }).code).toBe(
      "INVALID_REFERENCE",
    );

    const foreignAssignee = await api("/api/calendar/events", {
      method: "POST",
      cookie: a.cookie,
      body: {
        title: "X",
        startTime: futureIso(1),
        assigneeUserIds: [b.user.id],
      },
    });
    expect(foreignAssignee.status).toBe(400);
  });

  it("cross-family access is a 404, and ranges are validated", async () => {
    const a = await rig();
    await setPlan(a.family.id, "premium");
    const created = await api("/api/calendar/events", {
      method: "POST",
      cookie: a.cookie,
      body: { title: "Ours", startTime: futureIso(1), allDay: true },
    });
    const { id } = (await created.json()) as { id: string };

    const b = await rig("Other family");
    expect(
      (
        await api(`/api/calendar/events/${id}`, {
          method: "PATCH",
          cookie: b.cookie,
          body: { title: "Hijack" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(`/api/calendar/events/${id}`, {
          method: "DELETE",
          cookie: b.cookie,
        })
      ).status,
    ).toBe(404);

    const inverted = await api(
      `/api/calendar/events?from=${encodeURIComponent(futureIso(2))}&to=${encodeURIComponent(futureIso(1))}`,
      { cookie: a.cookie },
    );
    expect(inverted.status).toBe(400);
  });

  it("allDay create nulls duration; patching allDay true clears it; time edits re-arm the reminder", async () => {
    const a = await rig();
    await setPlan(a.family.id, "premium");
    const created = await api("/api/calendar/events", {
      method: "POST",
      cookie: a.cookie,
      body: {
        title: "Visit",
        startTime: futureIso(24),
        allDay: true,
        durationMin: 60,
        remindMinutesBefore: 60,
      },
    });
    expect(created.status).toBe(201);
    const event = (await created.json()) as {
      id: string;
      durationMin: number | null;
    };
    expect(event.durationMin).toBeNull();

    const patched = await api(`/api/calendar/events/${event.id}`, {
      method: "PATCH",
      cookie: a.cookie,
      body: { startTime: futureIso(48) },
    });
    expect(patched.status).toBe(200);
    // remindedAt reset is internal — verified end-to-end in the reminder tests.
  });

  it("PATCH allDay:true clears an existing duration; PATCH durationMin on an already-all-day event stays null", async () => {
    const a = await rig();
    await setPlan(a.family.id, "premium");

    // (a) timed event with a duration -> PATCH allDay:true clears it.
    const timed = await api("/api/calendar/events", {
      method: "POST",
      cookie: a.cookie,
      body: {
        title: "Timed",
        startTime: futureIso(24),
        allDay: false,
        durationMin: 45,
      },
    });
    expect(timed.status).toBe(201);
    const timedEvent = (await timed.json()) as { id: string };

    const toAllDay = await api(`/api/calendar/events/${timedEvent.id}`, {
      method: "PATCH",
      cookie: a.cookie,
      body: { allDay: true },
    });
    expect(toAllDay.status).toBe(200);
    expect(
      ((await toAllDay.json()) as { durationMin: number | null }).durationMin,
    ).toBeNull();

    // (b) already-all-day event -> PATCH durationMin alone must not stick
    // (regression test for the allDay-vs-existing-state invariant).
    const allDay = await api("/api/calendar/events", {
      method: "POST",
      cookie: a.cookie,
      body: {
        title: "Already all-day",
        startTime: futureIso(24),
        allDay: true,
      },
    });
    expect(allDay.status).toBe(201);
    const allDayEvent = (await allDay.json()) as { id: string };

    const durationOnly = await api(`/api/calendar/events/${allDayEvent.id}`, {
      method: "PATCH",
      cookie: a.cookie,
      body: { durationMin: 45 },
    });
    expect(durationOnly.status).toBe(200);
    expect(
      ((await durationOnly.json()) as { durationMin: number | null })
        .durationMin,
    ).toBeNull();
  });

  it("PATCH startTime re-arms the reminder latch (clears remindedAt)", async () => {
    const a = await rig();
    await setPlan(a.family.id, "premium");
    const created = await api("/api/calendar/events", {
      method: "POST",
      cookie: a.cookie,
      body: {
        title: "Reminder test",
        startTime: futureIso(24),
        remindMinutesBefore: 60,
      },
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    // Simulate the reminder sweep having already fired.
    await db()
      .update(schema.calendarEvent)
      .set({ remindedAt: new Date() })
      .where(eq(schema.calendarEvent.id, id));

    const patched = await api(`/api/calendar/events/${id}`, {
      method: "PATCH",
      cookie: a.cookie,
      body: { startTime: futureIso(48) },
    });
    expect(patched.status).toBe(200);

    const rows = await db()
      .select({ remindedAt: schema.calendarEvent.remindedAt })
      .from(schema.calendarEvent)
      .where(eq(schema.calendarEvent.id, id));
    expect(rows[0]!.remindedAt).toBeNull();
  });
});
