import { describe, expect, it } from "vitest";
import { api, rig } from "./helpers";
import { setPlan } from "./billing.test";
import { SELF } from "cloudflare:test";

const keyApi = (
  path: string,
  key: string,
  opts: { method?: string; body?: unknown } = {},
) =>
  SELF.fetch(`http://localhost${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

describe("api keys", () => {
  it("admin creates a key; the raw key appears exactly once", async () => {
    const a = await rig();
    await setPlan(a.family.id, "premium");
    const res = await api("/api/keys", {
      method: "POST",
      cookie: a.cookie,
      body: { name: "Home Assistant" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { key: string; prefix: string };
    expect(created.key.startsWith("pjk_")).toBe(true);
    expect(created.key.startsWith(created.prefix)).toBe(true);

    const list = (await (
      await api("/api/keys", { cookie: a.cookie })
    ).json()) as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("Home Assistant");
    expect("key" in list[0]!).toBe(false);
  });

  it("keys read and write logs, attributed to the creator", async () => {
    const a = await rig();
    await setPlan(a.family.id, "premium");
    const { key } = (await (
      await api("/api/keys", {
        method: "POST",
        cookie: a.cookie,
        body: { name: "HA" },
      })
    ).json()) as { key: string };

    const post = await keyApi("/api/feeds", key, {
      method: "POST",
      body: {
        babyId: a.baby.id,
        time: new Date().toISOString(),
        type: "bottle",
        amountMl: 140,
      },
    });
    expect(post.status).toBe(201);
    expect(
      ((await post.json()) as { caretakerName: string }).caretakerName,
    ).toBe("Rig admin");

    const summary = await keyApi(`/api/summary?babyId=${a.baby.id}`, key);
    expect(summary.status).toBe(200);
    expect(
      ((await summary.json()) as { lastFeed: { amountMl: number } }).lastFeed
        .amountMl,
    ).toBe(140);
  });

  it("keys are refused by admin and device-bound endpoints", async () => {
    const a = await rig();
    await setPlan(a.family.id, "premium");
    const { key } = (await (
      await api("/api/keys", {
        method: "POST",
        cookie: a.cookie,
        body: { name: "HA" },
      })
    ).json()) as { key: string };

    expect(
      (await keyApi("/api/keys", key, { method: "POST", body: { name: "x" } }))
        .status,
    ).toBe(403);
    expect(
      (await keyApi("/api/invites", key, { method: "POST", body: {} })).status,
    ).toBe(403);
    expect(
      (await keyApi("/api/push/test", key, { method: "POST", body: {} }))
        .status,
    ).toBe(403);
  });

  it("read-only keys can read but not write; expired keys are refused", async () => {
    const a = await rig();
    await setPlan(a.family.id, "premium");
    const ro = (await (
      await api("/api/keys", {
        method: "POST",
        cookie: a.cookie,
        body: { name: "Grafana", readOnly: true },
      })
    ).json()) as { key: string };
    expect((await keyApi("/api/babies", ro.key)).status).toBe(200);
    expect(
      (
        await keyApi("/api/feeds", ro.key, {
          method: "POST",
          body: {
            babyId: a.baby.id,
            time: new Date().toISOString(),
            type: "bottle",
          },
        })
      ).status,
    ).toBe(403);

    const shortLived = (await (
      await api("/api/keys", {
        method: "POST",
        cookie: a.cookie,
        body: { name: "Ephemeral", expiresInDays: 1 },
      })
    ).json()) as { id: string; key: string };
    expect((await keyApi("/api/babies", shortLived.key)).status).toBe(200);
    // Force-expire it.
    const { schema } = await import("../src/worker/db");
    const { eq } = await import("drizzle-orm");
    const { db } = await import("./helpers");
    await db()
      .update(schema.apiKey)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.apiKey.id, shortLived.id));
    expect((await keyApi("/api/babies", shortLived.key)).status).toBe(401);
  });

  it("revoked and bogus keys get 401", async () => {
    const a = await rig();
    await setPlan(a.family.id, "premium");
    const created = (await (
      await api("/api/keys", {
        method: "POST",
        cookie: a.cookie,
        body: { name: "HA" },
      })
    ).json()) as { id: string; key: string };

    expect((await keyApi("/api/babies", created.key)).status).toBe(200);
    await api(`/api/keys/${created.id}`, {
      method: "DELETE",
      cookie: a.cookie,
    });
    expect((await keyApi("/api/babies", created.key)).status).toBe(401);
    expect((await keyApi("/api/babies", "pjk_bogus")).status).toBe(401);
  });
});

describe("baby sex", () => {
  it("patches sex and reflects it in responses", async () => {
    const a = await rig();
    const patch = await api(`/api/babies/${a.baby.id}`, {
      method: "PATCH",
      cookie: a.cookie,
      body: { sex: "girl" },
    });
    expect(patch.status).toBe(200);
    const babies = (await (
      await api("/api/babies", { cookie: a.cookie })
    ).json()) as { sex: string | null }[];
    expect(babies[0]!.sex).toBe("girl");
  });
});
