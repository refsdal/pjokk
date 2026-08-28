import { createRoute, z } from "@hono/zod-openapi";
import {
  CreateSleepSchema,
  ErrorSchema,
  SleepLogSchema,
  SummarySchema,
  UpdateSleepSchema,
  WakeSchema,
} from "@shared/schemas";
import type { FamEnv } from "../context";
import {
  createApp,
  isUniqueViolation,
  jsonContent,
  serDiaper,
  serFeed,
  serSleep,
} from "../lib";

const listQuery = z.object({
  babyId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const idParam = z.object({ id: z.string() });

const list = createRoute({
  method: "get",
  path: "/api/sleep",
  tags: ["sleep"],
  request: { query: listQuery },
  responses: {
    200: jsonContent(z.array(SleepLogSchema), "Sleep logs, newest first"),
  },
});

const create = createRoute({
  method: "post",
  path: "/api/sleep",
  tags: ["sleep"],
  description:
    "Create a sleep log. Omit endTime to start an active session; a baby can only have one active session at a time.",
  request: {
    body: { content: { "application/json": { schema: CreateSleepSchema } } },
  },
  responses: {
    201: jsonContent(SleepLogSchema, "Created"),
    404: jsonContent(ErrorSchema, "Unknown baby"),
    409: jsonContent(ErrorSchema, "Baby already has an active session"),
  },
});

const active = createRoute({
  method: "get",
  path: "/api/sleep/active",
  tags: ["sleep"],
  request: { query: z.object({ babyId: z.string().optional() }) },
  responses: {
    200: jsonContent(
      SleepLogSchema.nullable(),
      "The active sleep session, or null",
    ),
  },
});

const wake = createRoute({
  method: "post",
  path: "/api/sleep/{id}/wake",
  tags: ["sleep"],
  request: {
    params: idParam,
    body: {
      content: { "application/json": { schema: WakeSchema } },
      required: false,
    },
  },
  responses: {
    200: jsonContent(SleepLogSchema, "Session ended"),
    404: jsonContent(ErrorSchema, "No such active session"),
  },
});

const update = createRoute({
  method: "patch",
  path: "/api/sleep/{id}",
  tags: ["sleep"],
  request: {
    params: idParam,
    body: { content: { "application/json": { schema: UpdateSleepSchema } } },
  },
  responses: {
    200: jsonContent(SleepLogSchema, "Updated"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

const remove = createRoute({
  method: "delete",
  path: "/api/sleep/{id}",
  tags: ["sleep"],
  request: { params: idParam },
  responses: {
    200: jsonContent(z.object({ ok: z.literal(true) }), "Deleted"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

const DAY = 86_400_000;

const summary = createRoute({
  method: "get",
  path: "/api/summary",
  tags: ["summary"],
  description:
    "Everything the home screen needs in one call: last feed, last diaper, active + last sleep, and today's local-day totals.",
  request: {
    query: z.object({
      babyId: z.string(),
      // The requester's Date.getTimezoneOffset() (minutes, UTC−local). The
      // `today` block follows the caretaker's clock, not the server's.
      tz: z.coerce.number().int().min(-840).max(840).default(0),
    }),
  },
  responses: {
    200: jsonContent(SummarySchema, "Status summary for a baby"),
    404: jsonContent(ErrorSchema, "Unknown baby"),
  },
});

export const sleepApp = createApp<FamEnv>()
  .openapi(list, async (c) => {
    const q = c.req.valid("query");
    const rows = await c.var.fam.listSleeps(q);
    return c.json(rows.map(serSleep), 200);
  })
  .openapi(create, async (c) => {
    const body = c.req.valid("json");
    if (!(await c.var.fam.getBaby(body.babyId))) {
      return c.json({ error: "Unknown baby", code: "NOT_FOUND" }, 404);
    }
    if (!body.endTime) {
      const existing = await c.var.fam.activeSleep(body.babyId);
      if (existing) {
        return c.json(
          { error: "Already sleeping", code: "ALREADY_ACTIVE" },
          409,
        );
      }
    }
    let created: Awaited<ReturnType<typeof c.var.fam.createSleep>>;
    try {
      created = await c.var.fam.createSleep({
        babyId: body.babyId,
        caretakerId: c.var.sessionData.user.id,
        startTime: new Date(body.startTime),
        endTime: body.endTime ? new Date(body.endTime) : null,
        location: body.location ?? null,
        notes: body.notes ?? null,
      });
    } catch (err) {
      // The partial unique index (one active session per baby) closes the
      // race the pre-check above can't.
      if (!body.endTime && isUniqueViolation(err)) {
        return c.json(
          { error: "Already sleeping", code: "ALREADY_ACTIVE" },
          409,
        );
      }
      throw err;
    }
    return c.json(serSleep(created!), 201);
  })
  .openapi(active, async (c) => {
    const { babyId } = c.req.valid("query");
    const row = await c.var.fam.activeSleep(babyId);
    return c.json(row ? serSleep(row) : null, 200);
  })
  .openapi(wake, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const endTime = body?.endTime ? new Date(body.endTime) : new Date();
    const updated = await c.var.fam.wakeSleep(id, endTime);
    if (!updated) {
      return c.json(
        { error: "No such active session", code: "NOT_FOUND" },
        404,
      );
    }
    return c.json(serSleep(updated), 200);
  })
  .openapi(update, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const updated = await c.var.fam.updateSleep(id, {
      ...body,
      startTime: body.startTime ? new Date(body.startTime) : undefined,
      endTime:
        body.endTime === undefined
          ? undefined
          : body.endTime === null
            ? null
            : new Date(body.endTime),
    });
    if (!updated) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json(serSleep(updated), 200);
  })
  .openapi(remove, async (c) => {
    const { id } = c.req.valid("param");
    const ok = await c.var.fam.deleteSleep(id);
    if (!ok) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true as const }, 200);
  })
  .openapi(summary, async (c) => {
    const { babyId, tz } = c.req.valid("query");
    if (!(await c.var.fam.getBaby(babyId))) {
      return c.json({ error: "Unknown baby", code: "NOT_FOUND" }, 404);
    }
    const s = await c.var.fam.summary(babyId);

    const tzMs = tz * 60_000;
    const now = Date.now();
    const dayIdx = Math.floor((now - tzMs) / DAY);
    const rangeFrom = dayIdx * DAY + tzMs;
    const rangeTo = (dayIdx + 1) * DAY + tzMs;

    const [feeds, diapers, sleeps] = await Promise.all([
      c.var.fam.feedsInRange(babyId, new Date(rangeFrom), new Date(rangeTo)),
      c.var.fam.diapersInRange(babyId, new Date(rangeFrom), new Date(rangeTo)),
      c.var.fam.sleepsInRange(babyId, new Date(rangeFrom), new Date(rangeTo)),
    ]);

    const today = {
      feeds: 0,
      intakeMl: 0,
      solidsG: 0,
      wet: 0,
      dirty: 0,
      both: 0,
      sleepMin: 0,
    };
    for (const f of feeds) {
      today.feeds += 1;
      if (f.type === "bottle") today.intakeMl += f.amountMl ?? 0;
      if (f.type === "solids") today.solidsG += f.amountMl ?? 0;
    }
    for (const d of diapers) {
      if (d.type === "wet") today.wet += 1;
      else if (d.type === "dirty") today.dirty += 1;
      else today.both += 1;
    }
    // Sleep minutes inside today's window; active sessions count up to now.
    for (const sl of sleeps) {
      const from = Math.max(sl.startTime.getTime(), rangeFrom);
      const to = Math.min(sl.endTime?.getTime() ?? now, rangeTo, now);
      if (to > from) today.sleepMin += Math.round((to - from) / 60_000);
    }

    return c.json(
      {
        lastFeed: s.lastFeed ? serFeed(s.lastFeed) : null,
        lastDiaper: s.lastDiaper ? serDiaper(s.lastDiaper) : null,
        activeSleep: s.activeSleep ? serSleep(s.activeSleep) : null,
        lastSleep: s.lastSleep ? serSleep(s.lastSleep) : null,
        activePlay: s.activePlay ? serSleep(s.activePlay) : null,
        today,
      },
      200,
    );
  });
