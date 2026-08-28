import { createRoute, z } from "@hono/zod-openapi";
import {
  CreateVaccineDismissalSchema,
  CreateVaccineSchema,
  ErrorSchema,
  UpdateVaccineSchema,
  VaccineDismissalSchema,
  VaccineLogSchema,
} from "@pjokk/shared";
import type { FamEnv } from "../context";
import type { VaccineRow } from "../db/scoped";
import { canUse } from "../entitlements";
import { createApp, iso, jsonContent } from "../lib";

// What a phone camera and a helsestasjon card actually produce. Anything
// else is refused outright rather than stored and served back later.
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_DOCS_PER_ENTRY = 5;

const serVaccine = (row: VaccineRow) => ({
  ...row,
  time: iso(row.time),
  documents: row.documents.map((d) => ({
    ...d,
    url: `/api/files/${d.id}`,
  })),
});

const listQuery = z.object({
  babyId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const idParam = z.object({ id: z.string() });

const list = createRoute({
  method: "get",
  path: "/api/vaccines",
  tags: ["vaccines"],
  request: { query: listQuery },
  responses: {
    200: jsonContent(z.array(VaccineLogSchema), "Vaccines, newest first"),
  },
});

const create = createRoute({
  method: "post",
  path: "/api/vaccines",
  tags: ["vaccines"],
  request: {
    body: { content: { "application/json": { schema: CreateVaccineSchema } } },
  },
  responses: {
    201: jsonContent(VaccineLogSchema, "Created"),
    404: jsonContent(ErrorSchema, "Unknown baby"),
  },
});

const update = createRoute({
  method: "patch",
  path: "/api/vaccines/{id}",
  tags: ["vaccines"],
  request: {
    params: idParam,
    body: { content: { "application/json": { schema: UpdateVaccineSchema } } },
  },
  responses: {
    200: jsonContent(VaccineLogSchema, "Updated"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

const remove = createRoute({
  method: "delete",
  path: "/api/vaccines/{id}",
  tags: ["vaccines"],
  description: "Deletes the entry and every document attached to it.",
  request: { params: idParam },
  responses: {
    200: jsonContent(z.object({ ok: z.literal(true) }), "Deleted"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

// Dismissals are free, like the log: waving away a suggestion the app
// itself made is data hygiene, not a feature.
const listDismissals = createRoute({
  method: "get",
  path: "/api/vaccines/dismissals",
  tags: ["vaccines"],
  request: { query: z.object({ babyId: z.string().optional() }) },
  responses: {
    200: jsonContent(
      z.array(VaccineDismissalSchema),
      "Dismissed programme slots",
    ),
  },
});

const createDismissal = createRoute({
  method: "post",
  path: "/api/vaccines/dismissals",
  tags: ["vaccines"],
  description:
    "Hide a programme slot for one baby. Idempotent: dismissing twice returns the existing row.",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateVaccineDismissalSchema },
      },
    },
  },
  responses: {
    201: jsonContent(VaccineDismissalSchema, "Dismissed"),
    404: jsonContent(ErrorSchema, "Unknown baby"),
  },
});

const deleteDismissal = createRoute({
  method: "delete",
  path: "/api/vaccines/dismissals/{id}",
  tags: ["vaccines"],
  description: "Restore a dismissed slot.",
  request: { params: idParam },
  responses: {
    200: jsonContent(z.object({ ok: z.literal(true) }), "Restored"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

export const vaccinesApp = createApp<FamEnv>()
  // Registered before /api/vaccines/{id} so "dismissals" is never captured
  // as an id.
  .openapi(listDismissals, async (c) => {
    const { babyId } = c.req.valid("query");
    return c.json(await c.var.fam.listVaccineDismissals(babyId), 200);
  })
  .openapi(createDismissal, async (c) => {
    const body = c.req.valid("json");
    if (!(await c.var.fam.getBaby(body.babyId))) {
      return c.json({ error: "Unknown baby", code: "NOT_FOUND" }, 404);
    }
    const created = await c.var.fam.createVaccineDismissal({
      babyId: body.babyId,
      slotKey: body.slotKey,
      dismissedBy: c.var.sessionData.user.id,
    });
    return c.json(created!, 201);
  })
  .openapi(deleteDismissal, async (c) => {
    const { id } = c.req.valid("param");
    if (!(await c.var.fam.deleteVaccineDismissal(id))) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true as const }, 200);
  })
  .openapi(list, async (c) => {
    const q = c.req.valid("query");
    const rows = await c.var.fam.listVaccines(q);
    return c.json(rows.map(serVaccine), 200);
  })
  .openapi(create, async (c) => {
    // Free: the log itself is never gated. Only attaching documents is,
    // because only documents cost storage.
    const body = c.req.valid("json");
    if (!(await c.var.fam.getBaby(body.babyId))) {
      return c.json({ error: "Unknown baby", code: "NOT_FOUND" }, 404);
    }
    const created = await c.var.fam.createVaccine({
      babyId: body.babyId,
      caretakerId: c.var.sessionData.user.id,
      time: new Date(body.time),
      name: body.name,
      doseNumber: body.doseNumber ?? null,
      scheduleSlot: body.scheduleSlot ?? null,
      notes: body.notes ?? null,
    });
    return c.json(serVaccine(created!), 201);
  })
  .openapi(update, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const updated = await c.var.fam.updateVaccine(id, {
      time: body.time ? new Date(body.time) : undefined,
      name: body.name,
      doseNumber: body.doseNumber,
      scheduleSlot: body.scheduleSlot,
      notes: body.notes,
    });
    if (!updated) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json(serVaccine(updated), 200);
  })
  .openapi(remove, async (c) => {
    const { id } = c.req.valid("param");
    const { deleted, objectKeys } = await c.var.fam.deleteVaccine(id);
    if (!deleted) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    // The DB rows cascade; the R2 objects behind them do not. Deleting after
    // the row is gone means a failure here leaks an orphan object rather
    // than leaving a document row pointing at nothing.
    if (objectKeys.length > 0) {
      await c.var.storage.delete(objectKeys);
    }
    return c.json({ ok: true as const }, 200);
  });

// --- Documents: multipart in, streamed back out. Kept off the OpenAPI
// route tree (zod-openapi models JSON bodies; these are file transfers) but
// still behind the same family-scoped middleware. ---

// Uploads are OFF. A photographed helsestasjon card can carry a
// fødselsnummer, and Norwegian law treats that specially — we are not
// taking that on until the privacy work around it is finished and reviewed.
// Reading and deleting stay open on purpose so anything already stored can
// still be retrieved and erased. Flip this back on deliberately, not by
// accident: see DECISIONS.md.
const DOCUMENT_UPLOADS_ENABLED = false;

export const filesApp = createApp<FamEnv>()
  .post("/api/vaccines/:id/documents", async (c) => {
    if (!DOCUMENT_UPLOADS_ENABLED) {
      return c.json(
        { error: "Attachments are disabled", code: "FEATURE_DISABLED" },
        403,
      );
    }
    if (!canUse({ plan: c.var.plan }, "vaccineDocuments")) {
      return c.json({ error: "Premium required", code: "PLAN_REQUIRED" }, 402);
    }
    const id = c.req.param("id");
    const entry = await c.var.fam.getVaccine(id);
    if (!entry) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    if ((await c.var.fam.countVaccineDocuments(id)) >= MAX_DOCS_PER_ENTRY) {
      return c.json(
        {
          error: `At most ${MAX_DOCS_PER_ENTRY} files per entry`,
          code: "TOO_MANY",
        },
        400,
      );
    }

    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "No file", code: "NO_FILE" }, 400);
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return c.json({ error: "Images and PDFs only", code: "BAD_TYPE" }, 415);
    }
    if (file.size === 0 || file.size > MAX_BYTES) {
      return c.json({ error: "File too large", code: "TOO_LARGE" }, 413);
    }

    // The key is server-generated: a filename from the client never reaches
    // the object store.
    const objectKey = `vaccine-docs/${c.var.familyId}/${crypto.randomUUID()}`;
    // The File itself, NOT file.stream(): Bun's S3 client does not accept a
    // ReadableStream and does not reject one either — it writes the string
    // "[object ReadableStream]" and reports success, which would corrupt
    // every upload silently. A File is a Blob, so this streams just as well.
    await c.var.storage.put(objectKey, file, file.type);
    const docId = await c.var.fam.createVaccineDocument({
      vaccineLogId: id,
      objectKey,
      // Only ever shown as text, never used as a path.
      filename: file.name.slice(0, 200) || "document",
      contentType: file.type,
      size: file.size,
      uploadedBy: c.var.sessionData.user.id,
    });
    return c.json(
      {
        id: docId,
        filename: file.name,
        contentType: file.type,
        size: file.size,
        url: `/api/files/${docId}`,
      },
      201,
    );
  })
  .get("/api/files/:id", async (c) => {
    const doc = await c.var.fam.getVaccineDocument(c.req.param("id"));
    if (!doc) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    const body = await c.var.storage.getStream(doc.objectKey);
    if (!body) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return new Response(body, {
      headers: {
        "content-type": doc.contentType,
        "content-length": String(doc.size),
        // Never inline: an uploaded file is untrusted content and must not
        // execute in the app's origin.
        "content-disposition": `attachment; filename="${doc.filename.replaceAll('"', "")}"`,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  })
  .delete("/api/files/:id", async (c) => {
    // Never gated: a downgraded family must still be able to delete files.
    const objectKey = await c.var.fam.deleteVaccineDocument(c.req.param("id"));
    if (!objectKey) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    await c.var.storage.delete(objectKey);
    return c.json({ ok: true as const }, 200);
  });
