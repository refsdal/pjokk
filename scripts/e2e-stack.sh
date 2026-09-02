#!/usr/bin/env bash
# Starts (or tears down) the stack the Playwright suite runs against: a
# throwaway Postgres and the REAL container image with OPEN_SIGNUP=1 (the
# suite creates its own accounts) on port 3300.
#
#   bash scripts/e2e-stack.sh up      # builds pjokk:e2e if missing
#   bash scripts/e2e-stack.sh down
#
# `mise run e2e` wraps up → test → down. The image is the same COPY-only
# Dockerfile as production; run `bash scripts/build-artifacts.sh` first (up
# does it for you when dist/server is missing).
set -euo pipefail
cd "$(dirname "$0")/.."

NET=pjokk-e2e
PG=pjokk-e2e-pg
APP=pjokk-e2e-app
PORT="${E2E_PORT:-3300}"

down() {
  docker rm -f "$APP" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  echo "e2e stack down"
}

case "${1:-up}" in
  down) down; exit 0 ;;
  up) ;;
  *) echo "usage: e2e-stack.sh [up|down]"; exit 2 ;;
esac

if [ -z "$(docker images -q pjokk:e2e)" ] || [ "${E2E_REBUILD:-0}" = "1" ]; then
  # E2E_REBUILD=1 rebuilds the ARTIFACTS too — reusing stale binaries here
  # once shipped an image without the frontend change under test.
  if [ "${E2E_REBUILD:-0}" = "1" ] || [ ! -e dist/server/linux/amd64/pjokk ]; then
    bash scripts/build-artifacts.sh
  fi
  docker build -t pjokk:e2e .
fi

down >/dev/null
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_USER=pjokk -e POSTGRES_PASSWORD=pjokk -e POSTGRES_DB=pjokk \
  postgres:17-alpine >/dev/null

# TCP probe, not the socket — initdb's first start accepts on the socket
# before TCP is up (same reasoning as ci.yml's smoke test).
for i in $(seq 1 30); do
  docker exec "$PG" pg_isready -h 127.0.0.1 -U pjokk -d pjokk >/dev/null 2>&1 && break
  sleep 1
done

docker run -d --name "$APP" --network "$NET" -p "$PORT":3000 \
  -e DATABASE_URL=postgres://pjokk:pjokk@"$PG":5432/pjokk \
  -e APP_URL=http://127.0.0.1:"$PORT" \
  -e AUTH_SECRET=e2e-stack-secret-at-least-32-bytes-ok \
  -e STORAGE_DRIVER=fs -e STORAGE_FS_PATH=/data \
  -e OPEN_SIGNUP=1 \
  pjokk:e2e >/dev/null

for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/readyz" | grep -q '"ok":true'
echo "e2e stack up on http://127.0.0.1:$PORT"
