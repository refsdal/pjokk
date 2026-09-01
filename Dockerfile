# syntax=docker/dockerfile:1

# Pjokk — one image, one static Go binary, five modes selected by argv[1]:
# the web server (default: migrate-then-serve-and-schedule), `server` (HTTP
# only), `worker` (scheduler only), `migrate` and `cron <job>`, plus
# `healthcheck` for HEALTHCHECK below. See apps/server/cmd/pjokk/main.go
# for the authoritative dispatch table.
#
# The runtime stage is `scratch`: no shell, no libc, no package manager, no
# CA bundle beyond the one file copied in, nothing to patch and nothing to
# exec into. That is only possible because the binary is CGO-free and every
# asset it needs is compiled in — the SPA (internal/web/dist), the OpenAPI
# spec (internal/api/pjokk.yaml), the SQL migrations (internal/db/migrations)
# and the IANA zone database (`import _ "time/tzdata"` in main.go, which is
# what makes Europe/Oslo resolve here at all).
#
# Two toolchains, because the app is two halves: Bun builds the SPA, Go
# compiles the server that embeds it.

# ---------- frontend ----------
# Pinned to $BUILDPLATFORM: the SPA output is a pile of JS and CSS, identical
# whichever CPU produced it, so building it once natively beats building it
# twice under QEMU during a multi-arch build.
FROM --platform=$BUILDPLATFORM oven/bun:1.4 AS frontend
WORKDIR /app

# Every workspace manifest, and ONLY the manifests: this layer exists so that
# editing source never reinstalls. `bun install --frozen-lockfile` validates
# the lockfile against the whole workspace, so the manifest of apps/landing —
# a workspace this image never builds — has to be here too; omitting it is a
# lockfile mismatch, not a smaller install. apps/server is not listed at all:
# it is the Go module now, with no package.json and no place in the bun
# workspace.
COPY package.json bun.lock ./
COPY apps/landing/package.json ./apps/landing/
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/shared/package.json ./packages/shared/
RUN bun install --frozen-lockfile

# tsconfig.base.json is what apps/frontend/tsconfig.json extends; esbuild
# reads it through vite for jsx/target settings, so the build fails without
# it in a way that looks like a syntax error rather than a missing file.
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/frontend ./apps/frontend

# The public apex the SPA links its legal pages to (apps/frontend/vite.config
# .ts bakes it in as __SITE_URL__). Build-time, not runtime, because it lands
# inside the client bundle — a self-hoster on their own domain overrides it
# here; everyone else gets pjokk.no.
ARG SITE_URL=https://pjokk.no
ENV SITE_URL=$SITE_URL

# Deliberately the frontend workspace's own build, not the root `bun run
# build`: that also builds apps/landing, a separate static deploy target the
# container has no use for, and a landing-only render failure has no business
# failing the image build.
RUN cd apps/frontend && bun run build   # → /app/dist/client

# ---------- build ----------
# Also pinned to $BUILDPLATFORM, then cross-compiled with GOOS/GOARCH. The Go
# toolchain cross-compiles natively, so a multi-arch build needs no QEMU here
# either — which is the difference between a two-minute build and a
# twenty-minute one.
FROM --platform=$BUILDPLATFORM golang:1.27 AS build
ARG TARGETOS TARGETARCH
WORKDIR /src

COPY apps/server/go.mod apps/server/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod,id=pjokk-gomod \
    go mod download

COPY apps/server/ ./

# The real SPA replaces the placeholder index.html that internal/web commits
# so `go build`/`go test` have something to embed. This MUST happen before
# `go build`: go:embed reads the directory at compile time, so an image built
# without this line would serve "SPA build lands here." and nothing else.
COPY --from=frontend /app/dist/client ./internal/web/dist

# No `go generate` here: sqlc and oapi-codegen output is committed (see
# apps/server/generate.go), and a code generator in the image build is a
# second, unreviewed source of truth for what ships.
#
# CGO_ENABLED=0 is what makes the scratch stage possible at all — a cgo build
# would link against the builder's glibc and find no loader in an empty image.
# -trimpath strips build paths (reproducibility, and no /src leaking into
# panics); -s -w drops the symbol table and DWARF, worth ~25% of the binary.
RUN --mount=type=cache,target=/go/pkg/mod,id=pjokk-gomod \
    --mount=type=cache,target=/root/.cache/go-build,id=pjokk-gobuild-$TARGETOS-$TARGETARCH \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /pjokk ./cmd/pjokk

# Directory skeleton for the runtime stage. scratch has no mkdir and no
# chown, so every directory the process needs must arrive as a COPY.
#
# /data is the STORAGE_DRIVER=fs root. Its ownership matters beyond the
# container's own filesystem: when Docker first populates a named volume it
# copies the image directory's ownership and mode onto the volume, so
# creating /data here as 65532 is what makes `pjokk-data:/data` writable by
# an unprivileged user — there is no shell in this image to chown it later.
#
# /tmp exists because os.TempDir() is /tmp and a missing one turns any future
# spill-to-disk (multipart uploads are the realistic case) into a confusing
# runtime error. Today nothing spills; the directory costs nothing.
RUN mkdir -p /skel/data /skel/tmp

# ---------- runtime ----------
FROM scratch

# Outbound TLS — Google OAuth, S3, web push — verifies against this one
# file. Without it every HTTPS call fails with "certificate signed by
# unknown authority" and nothing else in the image hints why.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# A real passwd/group entry rather than a bare `USER 65532`: Go's os/user
# falls back to parsing these files when cgo is disabled, and some tooling
# (and `docker inspect`) reads a name rather than a number. 65532 is the
# conventional "nonroot" uid, matching distroless, so a Kubernetes
# runAsUser/fsGroup written for the previous image still lines up.
COPY <<EOF /etc/passwd
root:x:0:0:root:/:/sbin/nologin
pjokk:x:65532:65532:pjokk:/:/sbin/nologin
EOF
COPY <<EOF /etc/group
root:x:0:
pjokk:x:65532:
EOF

COPY --from=build --chown=65532:65532 /skel/data /data
COPY --from=build --chown=65532:65532 /skel/tmp /tmp
COPY --from=build /pjokk /app/pjokk

USER pjokk
ENV PORT=3000
EXPOSE 3000

# The binary probes its own /healthz. scratch has no shell for the `CMD curl`
# form and no curl to run — the dispatcher's `healthcheck` subcommand exists
# precisely to fill that gap, and it deliberately constructs no config and no
# database pool so a liveness probe cannot fail on a bad DATABASE_URL.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/app/pjokk", "healthcheck"]

ENTRYPOINT ["/app/pjokk"]
