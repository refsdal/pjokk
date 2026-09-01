import { client, unwrap } from "./api";

// Web push behind a small interface (CLAUDE.md): the native shell later
// implements the same enable/disable/status contract with device tokens.

export function pushSupported(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(
    (base64 + padding).replaceAll("-", "+").replaceAll("_", "/"),
  );
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function enablePush(): Promise<void> {
  const { publicKey } = await unwrap<{ publicKey: string }>(
    client.GET("/api/push/config"),
  );
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications were not allowed");
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error("Browser returned an incomplete subscription");
  }
  await unwrap(
    client.POST("/api/push/subscribe", {
      body: {
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      },
    }),
  );
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await unwrap(
    client.POST("/api/push/unsubscribe", {
      body: { endpoint: sub.endpoint },
    }),
  );
  await sub.unsubscribe();
}

export async function sendTestPush(): Promise<number> {
  const { sent } = await unwrap<{ sent: number }>(
    client.POST("/api/push/test"),
  );
  return sent;
}
