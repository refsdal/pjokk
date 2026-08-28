# syntax=docker/dockerfile:1

# Pjokk — one image, two roles: the web server (default) and the cron jobs
# (`bun run cron <job>`). Both share the same code and configuration, so a
# Kubernetes CronJob runs exactly the image that is already deployed.

# ---------- deps ----------
# Separate stage so a lockfile-only change is the sole thing that busts the
# install cache; editing source never reinstalls.
FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---------- build ----------
# Builds the SPA. The server is NOT bundled: Bun executes the TypeScript in
# src/server directly, so there is nothing to compile for it.
FROM deps AS build
WORKDIR /app
COPY . .
RUN bun run build

# ---------- runtime ----------
FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Reinstalled without devDependencies: vite, biome, drizzle-kit and the
# TypeScript compiler have no business in a production image.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# The server sources (run directly), the built SPA, and the migrations that
# `bun run migrate` applies as a one-off job.
COPY src ./src
COPY --from=build /app/dist/client ./dist/client
COPY migrations ./migrations
# Bun resolves the "@shared/*" import alias from tsconfig.json at runtime, so
# the server does not start without it.
COPY tsconfig.json ./

# The base image ships a non-root `bun` user; running as root in a container
# that serves the public internet buys nothing.
USER bun

EXPOSE 3000

# Liveness only — /readyz additionally checks Postgres, which belongs to the
# orchestrator's readiness probe rather than to Docker's restart decision.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT ?? 3000) + '/healthz'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "src/server/main.ts"]
