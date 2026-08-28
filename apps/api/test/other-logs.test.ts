import { describe, expect, it } from "bun:test";
import { api, rig, setPlan } from "./helpers";
import type { Timeline } from "@pjokk/shared";

// The six Phase 3 types share one generic CRUD + route factory. Medicine is
// exercised deeply; the rest get a create/read pass through the same code
// path, plus timeline integration.

describe("phase 3 activity types", () => {
  it("medicine: full CRUD with null-to-clear patches, family-scoped", async () => {
    const a = await rig("Family A");
    const b = await rig("Family B");

    const created = await api("/api/medicine", {
      method: "POST",
      cookie: a.cookie,
      body: {
        babyId: a.baby.id,
        time: new Date().toISOString(),
        name: "Paracet",
        amount: 2.5,
        unit: "ml",
        notes: "before bed",
      },
    });
    expect(created.status).toBe(201);
    const med = (await created.json()) as {
      id: string;
      name: string;
      caretakerName: string;
    };
    expect(med.name).toBe("Paracet");
    expect(med.caretakerName).toBe("Rig admin");

    // Cross-family: B sees nothing and cannot touch it.
    const bList = (await (
      await api("/api/medicine", { cookie: b.cookie })
    ).json()) as unknown[];
    expect(bList).toHaveLength(0);
    expect(
      (
        await api(`/api/medicine/${med.id}`, {
          method: "PATCH",
          cookie: b.cookie,
          body: { name: "hijack" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(`/api/medicine/${med.id}`, {
          method: "DELETE",
          cookie: b.cookie,
        })
      ).status,
    ).toBe(404);

    // Patch: change name, clear amount/unit/notes.
    const patched = await api(`/api/medicine/${med.id}`, {
      method: "PATCH",
      cookie: a.cookie,
      body: { name: "Ibux", amount: null, unit: null, notes: null },
    });
    expect(patched.status).toBe(200);
    const after = (await patched.json()) as {
      name: string;
      amount: number | null;
      notes: string | null;
    };
    expect(after.name).toBe("Ibux");
    expect(after.amount).toBeNull();
    expect(after.notes).toBeNull();

    // Logging against another family's baby is refused.
    expect(
      (
        await api("/api/medicine", {
          method: "POST",
          cookie: b.cookie,
          body: {
            babyId: a.baby.id,
            time: new Date().toISOString(),
            name: "nope",
          },
        })
      ).status,
    ).toBe(404);

    // Delete.
    expect(
      (
        await api(`/api/medicine/${med.id}`, {
          method: "DELETE",
          cookie: a.cookie,
        })
      ).status,
    ).toBe(200);
    const list = (await (
      await api("/api/medicine", { cookie: a.cookie })
    ).json()) as unknown[];
    expect(list).toHaveLength(0);
  });

  it("all six types create and land on the timeline (other filter)", async () => {
    const a = await rig();
    // Five of the six kinds are gated (otherActivities, Task 1 entitlement
    // rework); medicine is exempt. This test is about the CRUD/timeline
    // wiring, not the plan gate, so lift the family to premium first.
    await setPlan(a.family.id, "premium");
    const now = Date.now();
    const at = (minAgo: number) =>
      new Date(now - minAgo * 60_000).toISOString();
    const post = async (path: string, body: Record<string, unknown>) => {
      const res = await api(path, { method: "POST", cookie: a.cookie, body });
      expect(res.status).toBe(201);
    };

    await post("/api/medicine", {
      babyId: a.baby.id,
      time: at(60),
      name: "D-vitamin",
      amount: 5,
      unit: "drops",
    });
    await post("/api/baths", { babyId: a.baby.id, time: at(50) });
    await post("/api/notes", {
      babyId: a.baby.id,
      time: at(40),
      content: "First taste of banana — big fan.",
    });
    await post("/api/milestones", {
      babyId: a.baby.id,
      time: at(30),
      title: "Stood unsupported",
    });
    await post("/api/measurements", {
      babyId: a.baby.id,
      time: at(20),
      type: "weight",
      value: 8.4,
    });
    await post("/api/pumps", {
      babyId: a.baby.id,
      time: at(10),
      side: "left",
      amountMl: 90,
      durationMin: 15,
    });
    // One core entry to prove mixing.
    await post("/api/feeds", {
      babyId: a.baby.id,
      time: at(5),
      type: "bottle",
      amountMl: 120,
    });

    const all = (await (
      await api(`/api/timeline?babyId=${a.baby.id}`, { cookie: a.cookie })
    ).json()) as Timeline;
    expect(all.entries.map((e) => e.kind)).toEqual([
      "feed",
      "pump",
      "measurement",
      "milestone",
      "note",
      "bath",
      "medicine",
    ]);

    const other = (await (
      await api(`/api/timeline?babyId=${a.baby.id}&filter=other`, {
        cookie: a.cookie,
      })
    ).json()) as Timeline;
    expect(other.entries).toHaveLength(6);
    expect(other.entries.some((e) => e.kind === "feed")).toBe(false);
    const milestone = other.entries.find((e) => e.kind === "milestone");
    expect(milestone && "title" in milestone && milestone.title).toBe(
      "Stood unsupported",
    );
    const measurement = other.entries.find((e) => e.kind === "measurement");
    expect(measurement && "value" in measurement && measurement.value).toBe(
      8.4,
    );
  });
});
