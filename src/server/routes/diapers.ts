import { createRoute, z } from "@hono/zod-openapi";
import {
  CreateDiaperSchema,
  DiaperLogSchema,
  ErrorSchema,
  UpdateDiaperSchema,
} from "@shared/schemas";
import type { FamEnv } from "../context";
import { createApp, jsonContent, serDiaper } from "../lib";

const listQuery = z.object({
  babyId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const idParam = z.object({ id: z.string() });

const list = createRoute({
  method: "get",
  path: "/api/diapers",
  tags: ["diapers"],
  request: { query: listQuery },
  responses: {
    200: jsonContent(z.array(DiaperLogSchema), "Diaper logs, newest first"),
  },
});

const create = createRoute({
  method: "post",
  path: "/api/diapers",
  tags: ["diapers"],
  request: {
    body: { content: { "application/json": { schema: CreateDiaperSchema } } },
  },
  responses: {
    201: jsonContent(DiaperLogSchema, "Created"),
    404: jsonContent(ErrorSchema, "Unknown baby"),
  },
});

const update = createRoute({
  method: "patch",
  path: "/api/diapers/{id}",
  tags: ["diapers"],
  request: {
    params: idParam,
    body: { content: { "application/json": { schema: UpdateDiaperSchema } } },
  },
  responses: {
    200: jsonContent(DiaperLogSchema, "Updated"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

const remove = createRoute({
  method: "delete",
  path: "/api/diapers/{id}",
  tags: ["diapers"],
  request: { params: idParam },
  responses: {
    200: jsonContent(z.object({ ok: z.literal(true) }), "Deleted"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

export const diapersApp = createApp<FamEnv>()
  .openapi(list, async (c) => {
    const q = c.req.valid("query");
    const rows = await c.var.fam.listDiapers(q);
    return c.json(rows.map(serDiaper), 200);
  })
  .openapi(create, async (c) => {
    const body = c.req.valid("json");
    if (!(await c.var.fam.getBaby(body.babyId))) {
      return c.json({ error: "Unknown baby", code: "NOT_FOUND" }, 404);
    }
    const created = await c.var.fam.createDiaper({
      ...body,
      time: new Date(body.time),
      caretakerId: c.var.sessionData.user.id,
    });
    return c.json(serDiaper(created!), 201);
  })
  .openapi(update, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const updated = await c.var.fam.updateDiaper(id, {
      ...body,
      time: body.time ? new Date(body.time) : undefined,
    });
    if (!updated) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json(serDiaper(updated), 200);
  })
  .openapi(remove, async (c) => {
    const { id } = c.req.valid("param");
    const ok = await c.var.fam.deleteDiaper(id);
    if (!ok) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true as const }, 200);
  });
