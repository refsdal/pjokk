import { describe, expect, it } from "vitest";
import { api, rig } from "./helpers";

describe("per-side nursing minutes", () => {
  it("stores and returns leftMin/rightMin on breast feeds", async () => {
    const { baby, cookie } = await rig();
    const res = await api("/api/feeds", {
      method: "POST",
      cookie,
      body: {
        babyId: baby.id,
        time: new Date().toISOString(),
        type: "breast",
        side: "both",
        durationMin: 25,
        leftMin: 10,
        rightMin: 15,
      },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      leftMin: number | null;
      rightMin: number | null;
    };
    expect(created.leftMin).toBe(10);
    expect(created.rightMin).toBe(15);
  });
});
