import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import {
  CreateInviteSchema,
  ErrorSchema,
  InviteInfoSchema,
  InviteSchema,
  RedeemResultSchema,
  RedeemSchema,
} from "@pjokk/shared";
import type { AppEnv, FamEnv } from "../context";
import { schema } from "../db";
import { createApp, iso, isoOrNull, jsonContent } from "../lib";
import { rateLimit } from "../middleware/rate-limit";

function serInvite(
  row: typeof schema.familyInvite.$inferSelect,
  appUrl: string,
) {
  return {
    code: row.code,
    familyId: row.familyId,
    role: row.role,
    expiresAt: iso(row.expiresAt),
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    revokedAt: isoOrNull(row.revokedAt),
    url: `${appUrl}/join/${row.code}`,
  };
}

// --- Admin-only management (family-scoped) ---

const createInvite = createRoute({
  method: "post",
  path: "/api/invites",
  tags: ["invites"],
  request: {
    body: {
      content: { "application/json": { schema: CreateInviteSchema } },
      required: false,
    },
  },
  responses: {
    201: jsonContent(InviteSchema, "Created invite code"),
  },
});

const listInvites = createRoute({
  method: "get",
  path: "/api/invites",
  tags: ["invites"],
  responses: {
    200: jsonContent(z.array(InviteSchema), "Invites for the family"),
  },
});

const revokeInvite = createRoute({
  method: "delete",
  path: "/api/invites/{code}",
  tags: ["invites"],
  request: { params: z.object({ code: z.string() }) },
  responses: {
    200: jsonContent(z.object({ ok: z.literal(true) }), "Revoked"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});

export const invitesAdminApp = createApp<FamEnv>()
  .openapi(createInvite, async (c) => {
    const body = c.req.valid("json") ?? {
      role: "member" as const,
      expiresInHours: 72,
      maxUses: 5,
    };
    const invite = await c.var.fam.createInvite({
      role: body.role,
      expiresAt: new Date(Date.now() + body.expiresInHours * 3600_000),
      maxUses: body.maxUses,
      createdBy: c.var.sessionData.user.id,
    });
    return c.json(serInvite(invite, c.var.deps.appUrl), 201);
  })
  .openapi(listInvites, async (c) => {
    const invites = await c.var.fam.listInvites();
    return c.json(
      invites.map((i) => serInvite(i, c.var.deps.appUrl)),
      200,
    );
  })
  .openapi(revokeInvite, async (c) => {
    const { code } = c.req.valid("param");
    const ok = await c.var.fam.revokeInvite(code);
    if (!ok) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true as const }, 200);
  });

// --- Public info + redeem (codes are credentials: both are rate-limited) ---

const inviteInfo = createRoute({
  method: "get",
  path: "/api/invites/info/{code}",
  tags: ["invites"],
  description:
    "What the /join page shows before sign-in: which family, which role, still valid?",
  middleware: [
    rateLimit({ name: "invite-info", limit: 30, windowSeconds: 600 }),
    // Global backstop against distributed code guessing (issue #1).
    rateLimit({
      name: "invite-info-global",
      limit: 500,
      windowSeconds: 600,
      scope: "global",
    }),
  ] as const,
  request: { params: z.object({ code: z.string() }) },
  responses: {
    200: jsonContent(InviteInfoSchema, "Invite status"),
  },
});

const redeem = createRoute({
  method: "post",
  path: "/api/invites/redeem",
  tags: ["invites"],
  description:
    "Join a family with an invite code. Requires a signed-in session; membership + use-count are written atomically in one transaction.",
  middleware: [
    rateLimit({ name: "invite-redeem", limit: 10, windowSeconds: 600 }),
    rateLimit({
      name: "invite-redeem-global",
      limit: 200,
      windowSeconds: 600,
      scope: "global",
    }),
  ] as const,
  request: {
    body: { content: { "application/json": { schema: RedeemSchema } } },
  },
  responses: {
    200: jsonContent(RedeemResultSchema, "Joined (or already a member)"),
    400: jsonContent(ErrorSchema, "Invalid or exhausted code"),
    401: jsonContent(ErrorSchema, "Not signed in"),
  },
});

type InviteRow = typeof schema.familyInvite.$inferSelect;

function classifyInvite(row: InviteRow | undefined, now: number) {
  if (!row) return "not_found" as const;
  if (row.revokedAt) return "revoked" as const;
  if (row.expiresAt.getTime() <= now) return "expired" as const;
  if (row.usedCount >= row.maxUses) return "exhausted" as const;
  return null;
}

export const invitesPublicApp = createApp<AppEnv>()
  .openapi(inviteInfo, async (c) => {
    // Codes are generated uppercase to be read aloud; accept them typed in
    // any case.
    const code = c.req.valid("param").code.toUpperCase();
    const rows = await c.var.db
      .select()
      .from(schema.familyInvite)
      .where(eq(schema.familyInvite.code, code));
    const invite = rows[0];
    const reason = classifyInvite(invite, Date.now());
    if (!invite || reason) {
      return c.json(
        { valid: false, familyName: null, role: null, reason: reason! },
        200,
      );
    }
    const org = await c.var.db
      .select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, invite.familyId));
    return c.json(
      {
        valid: true,
        familyName: org[0]?.name ?? null,
        role: invite.role,
        reason: null,
      },
      200,
    );
  })
  .openapi(redeem, async (c) => {
    const session = c.var.sessionData;
    if (!session) {
      return c.json({ error: "Not signed in", code: "UNAUTHENTICATED" }, 401);
    }
    const code = c.req.valid("json").code.toUpperCase();
    const userId = session.user.id;
    const now = Date.now();

    const rows = await c.var.db
      .select()
      .from(schema.familyInvite)
      .where(eq(schema.familyInvite.code, code));
    const invite = rows[0];
    const reason = classifyInvite(invite, now);
    if (!invite || reason) {
      return c.json(
        { error: `Invite ${reason ?? "invalid"}`, code: "INVALID_INVITE" },
        400,
      );
    }

    const orgRows = await c.var.db
      .select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, invite.familyId));
    const familyName = orgRows[0]?.name ?? "family";

    const existing = await c.var.db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, invite.familyId),
          eq(schema.member.userId, userId),
        ),
      )
      .limit(1);
    if (existing[0]) {
      await setActive(c.var.auth, c.req.raw.headers, invite.familyId);
      return c.json(
        {
          familyId: invite.familyId,
          familyName,
          role: invite.role,
          alreadyMember: true,
        },
        200,
      );
    }

    // Atomic redeem.
    //
    // This was hand-written SQL: two statements in a D1 batch carrying the
    // same logical guard, plus a compensating DELETE/decrement in case they
    // ever disagreed — all of it working around D1's lack of transactions.
    // A real transaction expresses the same intent directly, and SELECT …
    // FOR UPDATE does something the batch could only approximate: it
    // serializes concurrent redeems of the same code, so max_uses is now
    // genuinely enforced instead of merely being difficult to exceed.
    const redeemed = await c.var.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(schema.familyInvite)
        .where(eq(schema.familyInvite.code, code))
        .for("update");
      // Re-checked inside the lock: the earlier read was optimistic and a
      // concurrent redeem may have exhausted or revoked the code since.
      const row = locked[0];
      if (classifyInvite(row, Date.now()) !== null || !row) return false;

      // Membership is re-checked here too, for the same reason.
      const already = await tx
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.organizationId, row.familyId),
            eq(schema.member.userId, userId),
          ),
        )
        .limit(1);
      if (already[0]) return false;

      await tx.insert(schema.member).values({
        id: crypto.randomUUID(),
        organizationId: row.familyId,
        userId,
        role: row.role,
        createdAt: new Date(),
      });
      await tx
        .update(schema.familyInvite)
        .set({ usedCount: sql`${schema.familyInvite.usedCount} + 1` })
        .where(eq(schema.familyInvite.code, code));
      return true;
    });

    if (!redeemed) {
      return c.json(
        { error: "Invite no longer valid", code: "INVALID_INVITE" },
        400,
      );
    }

    await setActive(c.var.auth, c.req.raw.headers, invite.familyId);
    return c.json(
      {
        familyId: invite.familyId,
        familyName,
        role: invite.role,
        alreadyMember: false,
      },
      200,
    );
  });

async function setActive(
  auth: AppEnv["Variables"]["auth"],
  headers: Headers,
  organizationId: string,
) {
  try {
    await auth.api.setActiveOrganization({
      headers,
      body: { organizationId },
    });
  } catch {
    // Non-fatal: the client also calls setActive after landing.
  }
}
