import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import type { Plugin } from "vite";

// robots.txt is a static asset, and the Worker never sees requests for it
// (run_worker_first only names /api/* and /), so which one ships has to be
// decided at build time. `pnpm deploy:test` sets CLOUDFLARE_ENV=test.
function robots(): Plugin {
  const isProd = process.env.CLOUDFLARE_ENV !== "test";
  return {
    name: "pjokk-robots",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "robots.txt",
        source: isProd
          ? "User-agent: *\nAllow: /\n\nSitemap: https://pjokk.no/sitemap.xml\n"
          : "User-agent: *\nDisallow: /\n",
      });
      if (!isProd) return;
      // One public page; a hand-written sitemap is honest and cheaper than
      // generating one from a route tree that is entirely behind auth.
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>https://pjokk.no/</loc>
    <xhtml:link rel="alternate" hreflang="en" href="https://pjokk.no/?lang=en"/>
    <xhtml:link rel="alternate" hreflang="nb" href="https://pjokk.no/?lang=nb"/>
  </url>
  <url><loc>https://pjokk.no/privacy</loc></url>
  <url><loc>https://pjokk.no/terms</loc></url>
</urlset>
`,
      });
    },
  };
}

export default defineConfig({
  plugins: [
    robots(),
    react(),
    tailwindcss(),
    cloudflare(),
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
        // the Worker renders as the landing page. Without that second entry a
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
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
});
