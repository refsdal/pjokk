import { Scalar } from "@scalar/hono-api-reference";
import { sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { AppEnv, FamEnv } from "./context";
import { createApp } from "./lib";
import { servicesFor } from "./services";
import { landing } from "./landing";
import {
  requireAdmin,
  requireFamily,
  sessionMiddleware,
} from "./middleware/tenancy";
import { babiesApp } from "./routes/babies";
import { diapersApp } from "./routes/diapers";
import { feedsApp } from "./routes/feeds";
import { invitesAdminApp, invitesPublicApp } from "./routes/invites";
import { apiKeyAuth, rejectApiKey } from "./middleware/api-key";
import { rateLimit } from "./middleware/rate-limit";
import { audit, requireSysadmin } from "./middleware/sysadmin";
import { adminApp } from "./routes/admin";
import { billingApp } from "./routes/billing";
import { calendarApp } from "./routes/calendar";
import { contactsApp } from "./routes/contacts";
import { exportApp } from "./routes/export";
import { keysApp } from "./routes/keys";
import { otherLogsApp } from "./routes/other-logs";
import { playApp } from "./routes/play";
import { pushApp } from "./routes/push";
import { sleepLocationsApp } from "./routes/sleep-locations";
import { statsApp } from "./routes/stats";
import { filesApp, vaccinesApp } from "./routes/vaccines";
import { sleepApp } from "./routes/sleep";
import { timelineApp } from "./routes/timeline";

// Hands each request the process-wide collaborators. This used to CONSTRUCT
// them per request, because D1 bindings only existed inside the handler;
// servicesFor() memoizes on the Env object, so the work happens once.
const inject = createMiddleware<AppEnv>(async (c, next) => {
  const services = servicesFor(c.env);
  c.set("db", services.db);
  c.set("auth", services.auth);
  c.set("storage", services.storage);
  c.set("rateLimit", services.rateLimit);
  await next();
});

const app = createApp<AppEnv>();

// The public landing page. Registered first so it wins over the static-file
// handler that main.ts appends: on Workers this precedence came from naming
// "/" in the assets run_worker_first list, here it is simply route order.
// Not an OpenAPI route — it returns HTML, not part of the API surface.
app.get("/", landing);

// robots.txt and sitemap.xml. These used to be emitted at BUILD time by a
// vite plugin keyed on CLOUDFLARE_ENV, which is why production and test
// needed separately-built bundles. Serving them from the app makes INDEXABLE
// a runtime switch, so one image can be promoted from test to production.
app.get("/robots.txt", (c) => {
  const body =
    c.env.INDEXABLE === "1"
      ? `User-agent: *\nAllow: /\n\nSitemap: ${new URL("/sitemap.xml", c.env.APP_URL)}\n`
      : "User-agent: *\nDisallow: /\n";
  c.header("Content-Type", "text/plain; charset=utf-8");
  return c.body(body);
});

app.get("/sitemap.xml", (c) => {
  // Nothing to advertise for an environment that must stay unindexed.
  if (c.env.INDEXABLE !== "1") return c.notFound();
  const origin = new URL(c.env.APP_URL).origin;
  // One public page; a hand-written sitemap is honest and cheaper than
  // generating one from a route tree that is entirely behind auth.
  c.header("Content-Type", "application/xml; charset=utf-8");
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>${origin}/</loc>
    <xhtml:link rel="alternate" hreflang="en" href="${origin}/?lang=en"/>
    <xhtml:link rel="alternate" hreflang="nb" href="${origin}/?lang=nb"/>
  </url>
  <url><loc>${origin}/privacy</loc></url>
  <url><loc>${origin}/terms</loc></url>
</urlset>
`);
});

// Liveness: answers as long as the process is up. Deliberately touches
// nothing — a health check that queries the database turns a slow query into
// a restart loop.
app.get("/healthz", (c) => c.json({ ok: true as const }));

// Readiness: refuses traffic until the dependencies actually answer, so a
// rolling deploy does not route requests at a pod that cannot serve them.
app.get("/readyz", async (c) => {
  const services = servicesFor(c.env);
  try {
    await services.db.execute(sql`select 1`);
  } catch (error) {
    return c.json({ ok: false as const, error: (error as Error).message }, 503);
  }
  return c.json({ ok: true as const });
});

app.use("/api/*", inject);

// Security headers on every API response (static assets get theirs in
// main.ts, which is where the old Cloudflare _headers file went). No CSP
// here — responses are JSON, and /api/docs loads Scalar's bundle from a CDN.
app.use("/api/*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "same-origin");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
});

// Credential brute-force brake (sec review H1): better-auth's built-in
// limiter is memory-backed, so it is per-process and useless the moment
// there is more than one replica. The Postgres-backed limiter fronts the
// password endpoint instead. 20/10 min per IP is generous for humans,
// hopeless for guessing.
app.use(
  "/api/auth/sign-in/email",
  rateLimit({ name: "auth-signin", limit: 20, windowSeconds: 600 }),
);

// Server-side audit of better-auth admin operations (issue #6): the client
// no longer self-reports; every successful /api/auth/admin/* call writes the
// trail from the actual request.
app.use("/api/auth/admin/*", async (c, next) => {
  const body = (await c.req.raw
    .clone()
    .json()
    .catch(() => null)) as { userId?: string } | null;
  await next();
  if (c.res.status < 400) {
    const session = await c.var.auth.api.getSession({
      headers: c.req.raw.headers,
    });
    if (session) {
      const action = `auth.${c.req.path.split("/api/auth/admin/")[1] ?? "?"}`;
      await audit(c.var.db, session.user.id, action, body?.userId ?? "-").catch(
        () => {},
      );
    }
  }
});

// better-auth owns /api/auth/* (must be registered before the session
// middleware so it terminates the chain itself).
app.on(["GET", "POST"], "/api/auth/*", (c) => c.var.auth.handler(c.req.raw));

// pjk_ bearer keys resolve to a synthetic session; sessionMiddleware then
// skips cookie/session resolution for those requests.
app.use("/api/*", apiKeyAuth);
app.use("/api/*", sessionMiddleware);

// Everything below /api (except auth + public invite endpoints) requires an
// authenticated session with an active family. Middleware is registered in
// statement form: .use() would collapse the accumulated route types that the
// RPC client derives from the .route() chain.
const domainBase = createApp<FamEnv>();
domainBase.use("/api/*", requireFamily);
domainBase.use("/api/invites", requireAdmin);
domainBase.use("/api/invites/*", requireAdmin);
domainBase.use("/api/keys", requireAdmin);
domainBase.use("/api/keys/*", requireAdmin);
domainBase.use("/api/billing/*", requireAdmin);
// Push subscriptions and billing are device/session-bound; keys have no
// business there.
domainBase.use("/api/push/*", rejectApiKey);
domainBase.use("/api/billing/*", rejectApiKey);
const domainApp = domainBase
  .route("/", babiesApp)
  .route("/", feedsApp)
  .route("/", diapersApp)
  .route("/", sleepApp)
  .route("/", sleepLocationsApp)
  .route("/", otherLogsApp)
  .route("/", playApp)
  .route("/", vaccinesApp)
  .route("/", filesApp)
  .route("/", timelineApp)
  .route("/", calendarApp)
  .route("/", contactsApp)
  .route("/", statsApp)
  .route("/", exportApp)
  .route("/", pushApp)
  .route("/", keysApp)
  .route("/", billingApp)
  .route("/", invitesAdminApp);

// API docs require a signed-in session (issue #2): registered before the
// tenancy-gated domain mount, but not open to the world.
const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.sessionData) {
    return c.json({ error: "Not signed in", code: "UNAUTHENTICATED" }, 401);
  }
  await next();
});
app.use("/api/openapi.json", requireSession);
app.use("/api/docs", requireSession);
app.doc("/api/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Pjokk API",
    version: "0.1.0",
    description: "Self-hosted baby tracker.",
  },
});
app.get("/api/docs", Scalar({ url: "/api/openapi.json" }));

// System-admin surface: session-authed, role-gated, never family-scoped.
const adminBase = createApp<AppEnv>();
adminBase.use("/api/admin/*", requireSysadmin);
const adminRoutes = adminBase.route("/", adminApp);

const routes = app
  .route("/", invitesPublicApp)
  .route("/", adminRoutes)
  .route("/", domainApp);

// The Hono RPC client derives its types from this.
export type AppType = typeof routes;

// The API and the landing page — everything that is worth testing without a
// filesystem. main.ts appends static-file serving and the SPA fallback, then
// starts the server; cron.ts drives the scheduled jobs. The Workers
// `export default { fetch, scheduled }` handler is gone with the runtime that
// required it.
export default app;
export { app };
