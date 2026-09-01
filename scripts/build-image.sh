#!/usr/bin/env bash
# Build the shipping image for both architectures Pjokk targets: linux/amd64
# (most VPS hosts) and linux/arm64 (Apple Silicon, Ampere, a Raspberry Pi 5).
#
#   bash scripts/build-image.sh                    # → pjokk:dev, local only
#   TAG=ghcr.io/refsdal/pjokk:v1 PUSH=1 bash scripts/build-image.sh
#
# The binaries are compiled natively FIRST (scripts/build-artifacts.sh —
# skipped when SKIP_ARTIFACTS=1 and dist/server is already populated); the
# Dockerfile is COPY-only, so the multi-platform buildx step below is
# seconds of file copying with no QEMU emulation.
#
# A multi-platform result is a manifest list, and the local `docker images`
# store cannot hold one: without PUSH=1 the build is verified and discarded
# (--output=type=cacheonly), which is what you want in CI and before a
# release. Pushing needs a registry you are logged into (`docker login
# ghcr.io`); single-arch iteration is plain `docker build -t pjokk:dev .`
# after running build-artifacts.sh once.
set -euo pipefail

cd "$(dirname "$0")/.."

TAG="${TAG:-pjokk:dev}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

if [ "${SKIP_ARTIFACTS:-0}" != "1" ] || [ ! -e dist/server/linux/amd64/pjokk ]; then
  bash scripts/build-artifacts.sh
fi

# docker-container is the only driver that can build more than one platform
# in a single invocation; the default "docker" driver refuses. Created once
# and reused.
BUILDER="${BUILDER:-pjokk}"
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "==> creating buildx builder '$BUILDER' (docker-container driver)"
  docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
fi

if [ "${PUSH:-0}" = "1" ]; then
  OUTPUT=(--push)
  echo "==> building $TAG for $PLATFORMS and pushing"
else
  OUTPUT=(--output=type=cacheonly)
  echo "==> building $TAG for $PLATFORMS (verify only; set PUSH=1 to publish)"
fi

docker buildx build \
  --builder "$BUILDER" \
  --platform "$PLATFORMS" \
  --tag "$TAG" \
  "${OUTPUT[@]}" \
  .
