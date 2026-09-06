#!/usr/bin/env bash
# Builds everything the container image COPYs, natively — no compilation
# happens inside Docker. Output:
#
#   dist/server/linux/amd64/pjokk
#   dist/server/linux/arm64/pjokk
#
# The SPA is not a separate artifact: it is embedded into both binaries via
# go:embed (scripts/spa-embed-overlay.sh), and the overlay is restored
# afterwards — even on failure — so the working tree stays clean. The landing
# site rides along the same way (scripts/landing-embed-overlay.sh): one binary
# serves the app by default and the marketing site under `pjokk landing`, so
# both hosts ship from a single artifact.
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
bash scripts/landing-embed-overlay.sh

# The version stamped into the binary (internal/buildinfo) — shown in the
# Settings footer and the boot log. CI passes the preview image's pinned
# tag so the two match; releases get theirs from .goreleaser.yaml's
# identical ldflag; a local build says "dev".
VERSION="${PJOKK_VERSION:-dev}"

echo "==> server binaries ($VERSION)"
rm -rf dist/server
mkdir -p dist/server
for arch in amd64 arm64; do
  mkdir -p "dist/server/linux/$arch"
  (cd apps/server && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" \
    go build -trimpath \
    -ldflags="-s -w -X github.com/refsdal/pjokk/server/internal/buildinfo.Version=$VERSION" \
    -o "../../dist/server/linux/$arch/pjokk" ./cmd/pjokk)
  echo "    dist/server/linux/$arch/pjokk"
done

ls -lh dist/server/linux/*/
