import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

// Builds the SPA only. The server is not bundled: Bun runs the TypeScript in
// apps/api and apps/server directly, so there is no build step for it and no
// @cloudflare/vite-plugin to stitch the two halves together.
//
// robots.txt and the security headers used to be emitted here, keyed on
// CLOUDFLARE_ENV — which is why production and test needed separate builds
// of the same commit. robots.txt and the security headers are served by the
// app now (see apps/api/src/app.ts and apps/server/src/main.ts), so this
// output is environment-independent and one image can be promoted between
// them. sitemap.xml no longer lives here at all: the app host is entirely
// behind auth and has nothing to index, so the sitemap moved with the rest
// of the public site to apps/landing.
export default defineConfig({
  // The public apex the SPA links its legal pages to (see lib/site.ts). A
  // plain define, not import.meta.env.VITE_*, because it comes from the same
  // SITE_URL variable the server validates (apps/server/src/env.ts) and is
  // baked into the client bundle at build time, not read at runtime.
  define: {
    __SITE_URL__: JSON.stringify(process.env.SITE_URL ?? "https://pjokk.no"),
  },
  build: {
    // Where main.ts serves static files from (STATIC_DIR).
    outDir: "../../dist/client",
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
        // The SPA shell must never swallow API/auth routes. "/" used to be
        // denylisted too, back when the server rendered a landing page there
        // — but on app.pjokk.no "/" IS the app, so denylisting it would send
        // root navigations to the network and break offline use at the
        // app's own entry point, defeating the point of precaching the shell.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Never cache identity — auth (Limen) or /api/me. GET /api/me
            // decides routing (active family, /welcome vs /home); a cached
            // copy served after a family is created bounces the founder back
            // to /welcome. (In the better-auth era session identity lived
            // under /api/auth/*, which this exclusion already covered; the
            // Go port moved it to the top-level /api/me, so it needs naming
            // explicitly — exact match, or /api/medicine and
            // /api/measurements would be excluded too.) NetworkFirst for
            // other API GETs so the timeline/home render offline from the
            // last known state.
            urlPattern: ({ url, request }) =>
              url.pathname.startsWith("/api/") &&
              !url.pathname.startsWith("/api/auth") &&
              url.pathname !== "/api/me" &&
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
      "@": path.resolve(__dirname, "src"),
    },
  },
});
