#!/usr/bin/env bash
# Builds the SPA and overlays it into apps/server/internal/web/dist, where
# go:embed picks it up at compile time (a committed placeholder index.html
# normally sits there so plain `go build`/`go test` work without a frontend
# build). Used by scripts/build-artifacts.sh and as GoReleaser's `before`
# hook — callers are responsible for restoring the overlay afterwards
# (scripts/restore-embed-overlay.sh) so the working tree stays clean.
set -euo pipefail
cd "$(dirname "$0")/.."

EMBED_DIR=apps/server/internal/web/dist

echo "==> SPA (vite)"
(cd apps/frontend && bun run build)   # writes dist/client at the repo root

echo "==> embed overlay"
rm -rf "$EMBED_DIR"
mkdir -p "$EMBED_DIR"
cp -R dist/client/. "$EMBED_DIR/"
