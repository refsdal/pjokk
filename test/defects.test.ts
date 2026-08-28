import { describe, expect, it } from "bun:test";
import { schema } from "../src/server/db";
import { isUniqueViolation } from "../src/server/lib";
import { formatRelative, toLocalDateInput } from "../src/web/lib/time";
import { api, db, rig, setPlan } from "./helpers";
import type { Timeline } from "../src/shared/schemas";

// Regression tests for the 2026-08-25 review findings.

describe("empty PATCH bodies are no-ops, not 500s", () => {
  it("core and generic update endpoints accept {}", async () => {
    const a = await rig();
    // Bath is a gated activity type (Task 1 entitlement rework) — this test
    // is about PATCH no-ops, not the create gate, so lift the family to
    // premium before creating one.
    await setPlan(a.family.id, "premium");
    const feed = (await (
      await api("/api/feeds", {
        method: "POST",
        cookie: a.cookie,
        body: {
          babyId: a.baby.id,
          time: new Date().toISOString(),
          type: "bottle",
          amountMl: 120,
        },
      })
    ).json()) as { id: string };
    const bath = (await (
      await api("/api/baths", {
        method: "POST",
        cookie: a.cookie,
        body: { babyId: a.baby.id, time: new Date().toISOString() },
      })
    ).json()) as { id: string };

    for (const path of [`/api/feeds/${feed.id}`, `/api/baths/${bath.id}`]) {
      const res = await api(path, {
        method: "PATCH",
        cookie: a.cookie,
        body: {},
      });
      expect(res.status).toBe(200);
    }
    const babyPatch = await api(`/api/babies/${a.baby.id}`, {
      method: "PATCH",
      cookie: a.cookie,
      body: {},
    });
    expect(babyPatch.status).toBe(200);
  });
});

describe("timeline same-timestamp pagination", () => {
  it("never drops entries sharing the page-boundary timestamp", async () => {
    const a = await rig();
    const t0 = Date.now();
    // Three entries: one newer, two sharing an exact timestamp.
    const mk = (time: number, ml: number) =>
      api("/api/feeds", {
        method: "POST",
        cookie: a.cookie,
        body: {
          babyId: a.baby.id,
          time: new Date(time).toISOString(),
          type: "bottle",
          amountMl: ml,
        },
      });
    await mk(t0, 100);
    await mk(t0 - 60_000, 101);
    await mk(t0 - 60_000, 102);

    const seen: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const qs: string =
        `babyId=${a.baby.id}&limit=2` +
        (cursor ? `&before=${encodeURIComponent(cursor)}` : "");
      const page = (await (
        await api(`/api/timeline?${qs}`, { cookie: a.cookie })
      ).json()) as Timeline;
      for (const e of page.entries) {
        if (e.kind === "feed") seen.push(e.amountMl!);
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual([100, 101, 102]);
  });
});

describe("invite codes are case-insensitive", () => {
  it("redeems and resolves info for lowercase input", async () => {
    const a = await rig();
    const invite = (await (
      await api("/api/invites", {
        method: "POST",
        cookie: a.cookie,
        body: { role: "member" },
      })
    ).json()) as { code: string };

    const info = (await (
      await api(`/api/invites/info/${invite.code.toLowerCase()}`)
    ).json()) as { valid: boolean };
    expect(info.valid).toBe(true);

    const { createUser, signIn } = await import("./helpers");
    const guest = await createUser("Lowercase guest");
    const cookie = await signIn(guest.email);
    const redeem = await api("/api/invites/redeem", {
      method: "POST",
      cookie,
      body: { code: invite.code.toLowerCase() },
    });
    expect(redeem.status).toBe(200);
  });
});

describe("one active sleep session per baby (DB-enforced)", () => {
  it("the partial unique index rejects a second active row", async () => {
    const a = await rig();
    const base = {
      familyId: a.family.id,
      babyId: a.baby.id,
      caretakerId: a.user.id,
      startTime: new Date(),
      endTime: null,
    };
    await db().insert(schema.sleepLog).values(base);
    let uniqueViolation = false;
    try {
      await db().insert(schema.sleepLog).values(base);
    } catch (err) {
      // Asserted through the app's own helper rather than by re-implementing
      // the detection here. The duplicate logic previously checked for the
      // literal "UNIQUE" — SQLite's wording — so this test would have kept
      // passing against Postgres while the routes it stands for silently
      // returned 500s.
      uniqueViolation = isUniqueViolation(err);
    }
    expect(uniqueViolation).toBe(true);
    // A COMPLETED session alongside an active one is fine.
    await db()
      .insert(schema.sleepLog)
      .values({
        ...base,
        startTime: new Date(Date.now() - 3600_000),
        endTime: new Date(),
      });
  });
});

describe("time helpers", () => {
  it("stays relative across midnight", () => {
    const now = new Date("2026-08-25T00:30:00");
    expect(formatRelative(new Date("2026-08-24T22:30:00"), now)).toBe(
      "2 h ago",
    );
    // ≥24h ago on the previous calendar day → yesterday + clock.
    expect(
      formatRelative(
        new Date("2026-08-24T00:15:00"),
        new Date("2026-08-25T01:30:00"),
      ).startsWith("yesterday"),
    ).toBe(true);
  });

  it("formats date inputs in local time", () => {
    const d = new Date(2026, 7, 25, 0, 30); // local 25 Aug, 00:30
    expect(toLocalDateInput(d)).toBe("2026-08-25");
  });
});
