import { createRoute, z } from "@hono/zod-openapi";
import {
  BabySchema,
  CreateBabySchema,
  ErrorSchema,
  MemberSchema,
  FamilySchema,
  UpdateBabySchema,
} from "@shared/schemas";
import type { FamEnv } from "../context";
import { createApp, jsonContent, serBaby } from "../lib";

const listBabies = createRoute({
  method: "get",
  path: "/api/babies",
  tags: ["babies"],
  responses: {
    200: jsonContent(z.array(BabySchema), "Babies in the active family"),
  },
});

const createBaby = createRoute({
  method: "post",
  path: "/api/babies",
  tags: ["babies"],
  request: {
    body: { content: { "application/json": { schema: CreateBabySchema } } },
  },
  responses: {
    201: jsonContent(BabySchema, "Created"),
  },
});

const updateBaby = createRoute({
  method: "patch",
  path: "/api/babies/{id}",
  tags: ["babies"],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: UpdateBabySchema } } },
  },
  responses: {
    200: jsonContent(BabySchema, "Updated"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

const listMembers = createRoute({
  method: "get",
  path: "/api/family/members",
  tags: ["family"],
  responses: {
    200: jsonContent(z.array(MemberSchema), "Caretakers in the family"),
  },
});

const getFamily = createRoute({
  method: "get",
  path: "/api/family",
  tags: ["family"],
  responses: {
    200: jsonContent(FamilySchema, "The active family"),
    404: jsonContent(ErrorSchema, "Family missing"),
  },
});

export const babiesApp = createApp<FamEnv>()
  .openapi(listBabies, async (c) => {
    const babies = await c.var.fam.listBabies();
    return c.json(babies.map(serBaby), 200);
  })
  .openapi(createBaby, async (c) => {
    const body = c.req.valid("json");
    const created = await c.var.fam.createBaby({
      name: body.name,
      birthDate: new Date(body.birthDate),
      sex: body.sex ?? null,
    });
    return c.json(serBaby(created), 201);
  })
  .openapi(updateBaby, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const updated = await c.var.fam.updateBaby(id, {
      ...body,
      birthDate: body.birthDate ? new Date(body.birthDate) : undefined,
    });
    if (!updated) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json(serBaby(updated), 200);
  })
  .openapi(listMembers, async (c) => {
    return c.json(await c.var.fam.members(), 200);
  })
  .openapi(getFamily, async (c) => {
    const family = await c.var.fam.family();
    if (!family) {
      return c.json({ error: "Family not found", code: "NOT_FOUND" }, 404);
    }
    return c.json(family, 200);
  });
