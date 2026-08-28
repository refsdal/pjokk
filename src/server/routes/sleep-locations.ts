import { createRoute, z } from "@hono/zod-openapi";
import { ErrorSchema, SleepLocationSchema } from "@shared/schemas";
import type { Context } from "hono";
import type { FamEnv } from "../context";
import { createApp, jsonContent } from "../lib";

// Fixed defaults every family gets for free (see SleepSheet chips) — custom
// names may not collide with these, case-insensitively.
const DEFAULT_LOCATIONS = ["crib", "stroller", "arms", "contact nap"];
const MAX_CUSTOM_LOCATIONS = 20;

const forbid = (c: Context) =>
  c.json({ error: "Admin only", code: "FORBIDDEN" }, 403 as const);

const CreateSleepLocationSchema = z
  .object({ name: z.string().trim().min(1).max(40) })
  .openapi("CreateSleepLocation");

const listLocations = createRoute({
  method: "get",
  path: "/api/sleep-locations",
  tags: ["sleep-locations"],
  responses: {
    200: jsonContent(
      z.array(SleepLocationSchema),
      "Custom sleep locations for the family",
    ),
  },
});

const createLocation = createRoute({
  method: "post",
  path: "/api/sleep-locations",
  tags: ["sleep-locations"],
  request: {
    body: {
      content: { "application/json": { schema: CreateSleepLocationSchema } },
    },
  },
  responses: {
    201: jsonContent(SleepLocationSchema, "Created"),
    403: jsonContent(ErrorSchema, "Admin only"),
    409: jsonContent(ErrorSchema, "Duplicate name or limit reached"),
  },
});

const deleteLocation = createRoute({
  method: "delete",
  path: "/api/sleep-locations/{id}",
  tags: ["sleep-locations"],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: jsonContent(z.object({ ok: z.literal(true) }), "Deleted"),
    403: jsonContent(ErrorSchema, "Admin only"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

export const sleepLocationsApp = createApp<FamEnv>()
  .openapi(listLocations, async (c) => {
    const locations = await c.var.fam.listSleepLocations();
    return c.json(locations, 200);
  })
  .openapi(createLocation, async (c) => {
    if (c.get("apiKeyAuth")) {
      return c.json(
        { error: "Not available to API keys", code: "FORBIDDEN" },
        403,
      );
    }
    const role = c.var.memberRole;
    if (role !== "admin" && role !== "owner") return forbid(c);

    const { name } = c.req.valid("json");
    const existing = await c.var.fam.listSleepLocations();
    const lower = name.toLowerCase();
    const isDuplicate =
      DEFAULT_LOCATIONS.includes(lower) ||
      existing.some((l) => l.name.toLowerCase() === lower);
    if (isDuplicate) {
      return c.json({ error: "Duplicate name", code: "DUPLICATE" }, 409);
    }
    if (existing.length >= MAX_CUSTOM_LOCATIONS) {
      return c.json({ error: "Limit reached", code: "LIMIT_REACHED" }, 409);
    }

    const created = await c.var.fam.createSleepLocation(name);
    return c.json(created, 201);
  })
  .openapi(deleteLocation, async (c) => {
    if (c.get("apiKeyAuth")) {
      return c.json(
        { error: "Not available to API keys", code: "FORBIDDEN" },
        403,
      );
    }
    const role = c.var.memberRole;
    if (role !== "admin" && role !== "owner") return forbid(c);

    const { id } = c.req.valid("param");
    const ok = await c.var.fam.deleteSleepLocation(id);
    if (!ok) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true as const }, 200);
  });
