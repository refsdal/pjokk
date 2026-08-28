import { createRoute, z } from "@hono/zod-openapi";
import {
  CalendarEventSchema,
  CreateCalendarEventSchema,
  ErrorSchema,
  UpdateCalendarEventSchema,
} from "@pjokk/shared";
import type { Context } from "hono";
import type { FamEnv } from "../context";
import type { CalendarEventRow } from "../db/scoped";
import { canUse } from "../entitlements";
import { createApp, iso, jsonContent } from "../lib";

const serCalendarEvent = (row: CalendarEventRow) => ({
  ...row,
  startTime: iso(row.startTime),
});

const RangeQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});

const MAX_RANGE_MS = 366 * 24 * 3600_000;

// Both id arrays must reference this family's babies/members. Codes are the
// tenancy backstop — the scoped insert would otherwise happily link foreign
// rows (join tables carry no familyId of their own).
async function refsValid(
  c: Context<FamEnv>,
  babyIds: string[] | undefined,
  userIds: string[] | undefined,
): Promise<boolean> {
  if (babyIds && babyIds.length > 0) {
    const ok = new Set((await c.var.fam.listBabies()).map((b) => b.id));
    if (!babyIds.every((id) => ok.has(id))) return false;
  }
  if (userIds && userIds.length > 0) {
    const ok = new Set((await c.var.fam.members()).map((m) => m.userId));
    if (!userIds.every((id) => ok.has(id))) return false;
  }
  return true;
}

const listEvents = createRoute({
  method: "get",
  path: "/api/calendar/events",
  tags: ["calendar"],
  request: { query: RangeQuerySchema },
  responses: {
    200: jsonContent(z.array(CalendarEventSchema), "Events in [from, to)"),
    400: jsonContent(ErrorSchema, "Invalid range"),
  },
});

const createEvent = createRoute({
  method: "post",
  path: "/api/calendar/events",
  tags: ["calendar"],
  request: {
    body: {
      content: { "application/json": { schema: CreateCalendarEventSchema } },
    },
  },
  responses: {
    201: jsonContent(CalendarEventSchema, "Created"),
    400: jsonContent(ErrorSchema, "Invalid baby or assignee reference"),
    402: jsonContent(ErrorSchema, "Premium required"),
  },
});

const updateEvent = createRoute({
  method: "patch",
  path: "/api/calendar/events/{id}",
  tags: ["calendar"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: UpdateCalendarEventSchema } },
    },
  },
  responses: {
    200: jsonContent(CalendarEventSchema, "Updated"),
    400: jsonContent(ErrorSchema, "Invalid baby or assignee reference"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

const deleteEvent = createRoute({
  method: "delete",
  path: "/api/calendar/events/{id}",
  tags: ["calendar"],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: jsonContent(z.object({ ok: z.literal(true) }), "Deleted"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

export const calendarApp = createApp<FamEnv>()
  .openapi(listEvents, async (c) => {
    const q = c.req.valid("query");
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (to <= from || to.getTime() - from.getTime() > MAX_RANGE_MS) {
      return c.json({ error: "Invalid range", code: "INVALID_RANGE" }, 400);
    }
    const events = await c.var.fam.listCalendarEvents(from, to);
    return c.json(events.map(serCalendarEvent), 200);
  })
  .openapi(createEvent, async (c) => {
    // Soft-lock: only creation is premium (DECISIONS.md 2026-08-25).
    if (!canUse({ plan: c.var.plan }, "calendar")) {
      return c.json({ error: "Premium required", code: "PLAN_REQUIRED" }, 402);
    }
    const body = c.req.valid("json");
    if (!(await refsValid(c, body.babyIds, body.assigneeUserIds))) {
      return c.json(
        { error: "Unknown baby or member", code: "INVALID_REFERENCE" },
        400,
      );
    }
    // Dedupe: the pair-PK insert (event_id, baby_id | user_id) violates and
    // the D1 batch throws on a duplicate id — an API-key caller can send one.
    const created = await c.var.fam.createCalendarEvent({
      createdBy: c.var.sessionData.user.id,
      title: body.title,
      description: body.description ?? null,
      location: body.location ?? null,
      category: body.category,
      startTime: new Date(body.startTime),
      allDay: body.allDay,
      durationMin: body.durationMin ?? null,
      remindMinutesBefore: body.remindMinutesBefore ?? null,
      babyIds: [...new Set(body.babyIds)],
      assigneeUserIds: [...new Set(body.assigneeUserIds)],
    });
    return c.json(serCalendarEvent(created!), 201);
  })
  .openapi(updateEvent, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const existing = await c.var.fam.getCalendarEvent(id);
    if (!existing) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    if (!(await refsValid(c, body.babyIds, body.assigneeUserIds))) {
      return c.json(
        { error: "Unknown baby or member", code: "INVALID_REFERENCE" },
        400,
      );
    }
    // Dedupe: same pair-PK hazard as create.
    const babyIds = body.babyIds && [...new Set(body.babyIds)];
    const assigneeUserIds = body.assigneeUserIds && [
      ...new Set(body.assigneeUserIds),
    ];
    const rearm =
      body.startTime !== undefined || body.remindMinutesBefore !== undefined;
    // The invariant (allDay => durationMin null) must hold against the
    // RESULTING state, not just an incoming allDay:true — an event already
    // all-day must reject/clear a duration even when this PATCH never
    // mentions allDay.
    const effectiveAllDay = body.allDay ?? existing.allDay;
    const updated = await c.var.fam.updateCalendarEvent(
      id,
      {
        title: body.title,
        description: body.description,
        location: body.location,
        category: body.category,
        startTime: body.startTime ? new Date(body.startTime) : undefined,
        allDay: body.allDay,
        // Switching to (or already being) all-day clears the duration.
        durationMin: effectiveAllDay ? null : body.durationMin,
        remindMinutesBefore: body.remindMinutesBefore,
        // Moving the event (or its reminder) re-arms the sweep latch.
        remindedAt: rearm ? null : undefined,
      },
      { babyIds, assigneeUserIds },
    );
    if (!updated) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json(serCalendarEvent(updated), 200);
  })
  .openapi(deleteEvent, async (c) => {
    const { id } = c.req.valid("param");
    const ok = await c.var.fam.deleteCalendarEvent(id);
    if (!ok) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true as const }, 200);
  });
