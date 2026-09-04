#!/usr/bin/env bash
# Builds the landing site in TEMPLATE mode and overlays it into
# apps/server/internal/landing/dist, where go:embed picks it up at compile
# time (committed placeholders normally sit there so plain `go build`/`go
# test` work without a frontend build). The sibling of
# scripts/spa-embed-overlay.sh, and like it, callers are responsible for
# restoring the overlay afterwards (scripts/restore-embed-overlay.sh).
#
# TEMPLATE=1 is the whole point: it leaves __PJOKK_*__ tokens where the app
# URL, site URL and call-to-action label go, so ONE image can serve the apex,
# a test host or a self-hoster's own domain — the server substitutes them at
# startup. A plain (untemplated) build would bake pjokk.no into the binary.
set -euo pipefail
cd "$(dirname "$0")/.."

EMBED_DIR=apps/server/internal/landing/dist

echo "==> landing site (bun, templated)"
(cd apps/landing && TEMPLATE=1 bun run build)

echo "==> embed overlay"
rm -rf "$EMBED_DIR"
mkdir -p "$EMBED_DIR"
cp -R apps/landing/dist/. "$EMBED_DIR/"
