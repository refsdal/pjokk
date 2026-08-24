import { describe, expect, it } from "vitest";
import { api, rig } from "./helpers";

describe("active sleep sessions", () => {
  it("start → active → wake → inactive", async () => {
    const a = await rig();
    const start = await api("/api/sleep", {
      method: "POST",
      cookie: a.cookie,
      body: {
        babyId: a.baby.id,
        startTime: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
    });
    expect(start.status).toBe(201);
    const session = (await start.json()) as { id: string; endTime: null };
    expect(session.endTime).toBeNull();

    const active = await api(`/api/sleep/active?babyId=${a.baby.id}`, {
      cookie: a.cookie,
    });
    expect(((await active.json()) as { id: string }).id).toBe(session.id);

    const wake = await api(`/api/sleep/${session.id}/wake`, {
      method: "POST",
      cookie: a.cookie,
      body: {},
    });
    expect(wake.status).toBe(200);
    expect(((await wake.json()) as { endTime: string }).endTime).toBeTruthy();

    const after = await api(`/api/sleep/active?babyId=${a.baby.id}`, {
      cookie: a.cookie,
    });
    expect(await after.json()).toBeNull();
  });

  it("refuses a second active session for the same baby", async () => {
    const a = await rig();
    const body = {
      babyId: a.baby.id,
      startTime: new Date().toISOString(),
    };
    expect(
      (await api("/api/sleep", { method: "POST", cookie: a.cookie, body }))
        .status,
    ).toBe(201);
    const second = await api("/api/sleep", {
      method: "POST",
      cookie: a.cookie,
      body,
    });
    expect(second.status).toBe(409);
  });

  it("waking twice is a no-op error, not data corruption", async () => {
    const a = await rig();
    const session = (await (
      await api("/api/sleep", {
        method: "POST",
        cookie: a.cookie,
        body: { babyId: a.baby.id, startTime: new Date().toISOString() },
      })
    ).json()) as { id: string };

    const endTime = new Date().toISOString();
    const first = await api(`/api/sleep/${session.id}/wake`, {
      method: "POST",
      cookie: a.cookie,
      body: { endTime },
    });
    expect(first.status).toBe(200);

    const second = await api(`/api/sleep/${session.id}/wake`, {
      method: "POST",
      cookie: a.cookie,
      body: { endTime: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(second.status).toBe(404);

    const list = (await (
      await api(`/api/sleep?babyId=${a.baby.id}`, { cookie: a.cookie })
    ).json()) as { id: string; endTime: string }[];
    expect(list[0]!.endTime).toBe(endTime);
  });

  it("summary bundles last feed, last diaper and sleep state", async () => {
    const a = await rig();
    const now = Date.now();
    await api("/api/feeds", {
      method: "POST",
      cookie: a.cookie,
      body: {
        babyId: a.baby.id,
        time: new Date(now - 2 * 3600_000).toISOString(),
        type: "bottle",
        amountMl: 120,
      },
    });
    await api("/api/diapers", {
      method: "POST",
      cookie: a.cookie,
      body: {
        babyId: a.baby.id,
        time: new Date(now - 40 * 60_000).toISOString(),
        type: "wet",
      },
    });
    await api("/api/sleep", {
      method: "POST",
      cookie: a.cookie,
      body: {
        babyId: a.baby.id,
        startTime: new Date(now - 25 * 60_000).toISOString(),
      },
    });

    const summary = (await (
      await api(`/api/summary?babyId=${a.baby.id}`, { cookie: a.cookie })
    ).json()) as {
      lastFeed: { amountMl: number; caretakerName: string };
      lastDiaper: { type: string };
      activeSleep: { endTime: null };
      lastSleep: { id: string };
    };
    expect(summary.lastFeed.amountMl).toBe(120);
    expect(summary.lastFeed.caretakerName).toBe("Rig admin");
    expect(summary.lastDiaper.type).toBe("wet");
    expect(summary.activeSleep).not.toBeNull();
    expect(summary.activeSleep.endTime).toBeNull();
  });
});
