import { createMiddleware } from "hono/factory";
import { and, eq, isNull } from "drizzle-orm";
import type { AppEnv, SessionData } from "../context";
import { schema } from "../db";
import { sha256Hex } from "../db/scoped";

// Bearer API keys (pjk_…) authenticate as the caretaker who created the key
// (their attribution on logs), scoped to the key's family. Admin and
// device-bound endpoints refuse key auth via the apiKeyAuth flag.
export const apiKeyAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer pjk_")) {
    const hash = await sha256Hex(header.slice("Bearer ".length));
    const rows = await c.var.db
      .select({
        id: schema.apiKey.id,
        familyId: schema.apiKey.familyId,
        lastUsedAt: schema.apiKey.lastUsedAt,
        userId: schema.user.id,
        userName: schema.user.name,
        userEmail: schema.user.email,
      })
      .from(schema.apiKey)
      .innerJoin(schema.user, eq(schema.apiKey.createdBy, schema.user.id))
      .where(
        and(eq(schema.apiKey.keyHash, hash), isNull(schema.apiKey.revokedAt)),
      );
    const row = rows[0];
    if (!row) {
      return c.json({ error: "Invalid API key", code: "INVALID_KEY" }, 401);
    }
    // Synthetic session: just the fields the tenancy layer + handlers read.
    c.set("sessionData", {
      session: { activeOrganizationId: row.familyId },
      user: { id: row.userId, name: row.userName, email: row.userEmail },
    } as unknown as SessionData);
    c.set("apiKeyAuth", true);
    // Coarse last-used tracking (one write per 5 min, not per request).
    const stale =
      !row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 5 * 60_000;
    if (stale) {
      await c.var.db
        .update(schema.apiKey)
        .set({ lastUsedAt: new Date() })
        .where(eq(schema.apiKey.id, row.id));
    }
  }
  await next();
});

// For endpoints that only make sense for a human session (admin management,
// push subscriptions bound to a browser).
export const rejectApiKey = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("apiKeyAuth")) {
    return c.json(
      { error: "Not available to API keys", code: "FORBIDDEN" },
      403,
    );
  }
  await next();
});
