import { describe, expect, it } from "bun:test";
import { api, rig, setPlan } from "./helpers";

const iso = () => new Date().toISOString();

describe("free tier activity gates", () => {
  it("medicine create stays free", async () => {
    const { baby, cookie } = await rig();
    const res = await api("/api/medicine", {
      method: "POST",
      cookie,
      body: {
        babyId: baby.id,
        time: iso(),
        name: "D-vitamin",
        amount: 5,
        unit: "drops",
      },
    });
    expect(res.status).toBe(201);
  });

  it("bath create is 402 on free, 201 on premium; existing entries stay editable on free", async () => {
    const { family, baby, cookie } = await rig();
    const denied = await api("/api/baths", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, time: iso() },
    });
    expect(denied.status).toBe(402);
    expect(((await denied.json()) as { code: string }).code).toBe(
      "PLAN_REQUIRED",
    );

    await setPlan(family.id, "premium");
    const created = await api("/api/baths", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, time: iso() },
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    await setPlan(family.id, "free");
    const list = await api(`/api/baths?babyId=${baby.id}`, { cookie });
    expect(list.status).toBe(200);
    const patched = await api(`/api/baths/${id}`, {
      method: "PATCH",
      cookie,
      body: { time: iso() },
    });
    expect(patched.status).toBe(200);
    const removed = await api(`/api/baths/${id}`, { method: "DELETE", cookie });
    expect(removed.status).toBe(200);
  });

  it("all five gated kinds 402 on free", async () => {
    const { baby, cookie } = await rig();
    const bodies: Record<string, object> = {
      baths: {},
      notes: { content: "hei" },
      milestones: { title: "First smile" },
      measurements: { type: "weight", value: 5.2 },
      pumps: { amountMl: 90 },
    };
    for (const [kind, extra] of Object.entries(bodies)) {
      const res = await api(`/api/${kind}`, {
        method: "POST",
        cookie,
        body: { babyId: baby.id, time: iso(), ...extra },
      });
      expect(res.status, kind).toBe(402);
    }
  });
});

describe("baby limit", () => {
  it("second baby is 402 on free, allowed on premium; existing babies unaffected", async () => {
    const { family, cookie } = await rig(); // rig creates one baby already
    const denied = await api("/api/babies", {
      method: "POST",
      cookie,
      body: { name: "Second", birthDate: iso() },
    });
    expect(denied.status).toBe(402);
    expect(((await denied.json()) as { code: string }).code).toBe(
      "PLAN_REQUIRED",
    );

    await setPlan(family.id, "premium");
    const ok = await api("/api/babies", {
      method: "POST",
      cookie,
      body: { name: "Second", birthDate: iso() },
    });
    expect(ok.status).toBe(201);

    await setPlan(family.id, "free");
    const list = await api("/api/babies", { cookie });
    expect(((await list.json()) as unknown[]).length).toBe(2);
  });
});
