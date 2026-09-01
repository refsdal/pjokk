#!/usr/bin/env bash
# Drops the SPA overlaid into the go:embed directory and puts the committed
# placeholder back, leaving the working tree clean. Idempotent; a no-op
# outside a git checkout (an exported tarball just keeps the overlay).
set -euo pipefail
cd "$(dirname "$0")/.."

EMBED_DIR=apps/server/internal/web/dist

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git clean -qfd "$EMBED_DIR"
  git checkout -q -- "$EMBED_DIR"
fi
