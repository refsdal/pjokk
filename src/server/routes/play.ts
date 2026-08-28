import { createRoute, z } from "@hono/zod-openapi";
import {
  CreatePlaySchema,
  ErrorSchema,
  PlayLogSchema,
  StopPlaySchema,
  UpdatePlaySchema,
} from "@shared/schemas";
import type { FamEnv } from "../context";
import { canUse } from "../entitlements";
import { createApp, isUniqueViolation, jsonContent, serSleep } from "../lib";

// Play sessions serialize exactly like sleep (startTime + nullable endTime).
const serPlay = serSleep;

const listQuery = z.object({
  babyId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const idParam = z.object({ id: z.string() });

const list = createRoute({
  method: "get",
  path: "/api/play",
  tags: ["play"],
  request: { query: listQuery },
  responses: {
    200: jsonContent(z.array(PlayLogSchema), "Play logs, newest first"),
  },
});

const create = createRoute({
  method: "post",
  path: "/api/play",
  tags: ["play"],
  description:
    "Create a play log. Omit endTime to start a running timer; a baby can only have one running activity at a time.",
  request: {
    body: { content: { "application/json": { schema: CreatePlaySchema } } },
  },
  responses: {
    201: jsonContent(PlayLogSchema, "Created"),
    402: jsonContent(ErrorSchema, "Premium required"),
    404: jsonContent(ErrorSchema, "Unknown baby"),
    409: jsonContent(ErrorSchema, "Baby already has a running activity"),
  },
});

const active = createRoute({
  method: "get",
  path: "/api/play/active",
  tags: ["play"],
  request: { query: z.object({ babyId: z.string().optional() }) },
  responses: {
    200: jsonContent(
      PlayLogSchema.nullable(),
      "The running play session, or null",
    ),
  },
});

const stop = createRoute({
  method: "post",
  path: "/api/play/{id}/stop",
  tags: ["play"],
  request: {
    params: idParam,
    body: {
      content: { "application/json": { schema: StopPlaySchema } },
      required: false,
    },
  },
  responses: {
    200: jsonContent(PlayLogSchema, "Session ended"),
    404: jsonContent(ErrorSchema, "No such running session"),
  },
});

const update = createRoute({
  method: "patch",
  path: "/api/play/{id}",
  tags: ["play"],
  request: {
    params: idParam,
    body: { content: { "application/json": { schema: UpdatePlaySchema } } },
  },
  responses: {
    200: jsonContent(PlayLogSchema, "Updated"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

const remove = createRoute({
  method: "delete",
  path: "/api/play/{id}",
  tags: ["play"],
  request: { params: idParam },
  responses: {
    200: jsonContent(z.object({ ok: z.literal(true) }), "Deleted"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

export const playApp = createApp<FamEnv>()
  .openapi(list, async (c) => {
    const q = c.req.valid("query");
    const rows = await c.var.fam.listPlays(q);
    return c.json(rows.map(serPlay), 200);
  })
  .openapi(active, async (c) => {
    const { babyId } = c.req.valid("query");
    const row = await c.var.fam.activePlay(babyId);
    return c.json(row ? serPlay(row) : null, 200);
  })
  .openapi(create, async (c) => {
    // Soft-lock: creation is premium; stopping, editing and deleting stay
    // open so a downgrade can never strand a running timer.
    if (!canUse({ plan: c.var.plan }, "play")) {
      return c.json({ error: "Premium required", code: "PLAN_REQUIRED" }, 402);
    }
    const body = c.req.valid("json");
    if (!(await c.var.fam.getBaby(body.babyId))) {
      return c.json({ error: "Unknown baby", code: "NOT_FOUND" }, 404);
    }
    if (!body.endTime) {
      const existing = await c.var.fam.activePlay(body.babyId);
      if (existing) {
        return c.json({ error: "Already active", code: "ALREADY_ACTIVE" }, 409);
      }
    }
    let created: Awaited<ReturnType<typeof c.var.fam.createPlay>>;
    try {
      created = await c.var.fam.createPlay({
        babyId: body.babyId,
        caretakerId: c.var.sessionData.user.id,
        type: body.type,
        startTime: new Date(body.startTime),
        endTime: body.endTime ? new Date(body.endTime) : null,
        notes: body.notes ?? null,
      });
    } catch (err) {
      // play_one_active_per_baby closes the race the pre-check can't.
      if (!body.endTime && isUniqueViolation(err)) {
        return c.json({ error: "Already active", code: "ALREADY_ACTIVE" }, 409);
      }
      throw err;
    }
    return c.json(serPlay(created!), 201);
  })
  .openapi(stop, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const endTime = body?.endTime ? new Date(body.endTime) : new Date();
    const updated = await c.var.fam.stopPlay(id, endTime);
    if (!updated) {
      return c.json(
        { error: "No such running session", code: "NOT_FOUND" },
        404,
      );
    }
    return c.json(serPlay(updated), 200);
  })
  .openapi(update, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const updated = await c.var.fam.updatePlay(id, {
      type: body.type,
      startTime: body.startTime ? new Date(body.startTime) : undefined,
      endTime:
        body.endTime === undefined
          ? undefined
          : body.endTime === null
            ? null
            : new Date(body.endTime),
      notes: body.notes,
    });
    if (!updated) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json(serPlay(updated), 200);
  })
  .openapi(remove, async (c) => {
    const { id } = c.req.valid("param");
    const ok = await c.var.fam.deletePlay(id);
    if (!ok) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true as const }, 200);
  });
