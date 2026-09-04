# syntax=docker/dockerfile:1

# Pjokk — one image, one static Go binary, six modes selected by argv[1]:
# the web server (default: migrate-then-serve-and-schedule), `server` (HTTP
# only), `worker` (scheduler only), `migrate`, `cron <job>` and `landing`
# (the marketing site at pjokk.no, with no database, auth or API at all),
# plus `healthcheck` for HEALTHCHECK below. See apps/server/cmd/pjokk/main.go
# for the authoritative dispatch table.
#
# `landing` is why the apex needs no image of its own: the prerendered site
# is embedded alongside the SPA, and the deployment-specific values in it are
# substituted at startup rather than baked at build time.
#
# NOTHING COMPILES IN HERE. The binaries are built natively, outside Docker:
#
#   bash scripts/build-artifacts.sh   # → dist/server/linux/{amd64,arm64}/pjokk
#
# and this file only COPYs the one matching TARGETARCH. That keeps a
# multi-arch `docker buildx build --platform linux/amd64,linux/arm64` down
# to seconds of file copying — no QEMU emulation, no in-container Go or Bun
# toolchains, and the native build reuses the developer's (or CI's) module
# and Vite caches. If the COPY below fails with "not found", run the script
# first.
#
# The SPA is not copied separately: it is embedded inside the binary
# (go:embed in internal/web), along with the OpenAPI spec, the SQL
# migrations and the IANA zone database (`import _ "time/tzdata"`).
#
# The base is distroless "static" rather than scratch: same
# no-shell/no-libc/no-package-manager attack surface, but it ships the
# things a from-scratch image has to hand-roll — an up-to-date CA bundle,
# tzdata, /tmp, and the `nonroot` user (uid 65532, which the :nonroot tag
# also sets as USER). Pinned by digest; Dependabot bumps it.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab

# Automatic buildx arg: "linux/amd64" or "linux/arm64" per platform.
ARG TARGETPLATFORM
# Where the per-platform binaries live in the build context. The default
# serves the scripts/build-artifacts.sh layout (dist/server/linux/<arch>/
# pjokk); GoReleaser's dockers_v2 passes BINARY_ROOT=. because its build
# context holds them at linux/<arch>/pjokk directly.
ARG BINARY_ROOT=dist/server

# The fs storage driver's default volume mountpoint. Pre-created OWNED BY
# nonroot because Docker copies image-directory ownership onto a named
# volume the first time it is used — the only root-free, shell-free way to
# hand a nonroot process a writable volume. (A missing mountpoint would be
# auto-created root-owned and unwritable. Bind mounts are the operator's
# own chown; Kubernetes uses fsGroup instead.) The .keep file inside only
# exists because git cannot track an empty directory.
COPY --chown=nonroot:nonroot docker/data-skel/ /data/

COPY ${BINARY_ROOT}/${TARGETPLATFORM}/pjokk /app/pjokk

ENV PORT=3000
EXPOSE 3000

# The binary is its own healthcheck client — there is no shell or curl here.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/app/pjokk", "healthcheck"]

ENTRYPOINT ["/app/pjokk"]
