import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "../src/server/db";
import { addMember, api, createUser, db, rig, signIn } from "./helpers";

async function inviteRow(code: string) {
  const rows = await db()
    .select()
    .from(schema.familyInvite)
    .where(eq(schema.familyInvite.code, code));
  return rows[0];
}

describe("invite codes", () => {
  it("admin creates an invite; plain members cannot", async () => {
    const a = await rig();
    const res = await api("/api/invites", {
      method: "POST",
      cookie: a.cookie,
      body: { role: "member", expiresInHours: 72, maxUses: 5 },
    });
    expect(res.status).toBe(201);
    const invite = (await res.json()) as { code: string; url: string };
    expect(invite.url).toContain(`/join/${invite.code}`);

    const member = await createUser("Plain member");
    await addMember(member.id, a.family.id, "member");
    const memberCookie = await signIn(member.email);
    const denied = await api("/api/invites", {
      method: "POST",
      cookie: memberCookie,
      body: {},
    });
    expect(denied.status).toBe(403);
  });

  it("redeems: adds membership + increments use count atomically", async () => {
    const a = await rig();
    const invite = (await (
      await api("/api/invites", {
        method: "POST",
        cookie: a.cookie,
        body: { role: "member", expiresInHours: 72, maxUses: 2 },
      })
    ).json()) as { code: string };

    const newcomer = await createUser("Newcomer");
    const cookie = await signIn(newcomer.email);

    // Before joining, no family.
    expect((await api("/api/babies", { cookie })).status).toBe(403);

    const redeem = await api("/api/invites/redeem", {
      method: "POST",
      cookie,
      body: { code: invite.code },
    });
    expect(redeem.status).toBe(200);
    const result = (await redeem.json()) as {
      familyId: string;
      alreadyMember: boolean;
    };
    expect(result.familyId).toBe(a.family.id);
    expect(result.alreadyMember).toBe(false);
    expect((await inviteRow(invite.code))!.usedCount).toBe(1);

    // Redeem set the active organization: domain routes now work.
    const babies = await api("/api/babies", { cookie });
    expect(babies.status).toBe(200);
    expect((await babies.json()) as unknown[]).toHaveLength(1);
  });

  it("re-redeeming as an existing member burns no use", async () => {
    const a = await rig();
    const invite = (await (
      await api("/api/invites", {
        method: "POST",
        cookie: a.cookie,
        body: { role: "member", expiresInHours: 72, maxUses: 5 },
      })
    ).json()) as { code: string };

    const redeem = await api("/api/invites/redeem", {
      method: "POST",
      cookie: a.cookie,
      body: { code: invite.code },
    });
    expect(redeem.status).toBe(200);
    expect(
      ((await redeem.json()) as { alreadyMember: boolean }).alreadyMember,
    ).toBe(true);
    expect((await inviteRow(invite.code))!.usedCount).toBe(0);
  });

  it("rejects expired, revoked and exhausted codes", async () => {
    const a = await rig();
    const make = async (body: Record<string, unknown>) =>
      (await (
        await api("/api/invites", { method: "POST", cookie: a.cookie, body })
      ).json()) as { code: string };

    const expired = await make({
      role: "member",
      expiresInHours: 1,
      maxUses: 5,
    });
    await db()
      .update(schema.familyInvite)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.familyInvite.code, expired.code));

    const revoked = await make({ role: "member" });
    await api(`/api/invites/${revoked.code}`, {
      method: "DELETE",
      cookie: a.cookie,
    });

    const exhausted = await make({ role: "member", maxUses: 1 });
    await db()
      .update(schema.familyInvite)
      .set({ usedCount: 1 })
      .where(eq(schema.familyInvite.code, exhausted.code));

    const outsider = await createUser("Outsider");
    const cookie = await signIn(outsider.email);
    for (const code of [expired.code, revoked.code, exhausted.code, "NOPE"]) {
      const res = await api("/api/invites/redeem", {
        method: "POST",
        cookie,
        body: { code },
      });
      expect(res.status).toBe(400);
    }

    // The invalid attempts changed nothing.
    expect((await inviteRow(exhausted.code))!.usedCount).toBe(1);
    expect((await api("/api/babies", { cookie })).status).toBe(403);
  });

  it("exposes safe status via the public info endpoint", async () => {
    const a = await rig("The Pjokk family");
    const invite = (await (
      await api("/api/invites", {
        method: "POST",
        cookie: a.cookie,
        body: { role: "member" },
      })
    ).json()) as { code: string };

    const info = (await (
      await api(`/api/invites/info/${invite.code}`)
    ).json()) as { valid: boolean; familyName: string; role: string };
    expect(info.valid).toBe(true);
    expect(info.familyName).toBe("The Pjokk family");
    expect(info.role).toBe("member");

    const bad = (await (await api(`/api/invites/info/NOPE`)).json()) as {
      valid: boolean;
      reason: string;
    };
    expect(bad.valid).toBe(false);
    expect(bad.reason).toBe("not_found");
  });

  it("rate-limits redeem attempts", async () => {
    const outsider = await createUser("Brute");
    const cookie = await signIn(outsider.email);
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const res = await api("/api/invites/redeem", {
        method: "POST",
        cookie,
        body: { code: `GUESS${i}` },
      });
      if (res.status === 429) {
        limited = true;
        break;
      }
      expect(res.status).toBe(400);
    }
    expect(limited).toBe(true);
  });
});
