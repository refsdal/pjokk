import { env } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "../src/worker/db";
import { runCalendarReminders } from "../src/worker/scheduled";
import {
  addMember,
  api,
  createUser,
  db,
  rig,
  setPlan,
  signIn,
} from "./helpers";

const SUB_KEYS = {
  p256dh:
    "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};
const PUSH_ORIGIN = "https://fcm.googleapis.com";
const HOUR = 3600_000;

const delivered: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith(PUSH_ORIGIN)) {
      delivered.push(url);
      return new Response("", { status: 201 });
    }
    return realFetch(input as never, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  delivered.length = 0;
});

async function subscribe(cookie: string, endpoint: string) {
  const res = await api("/api/push/subscribe", {
    method: "POST",
    cookie,
    body: { endpoint, ...SUB_KEYS },
  });
  expect(res.status).toBe(200);
}

async function createEvent(
  cookie: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await api("/api/calendar/events", {
    method: "POST",
    cookie,
    body,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("calendar reminders", () => {
  it("fires once inside the window, to all members when unassigned", async () => {
    const a = await rig();
    await setPlan(a.family.id, "premium");
    await subscribe(a.cookie, `${PUSH_ORIGIN}/cal/admin`);
    const other = await createUser("Other parent");
    await addMember(other.id, a.family.id, "member");
    const otherCookie = await signIn(other.email);
    await subscribe(otherCookie, `${PUSH_ORIGIN}/cal/other`);

    const now = Date.now();
    await createEvent(a.cookie, {
      title: "Checkup",
      startTime: new Date(now + 30 * 60_000).toISOString(),
      remindMinutesBefore: 60,
    });

    // Inside the lead window: one push per member, then silence.
    expect(await runCalendarReminders(env, now)).toBe(2);
    expect(delivered.sort()).toEqual([
      `${PUSH_ORIGIN}/cal/admin`,
      `${PUSH_ORIGIN}/cal/other`,
    ]);
    expect(await runCalendarReminders(env, now + 15 * 60_000)).toBe(0);
  });

  it("targets only assignees when set", async () => {
    const a = await rig();
    await setPlan(a.family.id, "premium");
    await subscribe(a.cookie, `${PUSH_ORIGIN}/cal2/admin`);
    const other = await createUser("Other parent");
    await addMember(other.id, a.family.id, "member");
    const otherCookie = await signIn(other.email);
    await subscribe(otherCookie, `${PUSH_ORIGIN}/cal2/other`);

    const now = Date.now();
    await createEvent(a.cookie, {
      title: "Babysitting",
      startTime: new Date(now + 30 * 60_000).toISOString(),
      remindMinutesBefore: 60,
      assigneeUserIds: [other.id],
    });
    expect(await runCalendarReminders(env, now)).toBe(1);
    expect(delivered).toEqual([`${PUSH_ORIGIN}/cal2/other`]);
  });

  it("not yet due → nothing; long-past → latched silently", async () => {
    const a = await rig();
    await setPlan(a.family.id, "premium");
    await subscribe(a.cookie, `${PUSH_ORIGIN}/cal3/admin`);

    const now = Date.now();
    const notDue = await createEvent(a.cookie, {
      title: "Far future",
      startTime: new Date(now + 10 * HOUR).toISOString(),
      remindMinutesBefore: 60,
    });
    const past = await createEvent(a.cookie, {
      title: "Missed",
      startTime: new Date(now + HOUR).toISOString(),
      remindMinutesBefore: 60,
    });
    // Simulate downtime: the sweep first runs 2h after the past event started.
    expect(await runCalendarReminders(env, now + 3 * HOUR)).toBe(0);
    expect(delivered).toHaveLength(0);

    const rows = await db()
      .select({
        id: schema.calendarEvent.id,
        remindedAt: schema.calendarEvent.remindedAt,
      })
      .from(schema.calendarEvent)
      .where(eq(schema.calendarEvent.familyId, a.family.id));
    expect(rows.find((r) => r.id === past)!.remindedAt).not.toBeNull();
    expect(rows.find((r) => r.id === notDue)!.remindedAt).toBeNull();
  });
});
