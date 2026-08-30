import { api, db, deps, rig } from "./helpers";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "../src/db";
import { runReminders } from "../src/jobs/reminders";

// A plausible browser subscription (P-256 public key + auth secret).
const SUB_KEYS = {
  p256dh:
    "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

const PUSH_ORIGIN = "https://fcm.googleapis.com";

// The main worker runs in the same isolate as the tests (pool-workers), so
// stubbing global fetch intercepts the worker's outbound push deliveries.
const delivered: string[] = [];
const statusByUrl = new Map<string, number>();
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith(PUSH_ORIGIN)) {
      delivered.push(url);
      return new Response("", { status: statusByUrl.get(url) ?? 201 });
    }
    return realFetch(input as never, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  delivered.length = 0;
  statusByUrl.clear();
});

async function subscribe(cookie: string, endpoint: string) {
  const res = await api("/api/push/subscribe", {
    method: "POST",
    cookie,
    body: { endpoint, ...SUB_KEYS },
  });
  expect(res.status).toBe(200);
}

describe("web push", () => {
  it("rejects endpoints that aren't a known push service (SSRF guard)", async () => {
    const a = await rig();
    for (const endpoint of [
      "https://evil.example.com/exfil",
      "http://fcm.googleapis.com/downgrade",
      "https://fcm.googleapis.com.evil.com/x",
    ]) {
      const res = await api("/api/push/subscribe", {
        method: "POST",
        cookie: a.cookie,
        body: { endpoint, ...SUB_KEYS },
      });
      expect(res.status).toBe(400);
    }
  });

  it("stores, re-binds and removes subscriptions", async () => {
    const a = await rig();
    const endpoint = `${PUSH_ORIGIN}/sub/one`;
    await subscribe(a.cookie, endpoint);
    await subscribe(a.cookie, endpoint); // idempotent upsert

    const rows = await db()
      .select()
      .from(schema.pushSubscription)
      .where(eq(schema.pushSubscription.endpoint, endpoint));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(a.user.id);

    const un = await api("/api/push/unsubscribe", {
      method: "POST",
      cookie: a.cookie,
      body: { endpoint },
    });
    expect(un.status).toBe(200);
    expect(
      await db()
        .select()
        .from(schema.pushSubscription)
        .where(eq(schema.pushSubscription.endpoint, endpoint)),
    ).toHaveLength(0);
  });

  it("serves the VAPID public key", async () => {
    const a = await rig();
    const res = await api("/api/push/config", { cookie: a.cookie });
    const { publicKey } = (await res.json()) as { publicKey: string };
    expect(publicKey.length).toBeGreaterThan(60);
  });

  it("prefs roundtrip", async () => {
    const a = await rig();
    expect(
      (await (await api("/api/push/prefs", { cookie: a.cookie })).json()) as {
        feedReminderHours: number;
      },
    ).toEqual({ feedReminderHours: 0 });
    await api("/api/push/prefs", {
      method: "PUT",
      cookie: a.cookie,
      body: { feedReminderHours: 4 },
    });
    expect(
      (await (await api("/api/push/prefs", { cookie: a.cookie })).json()) as {
        feedReminderHours: number;
      },
    ).toEqual({ feedReminderHours: 4 });
  });

  it("test push delivers to live endpoints; 410 prunes the subscription", async () => {
    const a = await rig();
    await subscribe(a.cookie, `${PUSH_ORIGIN}/sub/live`);
    await subscribe(a.cookie, `${PUSH_ORIGIN}/sub/dead`);
    statusByUrl.set(`${PUSH_ORIGIN}/sub/dead`, 410);

    const res = await api("/api/push/test", {
      method: "POST",
      cookie: a.cookie,
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { sent: number }).toEqual({ sent: 1 });
    expect(delivered.sort()).toEqual([
      `${PUSH_ORIGIN}/sub/dead`,
      `${PUSH_ORIGIN}/sub/live`,
    ]);

    // The dead endpoint was cleaned up, the live one kept.
    const remaining = await db()
      .select({ endpoint: schema.pushSubscription.endpoint })
      .from(schema.pushSubscription)
      .where(eq(schema.pushSubscription.userId, a.user.id));
    expect(remaining.map((r) => r.endpoint)).toEqual([
      `${PUSH_ORIGIN}/sub/live`,
    ]);
  });

  it("feed reminders: one nudge per gap, reset by a new feed", async () => {
    const a = await rig();
    await subscribe(a.cookie, `${PUSH_ORIGIN}/sub/remind`);
    await api("/api/push/prefs", {
      method: "PUT",
      cookie: a.cookie,
      body: { feedReminderHours: 3 },
    });

    const now = Date.now();
    const feedAt = (msAgo: number) =>
      api("/api/feeds", {
        method: "POST",
        cookie: a.cookie,
        body: {
          babyId: a.baby.id,
          time: new Date(now - msAgo).toISOString(),
          type: "bottle",
          amountMl: 100,
        },
      });

    // Last feed 2h ago: below the 3h threshold — nothing sent.
    await feedAt(2 * 3600_000);
    expect(await runReminders(deps, now)).toBe(0);
    expect(delivered).toHaveLength(0);

    // 4h later the gap exceeds 3h: exactly one push.
    const later = now + 4 * 3600_000;
    expect(await runReminders(deps, later)).toBe(1);
    expect(delivered).toHaveLength(1);

    // Same gap, next cron run: already reminded — silent.
    expect(await runReminders(deps, later + 15 * 60_000)).toBe(0);
    expect(delivered).toHaveLength(1);

    // A new feed starts a new gap; once IT exceeds 3h, remind again.
    await feedAt(-(4.2 * 3600_000)); // logged at now+4.2h
    const evenLater = now + 8 * 3600_000;
    expect(await runReminders(deps, evenLater)).toBe(1);
    expect(delivered).toHaveLength(2);
  });
});
