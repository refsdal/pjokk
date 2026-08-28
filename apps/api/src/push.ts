import webpush from "web-push";
import { eq, inArray } from "drizzle-orm";
import type { Env } from "./config";
import type { Db } from "./db";
import { schema } from "./db";

// web-push does the aes128gcm + VAPID crypto (it ran under Workers'
// nodejs_compat and runs natively on Bun); we do the actual HTTP ourselves so
// we can act on the response: 404/410 mean the subscription is dead and must
// be deleted.

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

type SubRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

async function sendOne(
  env: Env,
  sub: SubRow,
  payload: PushPayload,
): Promise<"ok" | "gone" | "error"> {
  try {
    const details = webpush.generateRequestDetails(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      {
        vapidDetails: {
          // VAPID requires https: or mailto:; local dev runs on http.
          subject: env.APP_URL.startsWith("https:")
            ? env.APP_URL
            : "https://pjokk.no",
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKey: env.VAPID_PRIVATE_KEY,
        },
        TTL: 3600,
      },
    );
    const res = await fetch(details.endpoint, {
      method: details.method,
      headers: details.headers as Record<string, string>,
      body: details.body as Uint8Array<ArrayBuffer>,
    });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "ok" : "error";
  } catch (err) {
    console.warn("push send failed:", err);
    return "error";
  }
}

// Sends to every subscription of a user, pruning dead ones. Returns the
// number of successful deliveries.
export async function pushToUser(
  db: Db,
  env: Env,
  userId: string,
  payload: PushPayload,
): Promise<number> {
  const subs = await db
    .select({
      id: schema.pushSubscription.id,
      endpoint: schema.pushSubscription.endpoint,
      p256dh: schema.pushSubscription.p256dh,
      auth: schema.pushSubscription.auth,
    })
    .from(schema.pushSubscription)
    .where(eq(schema.pushSubscription.userId, userId));

  const results = await Promise.all(
    subs.map(async (sub) => ({
      sub,
      outcome: await sendOne(env, sub, payload),
    })),
  );

  const gone = results.filter((r) => r.outcome === "gone").map((r) => r.sub.id);
  if (gone.length > 0) {
    await db
      .delete(schema.pushSubscription)
      .where(inArray(schema.pushSubscription.id, gone));
  }
  return results.filter((r) => r.outcome === "ok").length;
}
