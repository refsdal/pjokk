import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  BACKUP_RETENTION_DAYS,
  pruneBackups,
  runBackup,
} from "../src/worker/scheduled";
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
    await api("/api/sleep-locations", {
      method: "POST",
      cookie: a.cookie,
      body: { name: "Hammock" },
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
    expect(snapshot.tables.sleep_location).toHaveLength(1);
    expect(
      (snapshot.tables.sleep_location as { name: string }[])[0]!.name,
    ).toBe("Hammock");
  });
});

describe("backup retention", () => {
  const put = (key: string) => env.FILES.put(key, "{}");
  const listKeys = async () =>
    (await env.FILES.list({ prefix: "backups/" })).objects
      .map((o) => o.key)
      .sort();

  it("deletes snapshots past the retention window and keeps the rest", async () => {
    const now = new Date("2026-08-27T03:15:00Z");
    const day = (offset: number) =>
      new Date(now.getTime() - offset * 24 * 3600_000)
        .toISOString()
        .slice(0, 10);

    // Well inside, exactly on the edge, and well outside the window.
    const fresh = `backups/${day(1)}.json`;
    const edge = `backups/${day(BACKUP_RETENTION_DAYS - 1)}.json`;
    const stale = `backups/${day(BACKUP_RETENTION_DAYS + 1)}.json`;
    const ancient = "backups/2020-01-01.json";
    for (const k of [fresh, edge, stale, ancient]) await put(k);

    const removed = await pruneBackups(env, now);

    expect(removed.sort()).toEqual([ancient, stale].sort());
    const left = await listKeys();
    expect(left).toContain(fresh);
    expect(left).toContain(edge);
    expect(left).not.toContain(stale);
    expect(left).not.toContain(ancient);
  });

  it("never touches anything outside the backups prefix", async () => {
    const now = new Date("2026-08-27T03:15:00Z");
    // A vaccine document is far older than the window and must survive:
    // retention applies to snapshots, not to a family's own files.
    await env.FILES.put("vaccine-docs/fam_x/some-file", "not a backup");
    await put("backups/2019-05-05.json");

    const removed = await pruneBackups(env, now);

    expect(removed).toEqual(["backups/2019-05-05.json"]);
    expect(await env.FILES.get("vaccine-docs/fam_x/some-file")).not.toBeNull();
  });

  it("is a no-op when every snapshot is recent", async () => {
    const now = new Date("2026-08-27T03:15:00Z");
    await put("backups/2026-08-26.json");
    expect(await pruneBackups(env, now)).toEqual([]);
  });
});
