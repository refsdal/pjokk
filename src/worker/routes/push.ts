import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import {
  PushConfigSchema,
  PushPrefsSchema,
  PushTestResultSchema,
  SubscribeSchema,
  UnsubscribeSchema,
} from "@shared/schemas";
import type { FamEnv } from "../context";
import { schema } from "../db";
import { createApp, jsonContent } from "../lib";
import { pushToUser } from "../push";

const okSchema = z.object({ ok: z.literal(true) });

// SSRF guard (sec review M2): the worker later POSTs to stored endpoints on
// a schedule, so only real browser push services are accepted.
const ALLOWED_PUSH_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/, // Chrome/Chromium
  /(^|\.)push\.apple\.com$/, // Safari / iOS
  /(^|\.)push\.services\.mozilla\.com$/, // Firefox
  /(^|\.)mozaws\.net$/, // Firefox (legacy autopush)
  /(^|\.)notify\.windows\.com$/, // Edge (WNS)
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "https:" &&
      ALLOWED_PUSH_HOSTS.some((re) => re.test(url.hostname))
    );
  } catch {
    return false;
  }
}

const config = createRoute({
  method: "get",
  path: "/api/push/config",
  tags: ["push"],
  responses: {
    200: jsonContent(PushConfigSchema, "VAPID public key"),
  },
});

const subscribe = createRoute({
  method: "post",
  path: "/api/push/subscribe",
  tags: ["push"],
  description:
    "Register this browser's push subscription for the signed-in caretaker. Upserts by endpoint.",
  request: {
    body: { content: { "application/json": { schema: SubscribeSchema } } },
  },
  responses: {
    200: jsonContent(okSchema, "Stored"),
    400: jsonContent(
      z.object({ error: z.string(), code: z.string().optional() }),
      "Not a recognized push service endpoint",
    ),
  },
});

const unsubscribe = createRoute({
  method: "post",
  path: "/api/push/unsubscribe",
  tags: ["push"],
  request: {
    body: { content: { "application/json": { schema: UnsubscribeSchema } } },
  },
  responses: {
    200: jsonContent(okSchema, "Removed (if it was yours)"),
  },
});

const getPrefs = createRoute({
  method: "get",
  path: "/api/push/prefs",
  tags: ["push"],
  responses: {
    200: jsonContent(PushPrefsSchema, "Notification preferences"),
  },
});

const putPrefs = createRoute({
  method: "put",
  path: "/api/push/prefs",
  tags: ["push"],
  request: {
    body: { content: { "application/json": { schema: PushPrefsSchema } } },
  },
  responses: {
    200: jsonContent(PushPrefsSchema, "Updated preferences"),
  },
});

const test = createRoute({
  method: "post",
  path: "/api/push/test",
  tags: ["push"],
  description: "Send a test notification to all of the caller's devices.",
  responses: {
    200: jsonContent(PushTestResultSchema, "Delivery count"),
  },
});

export const pushApp = createApp<FamEnv>()
  .openapi(config, (c) => {
    return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY }, 200);
  })
  .openapi(subscribe, async (c) => {
    const body = c.req.valid("json");
    if (!isAllowedPushEndpoint(body.endpoint)) {
      return c.json(
        { error: "Unrecognized push service", code: "BAD_ENDPOINT" },
        400,
      );
    }
    const userId = c.var.sessionData.user.id;
    await c.var.db
      .insert(schema.pushSubscription)
      .values({
        familyId: c.var.familyId,
        userId,
        endpoint: body.endpoint,
        p256dh: body.p256dh,
        auth: body.auth,
      })
      .onConflictDoUpdate({
        target: schema.pushSubscription.endpoint,
        set: {
          userId,
          familyId: c.var.familyId,
          p256dh: body.p256dh,
          auth: body.auth,
        },
      });
    return c.json({ ok: true as const }, 200);
  })
  .openapi(unsubscribe, async (c) => {
    const body = c.req.valid("json");
    await c.var.db
      .delete(schema.pushSubscription)
      .where(
        and(
          eq(schema.pushSubscription.endpoint, body.endpoint),
          eq(schema.pushSubscription.userId, c.var.sessionData.user.id),
        ),
      );
    return c.json({ ok: true as const }, 200);
  })
  .openapi(getPrefs, async (c) => {
    const rows = await c.var.db
      .select()
      .from(schema.pushPref)
      .where(
        and(
          eq(schema.pushPref.userId, c.var.sessionData.user.id),
          eq(schema.pushPref.familyId, c.var.familyId),
        ),
      );
    const hours = rows[0]?.feedReminderHours ?? 0;
    return c.json(
      {
        feedReminderHours: (hours === 3 || hours === 4 || hours === 6
          ? hours
          : 0) as 0 | 3 | 4 | 6,
      },
      200,
    );
  })
  .openapi(putPrefs, async (c) => {
    const body = c.req.valid("json");
    await c.var.db
      .insert(schema.pushPref)
      .values({
        userId: c.var.sessionData.user.id,
        familyId: c.var.familyId,
        feedReminderHours: body.feedReminderHours,
        // A new setting starts a fresh observation window.
        lastRemindedAt: null,
      })
      .onConflictDoUpdate({
        target: [schema.pushPref.userId, schema.pushPref.familyId],
        set: {
          feedReminderHours: body.feedReminderHours,
          lastRemindedAt: null,
        },
      });
    return c.json({ feedReminderHours: body.feedReminderHours }, 200);
  })
  .openapi(test, async (c) => {
    const sent = await pushToUser(c.var.db, c.env, c.var.sessionData.user.id, {
      title: "Pjokk",
      body: "Push works on this device ✅",
      url: "/",
    });
    return c.json({ sent }, 200);
  });
