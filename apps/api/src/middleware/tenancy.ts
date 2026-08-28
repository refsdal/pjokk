import { createMiddleware } from "hono/factory";
import { and, eq } from "drizzle-orm";
import type { AppEnv, FamEnv } from "../context";
import { schema } from "../db";
import { familyScope } from "../db/scoped";
import { audit } from "./sysadmin";

// Resolves the session once per request; never rejects (routes decide).
// Skipped when API-key auth already populated a synthetic session.
export const sessionMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("sessionData")) {
    const session = await c.var.auth.api.getSession({
      headers: c.req.raw.headers,
    });
    c.set("sessionData", session ?? null);
  }
  await next();
});

// The tenancy gate. Every domain route sits behind this: it resolves the
// family from the session's active organization, verifies the membership row
// actually exists (an activeOrganizationId alone is not proof), and exposes
// the family-scoped query helpers. Handlers never see the raw db.
export const requireFamily = createMiddleware<FamEnv>(async (c, next) => {
  const session = c.var.sessionData;
  if (!session) {
    return c.json({ error: "Not signed in", code: "UNAUTHENTICATED" }, 401);
  }
  const familyId = session.session.activeOrganizationId;
  if (!familyId) {
    return c.json({ error: "No active family", code: "NO_FAMILY" }, 403);
  }
  const membership = await c.var.db
    .select({ role: schema.member.role, plan: schema.organization.plan })
    .from(schema.member)
    .innerJoin(
      schema.organization,
      eq(schema.member.organizationId, schema.organization.id),
    )
    .where(
      and(
        eq(schema.member.organizationId, familyId),
        eq(schema.member.userId, session.user.id),
      ),
    )
    .limit(1);
  if (!membership[0]) {
    return c.json(
      { error: "Not a member of this family", code: "NOT_MEMBER" },
      403,
    );
  }
  c.set("familyId", familyId);
  c.set("memberRole", membership[0].role);
  c.set("plan", membership[0].plan);
  c.set("fam", familyScope(c.var.db, familyId));

  // Issue #7: domain WRITES made while impersonating leave a trace with
  // both identities.
  const impersonator = (session.session as { impersonatedBy?: string | null })
    .impersonatedBy;
  if (impersonator && !["GET", "HEAD"].includes(c.req.method)) {
    await audit(
      c.var.db,
      impersonator,
      "impersonated.write",
      session.user.id,
      `${c.req.method} ${c.req.path}`,
    ).catch(() => {});
  }

  await next();
});

export const requireAdmin = createMiddleware<FamEnv>(async (c, next) => {
  if (c.get("apiKeyAuth")) {
    return c.json(
      { error: "Not available to API keys", code: "FORBIDDEN" },
      403,
    );
  }
  const role = c.var.memberRole;
  if (role !== "admin" && role !== "owner") {
    return c.json({ error: "Admin only", code: "FORBIDDEN" }, 403);
  }
  await next();
});
