import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

export default defineConfig({
  plugins: [
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
        start_url: "/",
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
        // The SPA shell must never swallow API/auth routes.
        navigateFallbackDenylist: [/^\/api\//],
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
