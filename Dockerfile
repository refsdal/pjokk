# syntax=docker/dockerfile:1

# Pjokk — one image, one compiled binary, four modes: the web server
# (default), the cron jobs (`/app/dispatch cron <job>`), the migrator
# (`/app/dispatch migrate`) and the healthcheck (`/app/dispatch healthcheck`,
# used by HEALTHCHECK below since the runtime image has no shell). They share
# the same build and configuration, so a Kubernetes CronJob or Job runs
# exactly the image that is already deployed.

# ---------- deps ----------
# Separate stage so a lockfile-only change is the sole thing that busts the
# install cache; editing source never reinstalls.
#
# Debian, not Alpine: the binary compiled below links against glibc, and
# distroless/base-debian12 (the runtime base) has no musl to satisfy an
# Alpine-built binary.
FROM oven/bun:1.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Every workspace manifest, and ONLY the manifests: this stage exists so that
# editing source never reinstalls, and copying whole packages here would
# reintroduce exactly the cache busting it avoids.
COPY apps/api/package.json ./apps/api/
COPY apps/server/package.json ./apps/server/
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/shared/package.json ./packages/shared/
RUN bun install --frozen-lockfile

# ---------- build ----------
# Two outputs: the SPA (vite → dist/client) and the server compiled to a
# single standalone binary (bun build --compile → dist/compiled/dispatch).
FROM deps AS build
WORKDIR /app
COPY . .
RUN bun run build

# ---------- runtime ----------
# distroless, not Alpine: the runtime image has no shell, no package manager
# and no node_modules — attack surface, not size, is the point (measured ~113
# MB here against ~118 MB for the previous Alpine image; see DECISIONS.md).
# Everything the server imports is compiled into the single `dispatch`
# binary, so there is nothing left to install at runtime.
FROM gcr.io/distroless/base-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/dist/compiled/dispatch ./dispatch
COPY --from=build /app/dist/compiled/dispatch.js.map ./dispatch.js.map
COPY --from=build /app/dist/client ./dist/client
# The migrator reads these at run time; they are data, not code, so they are
# not part of the compiled binary.
COPY apps/api/migrations ./migrations

EXPOSE 3000

# distroless has no shell, so this is the dispatcher's own subcommand rather
# than the old `bun -e "fetch(...)"` one-liner.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/app/dispatch", "healthcheck"]

ENTRYPOINT ["/app/dispatch"]
