import { Scalar } from "@scalar/hono-api-reference";
import { createMiddleware } from "hono/factory";
import { createAuth } from "./auth";
import type { AppEnv, FamEnv } from "./context";
import { createDb } from "./db";
import { createApp } from "./lib";
import { requireAdmin, requireFamily, sessionMiddleware } from "./middleware/tenancy";
import { babiesApp } from "./routes/babies";
import { diapersApp } from "./routes/diapers";
import { feedsApp } from "./routes/feeds";
import { invitesAdminApp, invitesPublicApp } from "./routes/invites";
import { sleepApp } from "./routes/sleep";

// Auth + db are request-scoped on Workers (D1 bindings only exist inside the
// handler), hence the per-request factory here.
const inject = createMiddleware<AppEnv>(async (c, next) => {
  c.set("db", createDb(c.env.DB));
  c.set("auth", createAuth(c.env));
  await next();
});

const app = createApp<AppEnv>();

app.use("/api/*", inject);

// better-auth owns /api/auth/* (must be registered before the session
// middleware so it terminates the chain itself).
app.on(["GET", "POST"], "/api/auth/*", (c) =>
  (c.var.auth as ReturnType<typeof createAuth>).handler(c.req.raw),
);

app.use("/api/*", sessionMiddleware);

// Everything below /api (except auth + public invite endpoints) requires an
// authenticated session with an active family.
const domainApp = createApp<FamEnv>()
  .use("/api/*", requireFamily)
  .use("/api/invites", requireAdmin)
  .use("/api/invites/*", requireAdmin)
  .route("/", babiesApp)
  .route("/", feedsApp)
  .route("/", diapersApp)
  .route("/", sleepApp)
  .route("/", invitesAdminApp);

const routes = app.route("/", invitesPublicApp).route("/", domainApp);

app.doc("/api/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Pjokk API",
    version: "0.1.0",
    description: "Self-hosted baby tracker.",
  },
});
app.get("/api/docs", Scalar({ url: "/api/openapi.json" }));

// The Hono RPC client derives its types from this.
export type AppType = typeof routes;

export default {
  fetch: app.fetch,
  // Nightly D1 export to R2 lands in Phase 5; the trigger is already wired.
  async scheduled(_event: ScheduledController, _env: Env) {
    console.log("cron: backup export not implemented yet (phase 5)");
  },
} satisfies ExportedHandler<Env>;
