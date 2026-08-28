# syntax=docker/dockerfile:1

# Pjokk — one image, three entrypoints: the web server (default), the cron
# jobs (`bun cron-cli.js <job>`) and the migrator (`bun migrate.js`). They
# share the same build and configuration, so a Kubernetes CronJob or Job runs
# exactly the image that is already deployed.

# ---------- deps ----------
# Separate stage so a lockfile-only change is the sole thing that busts the
# install cache; editing source never reinstalls.
FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---------- build ----------
# Two outputs: the SPA (vite → dist/client) and the server bundled to plain
# JavaScript (bun build → dist/server).
FROM deps AS build
WORKDIR /app
COPY . .
RUN bun run build

# ---------- runtime ----------
# No dependency install and no node_modules AT ALL: everything the server
# imports is inlined into the bundles above. That is what takes the image from
# ~590 MB to ~165 MB — most of the old weight was frontend libraries
# (@tabler/icons-react alone was 141 MB) that only ever mattered at build time
# because they are compiled into dist/client, plus better-auth's optional peer
# dependencies (drizzle-kit, better-sqlite3) which `--production` does not drop.
FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# main.js / cron-cli.js / migrate.js, with their linked source maps so a stack
# trace still points at real files rather than into a 4 MB bundle.
COPY --from=build /app/dist/server ./
COPY --from=build /app/dist/client ./dist/client
# migrate.js reads these at run time; they are data, not code, so they are not
# part of the bundle.
COPY migrations ./migrations

# The base image ships a non-root `bun` user; running as root in a container
# that serves the public internet buys nothing.
USER bun

EXPOSE 3000

# Liveness only — /readyz additionally checks Postgres, which belongs to the
# orchestrator's readiness probe rather than to Docker's restart decision.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT ?? 3000) + '/healthz'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "main.js"]
