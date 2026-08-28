import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

// Builds the SPA only. The server is not bundled: Bun runs the TypeScript in
// src/server directly, so there is no build step for it and no
// @cloudflare/vite-plugin to stitch the two halves together.
//
// robots.txt, sitemap.xml and the security headers used to be emitted here,
// keyed on CLOUDFLARE_ENV — which is why production and test needed separate
// builds of the same commit. They are served by the app now (see
// src/server/index.ts and src/server/main.ts), so this output is
// environment-independent and one image can be promoted between them.
export default defineConfig({
  build: {
    // Where main.ts serves static files from (STATIC_DIR).
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    // @cloudflare/vite-plugin used to run the Worker inside the dev server,
    // so one origin served both halves. Now `bun run dev:server` runs the API
    // on 3000 and these paths are proxied to it, which keeps the client's
    // same-origin assumption (and its cookies) working in development.
    proxy: {
      "/api": "http://localhost:3000",
      "/healthz": "http://localhost:3000",
      "/readyz": "http://localhost:3000",
      "/robots.txt": "http://localhost:3000",
      "/sitemap.xml": "http://localhost:3000",
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Pjokk",
        short_name: "Pjokk",
        description: "Family baby tracker",
        lang: "en",
        display: "standalone",
        orientation: "portrait",
        // An installed app opens the app, never the marketing page at "/".
        start_url: "/home",
        background_color: "#faf9f7",
        theme_color: "#faf9f7",
        icons: [
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "icon-maskable.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        // Push + notification-click handlers live beside the generated SW.
        importScripts: ["push-sw.js"],
        // The SPA shell must never swallow API/auth routes — nor "/", which
        // the server renders as the landing page. Without that second entry a
        // registered service worker would answer the root from the precached
        // app shell and the landing page would never be seen again.
        navigateFallbackDenylist: [/^\/api\//, /^\/$/],
        runtimeCaching: [
          {
            // Never cache auth; NetworkFirst for other API GETs so the
            // timeline/home render offline from the last known state.
            urlPattern: ({ url, request }) =>
              url.pathname.startsWith("/api/") &&
              !url.pathname.startsWith("/api/auth") &&
              request.method === "GET",
            handler: "NetworkFirst",
            options: {
              cacheName: "api-get",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 14 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/web"),
    },
  },
});
