import { createRoute, z } from "@hono/zod-openapi";
import {
  ContactSchema,
  CreateContactSchema,
  ErrorSchema,
  UpdateContactSchema,
} from "@shared/schemas";
import type { Context } from "hono";
import type { FamEnv } from "../context";
import { canUse } from "../entitlements";
import { createApp, jsonContent } from "../lib";

// Baby ids must belong to this family: contact_baby carries no familyId of
// its own, so this is the tenancy backstop (same as the calendar's).
async function babiesValid(
  c: Context<FamEnv>,
  babyIds: string[] | undefined,
): Promise<boolean> {
  if (!babyIds || babyIds.length === 0) return true;
  const ok = new Set((await c.var.fam.listBabies()).map((b) => b.id));
  return babyIds.every((id) => ok.has(id));
}

const idParam = z.object({ id: z.string() });

const listContacts = createRoute({
  method: "get",
  path: "/api/contacts",
  tags: ["contacts"],
  responses: {
    200: jsonContent(z.array(ContactSchema), "Contacts, by name"),
  },
});

const createContact = createRoute({
  method: "post",
  path: "/api/contacts",
  tags: ["contacts"],
  request: {
    body: { content: { "application/json": { schema: CreateContactSchema } } },
  },
  responses: {
    201: jsonContent(ContactSchema, "Created"),
    400: jsonContent(ErrorSchema, "Invalid baby reference"),
    402: jsonContent(ErrorSchema, "Premium required"),
  },
});

const updateContact = createRoute({
  method: "patch",
  path: "/api/contacts/{id}",
  tags: ["contacts"],
  request: {
    params: idParam,
    body: { content: { "application/json": { schema: UpdateContactSchema } } },
  },
  responses: {
    200: jsonContent(ContactSchema, "Updated"),
    400: jsonContent(ErrorSchema, "Invalid baby reference"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

const deleteContact = createRoute({
  method: "delete",
  path: "/api/contacts/{id}",
  tags: ["contacts"],
  request: { params: idParam },
  responses: {
    200: jsonContent(z.object({ ok: z.literal(true) }), "Deleted"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

export const contactsApp = createApp<FamEnv>()
  .openapi(listContacts, async (c) => {
    return c.json(await c.var.fam.listContacts(), 200);
  })
  .openapi(createContact, async (c) => {
    // Soft-lock: creation is premium; read/edit/delete stay open so a
    // downgraded family keeps its address book (DECISIONS.md 2026-08-25).
    if (!canUse({ plan: c.var.plan }, "contacts")) {
      return c.json({ error: "Premium required", code: "PLAN_REQUIRED" }, 402);
    }
    const body = c.req.valid("json");
    if (!(await babiesValid(c, body.babyIds))) {
      return c.json({ error: "Unknown baby", code: "INVALID_REFERENCE" }, 400);
    }
    // Dedupe: the pair-PK insert violates on a repeated id, and an API-key
    // caller can send one.
    const created = await c.var.fam.createContact({
      name: body.name,
      role: body.role ?? null,
      icon: body.icon ?? null,
      phone: body.phone ?? null,
      email: body.email ?? null,
      website: body.website ?? null,
      notes: body.notes ?? null,
      babyIds: [...new Set(body.babyIds)],
    });
    return c.json(created!, 201);
  })
  .openapi(updateContact, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    if (!(await babiesValid(c, body.babyIds))) {
      return c.json({ error: "Unknown baby", code: "INVALID_REFERENCE" }, 400);
    }
    const updated = await c.var.fam.updateContact(
      id,
      {
        name: body.name,
        role: body.role,
        icon: body.icon,
        phone: body.phone,
        email: body.email,
        website: body.website,
        notes: body.notes,
      },
      { babyIds: body.babyIds && [...new Set(body.babyIds)] },
    );
    if (!updated) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json(updated, 200);
  })
  .openapi(deleteContact, async (c) => {
    const { id } = c.req.valid("param");
    const ok = await c.var.fam.deleteContact(id);
    if (!ok) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true as const }, 200);
  });
