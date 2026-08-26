import { Scalar } from "@scalar/hono-api-reference";
import { createMiddleware } from "hono/factory";
import { createAuth } from "./auth";
import type { AppEnv, FamEnv } from "./context";
import { createDb } from "./db";
import { createApp } from "./lib";
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
import { exportApp } from "./routes/export";
import { keysApp } from "./routes/keys";
import { otherLogsApp } from "./routes/other-logs";
import { pushApp } from "./routes/push";
import { sleepLocationsApp } from "./routes/sleep-locations";
import { statsApp } from "./routes/stats";
import {
  purgeOrphanUsers,
  reconcilePlans,
  runBackup,
  runCalendarReminders,
  runReminders,
} from "./scheduled";
import { sleepApp } from "./routes/sleep";
import { timelineApp } from "./routes/timeline";

// Auth + db are request-scoped on Workers (D1 bindings only exist inside the
// handler), hence the per-request factory here.
const inject = createMiddleware<AppEnv>(async (c, next) => {
  c.set("db", createDb(c.env.DB));
  c.set("auth", createAuth(c.env));
  await next();
});

const app = createApp<AppEnv>();

app.use("/api/*", inject);

// Security headers on every API response (the SPA assets get theirs from
// public/_headers). No CSP here — responses are JSON, and /api/docs loads
// Scalar's bundle from a CDN.
app.use("/api/*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "same-origin");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
});

// Credential brute-force brake (sec review H1): better-auth's built-in
// limiter is memory-backed and useless across Workers isolates, so the KV
// limiter fronts the password endpoint. 20/10 min per IP is generous for
// humans, hopeless for guessing.
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
app.on(["GET", "POST"], "/api/auth/*", (c) =>
  (c.var.auth as ReturnType<typeof createAuth>).handler(c.req.raw),
);

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
  .route("/", timelineApp)
  .route("/", calendarApp)
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

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env) {
    if (event.cron === "15 3 * * *") {
      const key = await runBackup(env);
      console.log(`cron: backup written to ${key}`);
      const purged = await purgeOrphanUsers(env);
      if (purged > 0) console.log(`cron: purged ${purged} orphan account(s)`);
      const reconciled = await reconcilePlans(env);
      if (reconciled > 0) {
        console.log(`cron: reconciled ${reconciled} family plan(s) to premium`);
      }
    } else {
      const sent = await runReminders(env);
      if (sent > 0) console.log(`cron: ${sent} reminder(s) sent`);
      const calendarSent = await runCalendarReminders(env);
      if (calendarSent > 0) {
        console.log(`cron: ${calendarSent} calendar reminder(s) sent`);
      }
    }
  },
} satisfies ExportedHandler<Env>;
