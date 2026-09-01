#!/usr/bin/env bash
# Build the shipping image for both architectures Pjokk targets: linux/amd64
# (most VPS hosts) and linux/arm64 (Apple Silicon, Ampere, a Raspberry Pi 5).
#
#   bash scripts/build-image.sh                    # → pjokk:dev, local only
#   TAG=ghcr.io/refsdal/pjokk:v1 PUSH=1 bash scripts/build-image.sh
#
# Both stages of the Dockerfile cross-compile from $BUILDPLATFORM — the Go
# toolchain natively, the SPA because JavaScript has no architecture — so
# neither arch runs under QEMU and the second one costs a link step, not a
# second build.
#
# A multi-platform result is a manifest list, and the local `docker images`
# store cannot hold one: without PUSH=1 the build is verified and discarded
# (--output=type=cacheonly), which is what you want in CI and before a
# release. Pushing needs a registry you are logged into (`docker login
# ghcr.io`); there is no way to keep a two-arch image locally, so
# single-arch iteration is plain `docker build -t pjokk:dev .`.
set -euo pipefail

cd "$(dirname "$0")/.."

TAG="${TAG:-pjokk:dev}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

# docker-container is the only driver that can build more than one platform
# in a single invocation; the default "docker" driver refuses. Created once
# and reused — `create` is idempotent enough with `|| true`, but checking
# first keeps the output honest about what happened.
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
