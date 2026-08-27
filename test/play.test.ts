import { describe, expect, it } from "vitest";
import { familyScope } from "../src/worker/db/scoped";
import {
  addMember,
  api,
  createBaby,
  createFamily,
  createUser,
  db,
  rig,
  setPlan,
} from "./helpers";

const MIN = 60_000;

// Premium is the normal state for these; the gate itself is tested below.
const premiumRig = async () => {
  const r = await rig();
  await setPlan(r.family.id, "premium");
  return r;
};

describe("play sessions", () => {
  it("starts a running session when endTime is omitted", async () => {
    const { cookie, baby } = await premiumRig();

    const res = await api("/api/play", {
      method: "POST",
      cookie,
      body: {
        babyId: baby.id,
        type: "tummy",
        startTime: new Date().toISOString(),
      },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      endTime: string | null;
      type: string;
    };
    expect(created.endTime).toBeNull();
    expect(created.type).toBe("tummy");

    const active = await api(`/api/play/active?babyId=${baby.id}`, { cookie });
    expect(((await active.json()) as { id: string }).id).toBe(created.id);
  });

  it("logs a finished session retroactively without touching the timer", async () => {
    const { cookie, baby } = await premiumRig();
    const end = new Date();
    const start = new Date(end.getTime() - 20 * MIN);

    const res = await api("/api/play", {
      method: "POST",
      cookie,
      body: {
        babyId: baby.id,
        type: "walk",
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { endTime: string | null }).endTime).not.toBe(
      null,
    );

    // A completed entry is not "active", so a timer can still be started.
    const active = await api(`/api/play/active?babyId=${baby.id}`, { cookie });
    expect(await active.json()).toBeNull();
  });

  it("refuses a second running session for the same baby", async () => {
    const { cookie, baby } = await premiumRig();
    const body = {
      babyId: baby.id,
      type: "tummy",
      startTime: new Date().toISOString(),
    };

    expect(
      (await api("/api/play", { method: "POST", cookie, body })).status,
    ).toBe(201);
    const second = await api("/api/play", { method: "POST", cookie, body });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe(
      "ALREADY_ACTIVE",
    );
  });

  it("allows a running session per baby, independently", async () => {
    const { family, cookie, baby } = await premiumRig();
    const sibling = await createBaby(family.id, "Sibling");
    const startTime = new Date().toISOString();

    for (const id of [baby.id, sibling.id]) {
      const res = await api("/api/play", {
        method: "POST",
        cookie,
        body: { babyId: id, type: "tummy", startTime },
      });
      expect(res.status).toBe(201);
    }
  });

  it("coexists with a running sleep session", async () => {
    const { cookie, baby } = await premiumRig();
    const startTime = new Date().toISOString();

    const sleep = await api("/api/sleep", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, startTime },
    });
    expect(sleep.status).toBe(201);
    const play = await api("/api/play", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, type: "tummy", startTime },
    });
    expect(play.status).toBe(201);
  });

  it("stops the timer, defaulting endTime to now, and is idempotent", async () => {
    const { cookie, baby } = await premiumRig();
    const created = await api("/api/play", {
      method: "POST",
      cookie,
      body: {
        babyId: baby.id,
        type: "walk",
        startTime: new Date(Date.now() - 5 * MIN).toISOString(),
      },
    });
    const { id } = (await created.json()) as { id: string };

    const stopped = await api(`/api/play/${id}/stop`, {
      method: "POST",
      cookie,
      body: {},
    });
    expect(stopped.status).toBe(200);
    expect(
      ((await stopped.json()) as { endTime: string | null }).endTime,
    ).not.toBe(null);

    // The NULL guard means a replayed stop cannot rewrite the end time.
    const again = await api(`/api/play/${id}/stop`, {
      method: "POST",
      cookie,
      body: {},
    });
    expect(again.status).toBe(404);
  });

  it("frees the slot once stopped", async () => {
    const { cookie, baby } = await premiumRig();
    const body = {
      babyId: baby.id,
      type: "tummy",
      startTime: new Date().toISOString(),
    };
    const first = await api("/api/play", { method: "POST", cookie, body });
    const { id } = (await first.json()) as { id: string };
    await api(`/api/play/${id}/stop`, { method: "POST", cookie, body: {} });

    const second = await api("/api/play", { method: "POST", cookie, body });
    expect(second.status).toBe(201);
  });

  it("surfaces the running activity on the home summary", async () => {
    const { cookie, baby } = await premiumRig();
    const before = await api(`/api/summary?babyId=${baby.id}&tz=0`, { cookie });
    expect(((await before.json()) as { activePlay: unknown }).activePlay).toBe(
      null,
    );

    await api("/api/play", {
      method: "POST",
      cookie,
      body: {
        babyId: baby.id,
        type: "tummy",
        startTime: new Date().toISOString(),
      },
    });

    const after = await api(`/api/summary?babyId=${baby.id}&tz=0`, { cookie });
    const summary = (await after.json()) as {
      activePlay: { type: string } | null;
    };
    expect(summary.activePlay?.type).toBe("tummy");
  });

  it("appears in the timeline under the other filter", async () => {
    const { cookie, baby } = await premiumRig();
    const end = new Date();
    await api("/api/play", {
      method: "POST",
      cookie,
      body: {
        babyId: baby.id,
        type: "walk",
        startTime: new Date(end.getTime() - 30 * MIN).toISOString(),
        endTime: end.toISOString(),
      },
    });

    const res = await api(`/api/timeline?babyId=${baby.id}&filter=other`, {
      cookie,
    });
    const { entries } = (await res.json()) as {
      entries: { kind: string; type?: string }[];
    };
    const play = entries.find((e) => e.kind === "play");
    expect(play?.type).toBe("walk");
  });

  it("gates creation on premium but never stopping or deleting", async () => {
    const { family, cookie, baby } = await rig();
    const body = {
      babyId: baby.id,
      type: "tummy",
      startTime: new Date().toISOString(),
    };

    const denied = await api("/api/play", { method: "POST", cookie, body });
    expect(denied.status).toBe(402);
    expect(((await denied.json()) as { code: string }).code).toBe(
      "PLAN_REQUIRED",
    );

    await setPlan(family.id, "premium");
    const created = await api("/api/play", { method: "POST", cookie, body });
    const { id } = (await created.json()) as { id: string };

    // A downgrade must never strand a running timer.
    await setPlan(family.id, "free");
    expect(
      (await api(`/api/play/${id}/stop`, { method: "POST", cookie, body: {} }))
        .status,
    ).toBe(200);
    expect(
      (await api(`/api/play/${id}`, { method: "DELETE", cookie })).status,
    ).toBe(200);
  });

  it("404s on an unknown baby and keeps families apart", async () => {
    const { family, cookie } = await premiumRig();
    const otherFamily = await createFamily("Other family");
    const theirBaby = await createBaby(otherFamily.id, "Their baby");

    const res = await api("/api/play", {
      method: "POST",
      cookie,
      body: {
        babyId: theirBaby.id,
        type: "tummy",
        startTime: new Date().toISOString(),
      },
    });
    expect(res.status).toBe(404);

    // And the scope helper refuses to reach across families.
    const theirUser = await createUser("Their parent");
    await addMember(theirUser.id, otherFamily.id, "admin");
    const theirFam = familyScope(db(), otherFamily.id);
    const theirs = await theirFam.createPlay({
      babyId: theirBaby.id,
      caretakerId: theirUser.id,
      type: "walk",
      startTime: new Date(),
    });
    const ourFam = familyScope(db(), family.id);
    expect(await ourFam.getPlay(theirs!.id)).toBeNull();
    expect(await ourFam.deletePlay(theirs!.id)).toBe(false);
    expect(await ourFam.stopPlay(theirs!.id, new Date())).toBeNull();
  });
});
