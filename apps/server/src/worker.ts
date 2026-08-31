import { startScheduler } from "./cron";
import { loadEnv } from "./env";
import { createDeps } from "./deps";

// The `worker` dispatch mode: runs ONLY the in-process scheduler, for a
// deployment that scales the HTTP tier (`server` mode) horizontally but
// still wants one long-running process to own the cron-shaped work
// (reminders, nightly backup) instead of driving it from Kubernetes
// CronJobs. Exactly one `worker` replica should run at a time — same
// constraint `SCHEDULER=1` used to carry, now expressed by which mode you
// run rather than by an env flag that could be set on more than one pod.
//
// A minimal Bun.serve on PORT answers ONLY /healthz. This mode never serves
// the app or the API, but the image's Docker HEALTHCHECK always probes
// /healthz on PORT regardless of mode — without this, a `worker` container
// would report unhealthy and get restart-looped by an orchestrator despite
// doing its job correctly.

export async function runWorker() {
  const env = loadEnv(process.env);

  const deps = createDeps(env, { current: undefined });

  const server = Bun.serve({
    port: env.PORT,
    hostname: "0.0.0.0",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return Response.json({ ok: true });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  console.log(
    `pjokk worker: scheduler running, healthz on http://0.0.0.0:${env.PORT}`,
  );

  const stopScheduler = startScheduler(deps);

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    stopScheduler();
    await server.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
