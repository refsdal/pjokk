import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../context";
import type { Db } from "../db";
import { schema } from "../db";

// System admins are users with role "admin" (better-auth admin plugin) —
// unrelated to per-family member roles. API keys are never system admins.
export const requireSysadmin = createMiddleware<AppEnv>(async (c, next) => {
  const session = c.var.sessionData;
  if (!session) {
    return c.json({ error: "Not signed in", code: "UNAUTHENTICATED" }, 401);
  }
  if (c.get("apiKeyAuth")) {
    return c.json(
      { error: "Not available to API keys", code: "FORBIDDEN" },
      403,
    );
  }
  const role = (session.user as { role?: string | null }).role;
  if (role !== "admin") {
    return c.json({ error: "System admin only", code: "FORBIDDEN" }, 403);
  }
  await next();
});

export async function audit(
  db: Db,
  adminId: string,
  action: string,
  target: string,
  detail?: string,
) {
  await db.insert(schema.adminAudit).values({
    adminId,
    action,
    target,
    detail: detail ?? null,
  });
}
