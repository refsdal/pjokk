#!/usr/bin/env bash
# Builds everything the container image COPYs, natively — no compilation
# happens inside Docker any more. Output:
#
#   dist/server/pjokk-linux-amd64
#   dist/server/pjokk-linux-arm64
#
# The SPA is not a separate artifact: it is embedded into both binaries via
# go:embed, which is why this script briefly overlays the real Vite build
# into apps/server/internal/web/dist (where a committed placeholder
# index.html normally sits so plain `go build`/`go test` work without a
# frontend build). The overlay is restored afterwards — even on failure —
# so the working tree stays clean.
#
# Arch names follow Docker's TARGETARCH values (amd64/arm64) so the
# Dockerfile can COPY dist/server/pjokk-linux-${TARGETARCH} directly.
#
# Prerequisites: `mise install` (Go + Bun) and `bun install`.
set -euo pipefail
cd "$(dirname "$0")/.."

EMBED_DIR=apps/server/internal/web/dist

restore_embed_dir() {
  # Drop the overlaid SPA and put the committed placeholder back. Guarded so
  # a checkout without git (e.g. an exported tarball) still builds — it just
  # keeps the overlay.
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git clean -qfd "$EMBED_DIR"
    git checkout -q -- "$EMBED_DIR"
  fi
}
trap restore_embed_dir EXIT

echo "==> SPA (vite)"
(cd apps/frontend && bun run build)   # writes dist/client at the repo root

echo "==> embed overlay"
rm -rf "$EMBED_DIR"
mkdir -p "$EMBED_DIR"
cp -R dist/client/. "$EMBED_DIR/"

echo "==> server binaries"
rm -rf dist/server
mkdir -p dist/server
for arch in amd64 arm64; do
  (cd apps/server && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" \
    go build -trimpath -ldflags="-s -w" \
    -o "../../dist/server/pjokk-linux-$arch" ./cmd/pjokk)
  echo "    dist/server/pjokk-linux-$arch"
done

ls -lh dist/server/
