// Imported into the generated Workbox service worker (vite-plugin-pwa
// workbox.importScripts). Handles incoming web push + notification taps.
//
// The payload is internal/push's PushPayload: {title, body, url, actions?}
// where each action is {action, title, url}. Actions become the
// notification's buttons where the platform shows them (Android, desktop
// Chrome); elsewhere the field is ignored and a tap opens `url`.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // non-JSON payload
  }
  const actions = Array.isArray(data.actions) ? data.actions : [];
  event.waitUntil(
    self.registration.showNotification(data.title || "Pjokk", {
      body: data.body || "",
      icon: "/icon.svg",
      badge: "/icon.svg",
      actions: actions.map((a) => ({ action: a.action, title: a.title })),
      // "/" is the public landing page — a notification must open the app.
      data: {
        url: data.url || "/home",
        actions: actions.map((a) => ({ action: a.action, url: a.url })),
      },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const picked = (data.actions || []).find((a) => a.action === event.action);
  // A button carries its own deep link (e.g. /home?log=feed); the body tap
  // keeps the notification's url.
  const url = (picked && picked.url) || data.url || "/home";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        for (const client of windows) {
          if ("focus" in client) {
            // A button means "take me to that sheet", so the open window
            // navigates; a plain tap just comes to the front as before.
            if (picked && "navigate" in client) {
              return client.focus().then((c) => c.navigate(url));
            }
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
