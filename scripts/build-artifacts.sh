#!/usr/bin/env bash
# Builds everything the container image COPYs, natively — no compilation
# happens inside Docker. Output:
#
#   dist/server/linux/amd64/pjokk
#   dist/server/linux/arm64/pjokk
#
# The SPA is not a separate artifact: it is embedded into both binaries via
# go:embed (scripts/spa-embed-overlay.sh), and the overlay is restored
# afterwards — even on failure — so the working tree stays clean.
#
# The layout mirrors GoReleaser's dockers_v2 build context
# (linux/<TARGETARCH>/pjokk), so ONE Dockerfile COPY line serves both this
# script (BINARY_ROOT=dist/server, the default) and GoReleaser
# (BINARY_ROOT=.).
#
# Releases do not use this script — GoReleaser drives the same overlay and
# equivalent go build flags itself (.goreleaser.yaml). This is the dev/CI
# path for compose and the preview image.
#
# Prerequisites: `mise install` (Go + Bun) and `bun install`.
set -euo pipefail
cd "$(dirname "$0")/.."

trap 'bash scripts/restore-embed-overlay.sh' EXIT

bash scripts/spa-embed-overlay.sh

echo "==> server binaries"
rm -rf dist/server
mkdir -p dist/server
for arch in amd64 arm64; do
  mkdir -p "dist/server/linux/$arch"
  (cd apps/server && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" \
    go build -trimpath -ldflags="-s -w" \
    -o "../../dist/server/linux/$arch/pjokk" ./cmd/pjokk)
  echo "    dist/server/linux/$arch/pjokk"
done

ls -lh dist/server/linux/*/
