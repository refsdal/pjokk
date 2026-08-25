import { createRoute, z } from "@hono/zod-openapi";
import {
  BathLogSchema,
  CreateBathSchema,
  CreateMeasurementSchema,
  CreateMedicineSchema,
  CreateMilestoneSchema,
  CreateNoteSchema,
  CreatePumpSchema,
  ErrorSchema,
  MeasurementLogSchema,
  MedicineLogSchema,
  MilestoneLogSchema,
  NoteLogSchema,
  PumpLogSchema,
  UpdateBathSchema,
  UpdateMeasurementSchema,
  UpdateMedicineSchema,
  UpdateMilestoneSchema,
  UpdateNoteSchema,
  UpdatePumpSchema,
} from "@shared/schemas";
import type { FamEnv } from "../context";
import type { FamilyScope } from "../db/scoped";
import type { LogCrud } from "../db/scoped";
import { createApp, jsonContent } from "../lib";

// The Phase 1 CRUD-route pattern, built once and instantiated per activity
// type. Every handler is family-scoped through the generic LogCrud and
// validates the baby before writing.

const listQuery = z.object({
  babyId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const idParam = z.object({ id: z.string() });

function makeLogRoutes<
  Base extends string,
  Row extends { time: Date },
  Insert,
  TLog extends z.ZodType,
  TCreate extends z.ZodType<{ babyId: string; time: string }>,
  TUpdate extends z.ZodType<{ time?: string }>,
>(cfg: {
  base: Base;
  logSchema: TLog;
  createSchema: TCreate;
  updateSchema: TUpdate;
  crud: (fam: FamilyScope) => LogCrud<Row, Insert>;
  toApi: (row: Row) => z.output<TLog>;
}) {
  const collection = `/api/${cfg.base}` as `/api/${Base}`;
  const item = `/api/${cfg.base}/{id}` as `/api/${Base}/{id}`;

  const list = createRoute({
    method: "get",
    path: collection,
    tags: [cfg.base],
    request: { query: listQuery },
    responses: {
      200: jsonContent(z.array(cfg.logSchema), "Logs, newest first"),
    },
  });

  const create = createRoute({
    method: "post",
    path: collection,
    tags: [cfg.base],
    request: {
      body: { content: { "application/json": { schema: cfg.createSchema } } },
    },
    responses: {
      201: jsonContent(cfg.logSchema, "Created"),
      404: jsonContent(ErrorSchema, "Unknown baby"),
    },
  });

  const update = createRoute({
    method: "patch",
    path: item,
    tags: [cfg.base],
    request: {
      params: idParam,
      body: { content: { "application/json": { schema: cfg.updateSchema } } },
    },
    responses: {
      200: jsonContent(cfg.logSchema, "Updated"),
      404: jsonContent(ErrorSchema, "Not found"),
    },
  });

  const remove = createRoute({
    method: "delete",
    path: item,
    tags: [cfg.base],
    request: { params: idParam },
    responses: {
      200: jsonContent(z.object({ ok: z.literal(true) }), "Deleted"),
      404: jsonContent(ErrorSchema, "Not found"),
    },
  });

  // The route definitions above are concretely typed per instantiation, so
  // both runtime validation and the RPC client see exact schemas. Inside the
  // generic factory, zod-openapi's input inference can't follow the type
  // parameters — the handler bodies therefore run through a loose Context and
  // are cast at registration. Runtime behavior is still fully validated.
  type LooseCtx = {
    req: { valid: (target: string) => never };
    var: FamEnv["Variables"];
    json: (body: unknown, status: number) => Response;
  };

  const listHandler = async (c: LooseCtx) => {
    const q = c.req.valid("query") as ListQueryT;
    const rows = await cfg.crud(c.var.fam).list(q);
    return c.json(rows.map(cfg.toApi), 200);
  };

  const createHandler = async (c: LooseCtx) => {
    const body = c.req.valid("json") as {
      babyId: string;
      time: string;
    } & Insert;
    if (!(await c.var.fam.getBaby(body.babyId))) {
      return c.json({ error: "Unknown baby", code: "NOT_FOUND" }, 404);
    }
    const { babyId, time, ...rest } = body;
    const created = await cfg.crud(c.var.fam).create({
      ...(rest as unknown as Insert),
      babyId,
      time: new Date(time),
      caretakerId: c.var.sessionData.user.id,
    });
    return c.json(cfg.toApi(created!), 201);
  };

  const updateHandler = async (c: LooseCtx) => {
    const { id } = c.req.valid("param") as { id: string };
    const body = c.req.valid("json") as { time?: string } & Partial<Insert>;
    const { time, ...rest } = body;
    const updated = await cfg.crud(c.var.fam).update(id, {
      ...(rest as Partial<Insert>),
      ...(time ? { time: new Date(time) } : {}),
    });
    if (!updated) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json(cfg.toApi(updated), 200);
  };

  const removeHandler = async (c: LooseCtx) => {
    const { id } = c.req.valid("param") as { id: string };
    const ok = await cfg.crud(c.var.fam).del(id);
    if (!ok) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true as const }, 200);
  };

  return createApp<FamEnv>()
    .openapi(list, listHandler as never)
    .openapi(create, createHandler as never)
    .openapi(update, updateHandler as never)
    .openapi(remove, removeHandler as never);
}

type ListQueryT = z.infer<typeof listQuery>;

const iso = (d: Date) => d.toISOString();

export const otherLogsApp = createApp<FamEnv>()
  .route(
    "/",
    makeLogRoutes({
      base: "medicine",
      logSchema: MedicineLogSchema,
      createSchema: CreateMedicineSchema,
      updateSchema: UpdateMedicineSchema,
      crud: (fam) => fam.medicine,
      toApi: (row) => ({ ...row, time: iso(row.time) }),
    }),
  )
  .route(
    "/",
    makeLogRoutes({
      base: "baths",
      logSchema: BathLogSchema,
      createSchema: CreateBathSchema,
      updateSchema: UpdateBathSchema,
      crud: (fam) => fam.bath,
      toApi: (row) => ({ ...row, time: iso(row.time) }),
    }),
  )
  .route(
    "/",
    makeLogRoutes({
      base: "notes",
      logSchema: NoteLogSchema,
      createSchema: CreateNoteSchema,
      updateSchema: UpdateNoteSchema,
      crud: (fam) => fam.note,
      toApi: (row) => ({ ...row, time: iso(row.time) }),
    }),
  )
  .route(
    "/",
    makeLogRoutes({
      base: "milestones",
      logSchema: MilestoneLogSchema,
      createSchema: CreateMilestoneSchema,
      updateSchema: UpdateMilestoneSchema,
      crud: (fam) => fam.milestone,
      toApi: (row) => ({ ...row, time: iso(row.time) }),
    }),
  )
  .route(
    "/",
    makeLogRoutes({
      base: "measurements",
      logSchema: MeasurementLogSchema,
      createSchema: CreateMeasurementSchema,
      updateSchema: UpdateMeasurementSchema,
      crud: (fam) => fam.measurement,
      toApi: (row) => ({ ...row, time: iso(row.time) }),
    }),
  )
  .route(
    "/",
    makeLogRoutes({
      base: "pumps",
      logSchema: PumpLogSchema,
      createSchema: CreatePumpSchema,
      updateSchema: UpdatePumpSchema,
      crud: (fam) => fam.pump,
      toApi: (row) => ({ ...row, time: iso(row.time) }),
    }),
  );
