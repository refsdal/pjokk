import webpush from "web-push";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { schema } from "../db";
import type { PushPayload, PushSender } from "../ports";

// web-push does the aes128gcm + VAPID crypto (it ran under Workers'
// nodejs_compat and runs natively on Bun); we do the actual HTTP ourselves so
// we can act on the response: 404/410 mean the subscription is dead and must
// be deleted.

export type VapidConfig = {
  appUrl: string;
  publicKey: string;
  privateKey: string;
};

type SubRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

async function sendOne(
  cfg: VapidConfig,
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
          subject: cfg.appUrl.startsWith("https:")
            ? cfg.appUrl
            : "https://pjokk.no",
          publicKey: cfg.publicKey,
          privateKey: cfg.privateKey,
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
export function createPushSender(db: Db, cfg: VapidConfig): PushSender {
  return {
    async toUser(userId, payload) {
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
          outcome: await sendOne(cfg, sub, payload),
        })),
      );

      const gone = results
        .filter((r) => r.outcome === "gone")
        .map((r) => r.sub.id);
      if (gone.length > 0) {
        await db
          .delete(schema.pushSubscription)
          .where(inArray(schema.pushSubscription.id, gone));
      }
      return results.filter((r) => r.outcome === "ok").length;
    },
  };
}
