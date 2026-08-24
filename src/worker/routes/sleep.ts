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

const summary = createRoute({
  method: "get",
  path: "/api/summary",
  tags: ["summary"],
  description:
    "Everything the home screen needs in one call: last feed, last diaper, active + last sleep.",
  request: { query: z.object({ babyId: z.string() }) },
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
    const created = await c.var.fam.createSleep({
      babyId: body.babyId,
      caretakerId: c.var.sessionData.user.id,
      startTime: new Date(body.startTime),
      endTime: body.endTime ? new Date(body.endTime) : null,
      location: body.location ?? null,
      notes: body.notes ?? null,
    });
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
    const { babyId } = c.req.valid("query");
    if (!(await c.var.fam.getBaby(babyId))) {
      return c.json({ error: "Unknown baby", code: "NOT_FOUND" }, 404);
    }
    const s = await c.var.fam.summary(babyId);
    return c.json(
      {
        lastFeed: s.lastFeed ? serFeed(s.lastFeed) : null,
        lastDiaper: s.lastDiaper ? serDiaper(s.lastDiaper) : null,
        activeSleep: s.activeSleep ? serSleep(s.activeSleep) : null,
        lastSleep: s.lastSleep ? serSleep(s.lastSleep) : null,
      },
      200,
    );
  });
