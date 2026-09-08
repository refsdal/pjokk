import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type AdminFamilyMember,
  type AdminInvite,
  inviteState,
  isInviteLive,
  isPrivilegedRole,
  wouldStrandFamily,
} from "@/screens/admin/lib";

// Pure logic behind the operator console's family detail page. The screens
// themselves are queries and markup; everything that can be got wrong
// silently lives in lib.ts.

function member(role: string, id = role): AdminFamilyMember {
  return {
    memberId: id,
    userId: `u-${id}`,
    name: id,
    email: `${id}@example.com`,
    role,
    joinedAt: "2026-01-01T00:00:00Z",
    banned: false,
  };
}

function invite(over: Partial<AdminInvite> = {}): AdminInvite {
  return {
    code: "ABCD1234",
    familyId: "f1",
    role: "member",
    expiresAt: "2026-12-31T00:00:00Z",
    maxUses: 5,
    usedCount: 0,
    revokedAt: null,
    url: "https://app.pjokk.no/join/ABCD1234",
    ...over,
  };
}

const NOW = new Date("2026-06-01T12:00:00Z");

describe("isPrivilegedRole", () => {
  it("counts admin and Limen's owner, nothing else", () => {
    expect(isPrivilegedRole("admin")).toBe(true);
    // Limen's organization plugin can still assign its own default role,
    // and the server reads it as equivalent — so the badge and the
    // last-admin arithmetic must too, or a family run by an "owner" would
    // look stranded.
    expect(isPrivilegedRole("owner")).toBe(true);
    expect(isPrivilegedRole("member")).toBe(false);
    expect(isPrivilegedRole("")).toBe(false);
  });
});

describe("wouldStrandFamily", () => {
  const admin = member("admin", "a");
  const other = member("member", "b");

  it("blocks removing or demoting the only admin", () => {
    const members = [admin, other];
    expect(wouldStrandFamily(members, admin)).toBe(true);
    expect(wouldStrandFamily(members, admin, "member")).toBe(true);
  });

  it("allows it once a second admin exists", () => {
    const members = [admin, member("admin", "c")];
    expect(wouldStrandFamily(members, admin)).toBe(false);
    expect(wouldStrandFamily(members, admin, "member")).toBe(false);
  });

  it("never blocks acting on a plain member", () => {
    expect(wouldStrandFamily([admin, other], other)).toBe(false);
    expect(wouldStrandFamily([admin, other], other, "admin")).toBe(false);
  });

  it("does not treat promoting an admin to admin as a demotion", () => {
    // Only a change AWAY from admin shrinks the count — the same asymmetry
    // auth.SetMemberRole's guard has.
    expect(wouldStrandFamily([admin, other], admin, "admin")).toBe(false);
  });

  it("counts an owner as an admin", () => {
    const owner = member("owner", "o");
    expect(wouldStrandFamily([owner, other], owner)).toBe(true);
    expect(wouldStrandFamily([owner, admin, other], owner)).toBe(false);
  });
});

describe("isInviteLive / inviteState", () => {
  it("accepts a fresh, unused, unrevoked code", () => {
    expect(isInviteLive(invite(), NOW)).toBe(true);
    expect(inviteState(invite(), NOW)).toBe("");
  });

  it("rejects a revoked code", () => {
    const row = invite({ revokedAt: "2026-05-01T00:00:00Z" });
    expect(isInviteLive(row, NOW)).toBe(false);
    expect(inviteState(row, NOW)).toBe("revoked");
  });

  it("rejects an expired code", () => {
    const row = invite({ expiresAt: "2026-05-31T00:00:00Z" });
    expect(isInviteLive(row, NOW)).toBe(false);
    expect(inviteState(row, NOW)).toBe("expired");
  });

  it("rejects a code at its use limit", () => {
    const row = invite({ usedCount: 5, maxUses: 5 });
    expect(isInviteLive(row, NOW)).toBe(false);
    expect(inviteState(row, NOW)).toBe("used up");
  });

  it("treats the expiry instant itself as expired", () => {
    // The server's classifyInvite uses `!expiresAt.After(now)`, so the
    // boundary is exclusive on both sides. A code that read as live here
    // and dead there would show an operator a link that cannot be redeemed.
    const row = invite({ expiresAt: NOW.toISOString() });
    expect(isInviteLive(row, NOW)).toBe(false);
  });
});

// A structural guard, in the spirit of layout-guards.test.ts: the operator
// console must not grow a read of a family's logs. Metadata-only is what
// lets apps/landing/src/legal/privacy.tsx stay as it is, and the drift
// would be one convenient useQuery away.
describe("the admin console stays metadata-only", () => {
  const ADMIN = join(import.meta.dir, "..", "src", "screens", "admin");

  function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) yield* walk(p);
      else if (/\.(ts|tsx)$/.test(name)) yield p;
    }
  }

  it("reads no log endpoint", () => {
    // Every family-data route the SPA can call. /api/admin/* is fine; these
    // are not, from here.
    const forbidden = [
      "/api/timeline",
      "/api/summary",
      "/api/feeds",
      "/api/sleeps",
      "/api/diapers",
      "/api/stats",
      "/api/export.csv",
      "/api/photos",
    ];
    for (const file of walk(ADMIN)) {
      const source = readFileSync(file, "utf8");
      for (const route of forbidden) {
        expect(`${file}:${source.includes(route)}`).toBe(`${file}:false`);
      }
    }
  });
});
