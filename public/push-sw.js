// Imported into the generated Workbox service worker (vite-plugin-pwa
// workbox.importScripts). Handles incoming web push + notification taps.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // non-JSON payload
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Pjokk", {
      body: data.body || "",
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        for (const client of windows) {
          if ("focus" in client) return client.focus();
        }
        return self.clients.openWindow(event.notification.data?.url || "/");
      }),
  );
});
