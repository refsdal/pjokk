import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import type { Plugin } from "vite";

// Security headers for everything served from the asset store. The Worker
// sets its own on /api/* and on the landing page at /, but assets — the SPA
// shell, /privacy, /terms, icons — only ever get these.
const BASE_HEADERS = `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: same-origin
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
`;

// robots.txt, sitemap.xml and _headers are static assets, and the Worker
// never sees requests for them (run_worker_first only names /api/* and /), so
// which ones ship has to be decided at build time. `pnpm deploy:test` sets
// CLOUDFLARE_ENV=test.
//
// _headers is generated here rather than kept in public/ because it differs
// per environment: only the test build carries the noindex header. Keeping a
// copy in public/ as well would race with this one for the same output path.
function staticFiles(): Plugin {
  const isProd = process.env.CLOUDFLARE_ENV !== "test";
  return {
    name: "pjokk-static-files",
    apply: "build",
    generateBundle() {
      // Cloudflare's Managed robots.txt PREPENDS its own `User-agent: *
      // Allow: /` group to whatever we serve. Crawlers merge same-agent
      // groups and, for rules of equal length, the least restrictive wins —
      // so our `Disallow: /` loses and robots.txt alone cannot keep the test
      // environment out of an index. X-Robots-Tag is the signal that
      // actually holds, and it means "do not index" rather than merely "do
      // not crawl". The Worker sets it on /; this covers every other path.
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source: isProd
          ? BASE_HEADERS
          : `${BASE_HEADERS}  X-Robots-Tag: noindex, nofollow\n`,
      });
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
    staticFiles(),
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
