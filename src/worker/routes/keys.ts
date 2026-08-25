import { createRoute, z } from "@hono/zod-openapi";
import {
  ApiKeyCreatedSchema,
  ApiKeySchema,
  CreateApiKeySchema,
  ErrorSchema,
} from "@shared/schemas";
import type { FamEnv } from "../context";
import type { schema } from "../db";
import { createApp, iso, isoOrNull, jsonContent } from "../lib";

function serKey(row: typeof schema.apiKey.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: iso(row.createdAt),
    lastUsedAt: isoOrNull(row.lastUsedAt),
    revokedAt: isoOrNull(row.revokedAt),
    expiresAt: isoOrNull(row.expiresAt),
    readOnly: row.readOnly,
  };
}

const createKey = createRoute({
  method: "post",
  path: "/api/keys",
  tags: ["api-keys"],
  description:
    "Create a bearer API key for integrations (Home Assistant, Grafana). The full key is returned ONCE and never again. Use it as `Authorization: Bearer pjk_…`.",
  request: {
    body: { content: { "application/json": { schema: CreateApiKeySchema } } },
  },
  responses: {
    201: jsonContent(ApiKeyCreatedSchema, "Created — copy the key now"),
  },
});

const listKeys = createRoute({
  method: "get",
  path: "/api/keys",
  tags: ["api-keys"],
  responses: {
    200: jsonContent(z.array(ApiKeySchema), "Keys for the family"),
  },
});

const revokeKey = createRoute({
  method: "delete",
  path: "/api/keys/{id}",
  tags: ["api-keys"],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: jsonContent(z.object({ ok: z.literal(true) }), "Revoked"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

export const keysApp = createApp<FamEnv>()
  .openapi(createKey, async (c) => {
    const body = c.req.valid("json");
    const { row, key } = await c.var.fam.createApiKey({
      name: body.name,
      createdBy: c.var.sessionData.user.id,
      expiresAt: body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 24 * 3600_000)
        : null,
      readOnly: body.readOnly,
    });
    return c.json({ ...serKey(row), key }, 201);
  })
  .openapi(listKeys, async (c) => {
    const keys = await c.var.fam.listApiKeys();
    return c.json(keys.map(serKey), 200);
  })
  .openapi(revokeKey, async (c) => {
    const { id } = c.req.valid("param");
    const ok = await c.var.fam.revokeApiKey(id);
    if (!ok) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true as const }, 200);
  });
