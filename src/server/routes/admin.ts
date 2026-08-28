import { createRoute, z } from "@hono/zod-openapi";
import { count, desc, eq, gt, max, sql } from "drizzle-orm";
import {
  AdminFamilySchema,
  AdminSetPlanSchema,
  AdminStatsSchema,
  AuditEntrySchema,
  AuditNoteSchema,
  ErrorSchema,
} from "@shared/schemas";
import type { AppEnv } from "../context";
import { schema } from "../db";
import { createApp, iso, isoOrNull, jsonContent } from "../lib";
import { ensureTombstone, TOMBSTONE_ID } from "../db/tombstone";
import { audit } from "../middleware/sysadmin";
import { createStripe } from "../stripe";

// System-admin endpoints (all behind requireSysadmin, wired in index.ts).
// User-level support ops (ban, sessions, passwords, impersonation) come from
// better-auth's admin plugin under /api/auth/admin/* — these cover what that
// plugin doesn't know about: families, platform stats, the audit trail.

const stats = createRoute({
  method: "get",
  path: "/api/admin/stats",
  tags: ["admin"],
  responses: { 200: jsonContent(AdminStatsSchema, "Platform totals") },
});

const families = createRoute({
  method: "get",
  path: "/api/admin/families",
  tags: ["admin"],
  responses: {
    200: jsonContent(z.array(AdminFamilySchema), "All families"),
  },
});

const deleteFamily = createRoute({
  method: "delete",
  path: "/api/admin/families/{id}",
  tags: ["admin"],
  description:
    "Deletes a family and ALL its data (members, babies, logs — cascading). Audited.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: jsonContent(z.object({ ok: z.literal(true) }), "Deleted"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

const setFamilyPlan = createRoute({
  method: "post",
  path: "/api/admin/families/{id}/plan",
  tags: ["admin"],
  description:
    "Support override for a family's plan. Only 'free' and 'comp' — Stripe-derived values (premium/lifetime) are written exclusively by webhooks. Audited.",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: AdminSetPlanSchema } } },
  },
  responses: {
    200: jsonContent(z.object({ ok: z.literal(true) }), "Plan set"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

const deleteUser = createRoute({
  method: "post",
  path: "/api/admin/users/{id}/delete",
  tags: ["admin"],
  description:
    "Deletes a user account safely: their historical log attributions are reassigned to a tombstone 'Deleted user' first (FKs would otherwise block), then the account and its sessions/memberships/subscriptions are removed. Audited.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: jsonContent(z.object({ ok: z.literal(true) }), "Deleted"),
    400: jsonContent(ErrorSchema, "Refused (self or tombstone)"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

const auditList = createRoute({
  method: "get",
  path: "/api/admin/audit",
  tags: ["admin"],
  responses: {
    200: jsonContent(z.array(AuditEntrySchema), "Recent admin actions"),
  },
});

const auditNote = createRoute({
  method: "post",
  path: "/api/admin/audit",
  tags: ["admin"],
  description:
    "Record an admin action performed via the better-auth admin endpoints (impersonation, ban, password set) so the trail stays complete.",
  request: {
    body: { content: { "application/json": { schema: AuditNoteSchema } } },
  },
  responses: {
    200: jsonContent(z.object({ ok: z.literal(true) }), "Recorded"),
  },
});

export const adminApp = createApp<AppEnv>()
  .openapi(stats, async (c) => {
    const db = c.var.db;
    const one = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000);
    const [familiesN, usersN, babiesN, feeds, diapers, sleeps, pushN, recent] =
      await Promise.all([
        one(db.select({ n: count() }).from(schema.organization)),
        one(db.select({ n: count() }).from(schema.user)),
        one(db.select({ n: count() }).from(schema.baby)),
        one(db.select({ n: count() }).from(schema.feedLog)),
        one(db.select({ n: count() }).from(schema.diaperLog)),
        one(db.select({ n: count() }).from(schema.sleepLog)),
        one(db.select({ n: count() }).from(schema.pushSubscription)),
        one(
          db
            .select({ n: count() })
            .from(schema.user)
            .where(gt(schema.user.createdAt, weekAgo)),
        ),
      ]);
    return c.json(
      {
        families: familiesN,
        users: usersN,
        babies: babiesN,
        coreLogs: feeds + diapers + sleeps,
        pushSubscriptions: pushN,
        usersLast7d: recent,
      },
      200,
    );
  })
  .openapi(families, async (c) => {
    const db = c.var.db;
    const rows = await db
      .select({
        id: schema.organization.id,
        name: schema.organization.name,
        slug: schema.organization.slug,
        plan: schema.organization.plan,
        createdAt: schema.organization.createdAt,
        members: sql<number>`(SELECT COUNT(*) FROM member WHERE member.organization_id = ${schema.organization.id})`,
        babies: sql<number>`(SELECT COUNT(*) FROM baby WHERE baby.family_id = ${schema.organization.id})`,
        lastFeedMs: max(schema.feedLog.time),
      })
      .from(schema.organization)
      .leftJoin(
        schema.feedLog,
        eq(schema.feedLog.familyId, schema.organization.id),
      )
      .groupBy(schema.organization.id)
      .orderBy(desc(schema.organization.createdAt));
    return c.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        plan: r.plan,
        createdAt: iso(r.createdAt),
        members: r.members,
        babies: r.babies,
        lastFeedAt: isoOrNull(r.lastFeedMs),
      })),
      200,
    );
  })
  .openapi(deleteFamily, async (c) => {
    const { id } = c.req.valid("param");
    const db = c.var.db;
    const org = await db
      .select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, id));
    if (!org[0]) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    await audit(
      db,
      c.var.sessionData!.user.id,
      "family.delete",
      id,
      org[0].name,
    );
    // Billing can't outlive the data: cancel any live Stripe subscription
    // before the cascade delete. Best-effort — a Stripe hiccup shouldn't
    // block the delete (the sub would be orphaned either way).
    const subs = await db
      .select({
        stripeSubscriptionId: schema.subscription.stripeSubscriptionId,
      })
      .from(schema.subscription)
      .where(eq(schema.subscription.referenceId, id));
    const stripeClient = createStripe(c.env);
    for (const s of subs) {
      if (s.stripeSubscriptionId) {
        await stripeClient.subscriptions
          .cancel(s.stripeSubscriptionId)
          .catch(() => {});
      }
    }
    await db
      .delete(schema.subscription)
      .where(eq(schema.subscription.referenceId, id));
    // FKs cascade: members, invites, babies, and all logs go with the org.
    await db.delete(schema.organization).where(eq(schema.organization.id, id));
    return c.json({ ok: true as const }, 200);
  })
  .openapi(setFamilyPlan, async (c) => {
    const { id } = c.req.valid("param");
    const { plan } = c.req.valid("json");
    const db = c.var.db;
    const org = await db
      .select({ plan: schema.organization.plan })
      .from(schema.organization)
      .where(eq(schema.organization.id, id));
    if (!org[0]) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    await audit(
      db,
      c.var.sessionData!.user.id,
      "billing.plan.set",
      id,
      `${org[0].plan} -> ${plan}`,
    );
    await db
      .update(schema.organization)
      .set({ plan })
      .where(eq(schema.organization.id, id));
    return c.json({ ok: true as const }, 200);
  })
  .openapi(deleteUser, async (c) => {
    const { id } = c.req.valid("param");
    const db = c.var.db;
    const self = c.var.sessionData!.user.id;
    if (id === self || id === TOMBSTONE_ID) {
      return c.json({ error: "Refused", code: "REFUSED" }, 400);
    }
    const target = await db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, id));
    if (!target[0]) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }

    await ensureTombstone(db);
    // Reassign every non-cascading FK to the tombstone so history survives
    // as "Deleted user" and the delete can't be blocked.
    const caretakerTables = [
      schema.feedLog,
      schema.diaperLog,
      schema.sleepLog,
      schema.medicineLog,
      schema.bathLog,
      schema.noteLog,
      schema.milestoneLog,
      schema.measurementLog,
      schema.pumpLog,
    ] as const;
    for (const table of caretakerTables) {
      await db
        .update(table)
        .set({ caretakerId: TOMBSTONE_ID })
        .where(eq(table.caretakerId, id));
    }
    await db
      .update(schema.familyInvite)
      .set({ createdBy: TOMBSTONE_ID })
      .where(eq(schema.familyInvite.createdBy, id));
    await db
      .update(schema.apiKey)
      .set({ createdBy: TOMBSTONE_ID, revokedAt: new Date() })
      .where(eq(schema.apiKey.createdBy, id));
    await db
      .update(schema.adminAudit)
      .set({ adminId: TOMBSTONE_ID })
      .where(eq(schema.adminAudit.adminId, id));
    await db
      .update(schema.calendarEvent)
      .set({ createdBy: TOMBSTONE_ID })
      .where(eq(schema.calendarEvent.createdBy, id));
    // Assignee, not attribution — reassigning to the tombstone would be
    // meaningless (and could violate the (event_id, user_id) PK if the
    // tombstone is already assigned). Just drop the assignment.
    await db
      .delete(schema.calendarAssignee)
      .where(eq(schema.calendarAssignee.userId, id));

    await audit(db, self, "user.delete", id, target[0].email);
    // Cascades take sessions, accounts, passkeys, memberships, push
    // subscriptions/prefs and sent invitations.
    await db.delete(schema.user).where(eq(schema.user.id, id));
    return c.json({ ok: true as const }, 200);
  })
  .openapi(auditList, async (c) => {
    const rows = await c.var.db
      .select({
        id: schema.adminAudit.id,
        adminId: schema.adminAudit.adminId,
        adminName: schema.user.name,
        action: schema.adminAudit.action,
        target: schema.adminAudit.target,
        detail: schema.adminAudit.detail,
        createdAt: schema.adminAudit.createdAt,
      })
      .from(schema.adminAudit)
      .innerJoin(schema.user, eq(schema.adminAudit.adminId, schema.user.id))
      .orderBy(desc(schema.adminAudit.createdAt))
      .limit(100);
    return c.json(
      rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
      200,
    );
  })
  .openapi(auditNote, async (c) => {
    const body = c.req.valid("json");
    await audit(
      c.var.db,
      c.var.sessionData!.user.id,
      body.action,
      body.target,
      body.detail,
    );
    return c.json({ ok: true as const }, 200);
  });
