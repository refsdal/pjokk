import { serveStatic } from "hono/bun";
import { disabledSubsystems, loadEnv } from "@pjokk/api/config";
import type { Bindings } from "@pjokk/api/context";
import { startScheduler } from "@pjokk/api/cron";
import { app } from "@pjokk/api";
import { servicesFor } from "@pjokk/api/services";

// The container entrypoint. index.ts owns the API and the landing page —
// everything testable without a filesystem — and this file adds the parts
// that only make sense in a running process: static assets, the SPA
// fallback, the listener, and optionally the in-process scheduler.

const env = loadEnv(process.env);

// ONE object for the whole process. servicesFor() memoizes on its identity,
// so rebuilding it per request would rebuild the connection pool every time.
// `server` is filled in below, once Bun.serve has returned a handle.
const bindings: Bindings = { ...env };

// Security headers for everything served from disk. On Cloudflare these came
// from a generated `_headers` file that only the asset store understood; off
// it, nothing applies them, so the SPA would ship with no CSP at all. The
// landing page and /api/* set their own (tighter, and JSON-appropriate)
// headers, so this deliberately does not touch them.
app.use("/*", async (c, next) => {
  await next();
  if (c.req.path === "/" || c.req.path.startsWith("/api/")) return;
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "same-origin");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (env.INDEXABLE !== "1") c.header("X-Robots-Tag", "noindex, nofollow");
});

// Built SPA assets. Registered after every route in index.ts, so the landing
// page, the API and the health checks all win — the ordering that
// `run_worker_first` used to express in wrangler.jsonc.
app.use("/*", serveStatic({ root: env.STATIC_DIR }));

// SPA fallback. /api is excluded explicitly: without that, a typo'd endpoint
// would return index.html with a 200 and the client would try to parse HTML
// as JSON, which is a genuinely confusing way to learn you got the path
// wrong. This replaces the assets binding's not_found_handling setting.
app.get("/api/*", (c) =>
  c.json({ error: "Not found", code: "NOT_FOUND" }, 404),
);
app.get("*", serveStatic({ path: `${env.STATIC_DIR}/index.html` }));

const services = servicesFor(bindings);

const server = Bun.serve({
  port: env.PORT,
  // Hostname 0.0.0.0 so the port is reachable from outside the container;
  // Bun's default binds loopback only, which in Docker looks like a server
  // that started fine and refuses every connection.
  hostname: "0.0.0.0",
  fetch: (request) => app.fetch(request, bindings),
});

// Now that the handle exists, hand it to the same object the app already
// holds — this is how the rate limiter reads the peer address.
bindings.server = server;

const off = disabledSubsystems(env);
console.log(`pjokk listening on http://0.0.0.0:${env.PORT}`);
console.log(`  app url:   ${env.APP_URL}`);
console.log(`  indexable: ${env.INDEXABLE === "1" ? "yes" : "no"}`);
if (off.length > 0) console.log(`  disabled:  ${off.join(", ")}`);

let stopScheduler: (() => void) | undefined;
if (env.SCHEDULER === "1") {
  console.log("  scheduler: in-process (single-container mode)");
  stopScheduler = startScheduler(services);
}

// Kubernetes sends SIGTERM and then waits before SIGKILL; draining in that
// window is the difference between a rolling deploy that drops requests and
// one that does not.
const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down`);
  stopScheduler?.();
  await server.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
