import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runBackup } from "../src/worker/scheduled";
import { api, rig } from "./helpers";

describe("nightly backup", () => {
  it("writes a dated JSON snapshot of every table to R2", async () => {
    const a = await rig();
    await api("/api/feeds", {
      method: "POST",
      cookie: a.cookie,
      body: {
        babyId: a.baby.id,
        time: new Date().toISOString(),
        type: "bottle",
        amountMl: 130,
      },
    });

    const key = await runBackup(env, new Date("2026-08-24T03:15:00Z"));
    expect(key).toBe("backups/2026-08-24.json");

    const obj = await env.FILES.get(key);
    expect(obj).not.toBeNull();
    const snapshot = JSON.parse(await obj!.text()) as {
      exportedAt: string;
      tables: Record<string, unknown[]>;
    };
    expect(snapshot.tables.user!.length).toBeGreaterThan(0);
    expect(snapshot.tables.feed_log).toHaveLength(1);
    expect(Object.keys(snapshot.tables)).toContain("push_subscription");
  });
});
