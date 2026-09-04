#!/usr/bin/env bash
# Drops the builds overlaid into the go:embed directories (the SPA and the
# landing site) and puts the committed placeholders back, leaving the working
# tree clean. Idempotent; a no-op outside a git checkout (an exported tarball
# just keeps the overlay).
set -euo pipefail
cd "$(dirname "$0")/.."

EMBED_DIRS=(
  apps/server/internal/web/dist
  apps/server/internal/landing/dist
)

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  for dir in "${EMBED_DIRS[@]}"; do
    git clean -qfd "$dir"
    git checkout -q -- "$dir"
  done
fi
