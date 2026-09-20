#!/usr/bin/env bash
# Start the full local Coze stack (11 Docker services + Cursor OpenAI proxy).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOCKER_DIR="$ROOT/docker"
PROXY_DIR="$ROOT/scripts/cursor-openai-proxy"
PROXY_PORT="${PROXY_PORT:-8787}"
PROXY_PID_FILE="${PROXY_PID_FILE:-$PROXY_DIR/proxy.pid}"
PROXY_LOG="${PROXY_LOG:-$PROXY_DIR/proxy.log}"

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
    return
  fi
  docker-compose "$@"
}

echo "==> Coze local start"
echo "    repo: $ROOT"
echo "    11 Docker services + 1 host proxy"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed. Install Docker Desktop on Mac first." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Open Docker Desktop and wait until it is ready." >&2
  exit 1
fi

if [ ! -f "$DOCKER_DIR/.env" ]; then
  cp "$DOCKER_DIR/.env.example" "$DOCKER_DIR/.env"
  echo "    created docker/.env from .env.example — edit model keys if needed"
fi

# Mac Docker Desktop already has host.docker.internal; Linux compose extra_hosts covers the rest.
cd "$DOCKER_DIR"
echo "==> starting Docker stack"
compose --env-file .env -f docker-compose.yml up -d --remove-orphans

echo "==> waiting for frontend :8888"
ready=0
for _ in $(seq 1 90); do
  if curl -fsS -m 2 "http://127.0.0.1:8888/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo "warning: http://127.0.0.1:8888 is not ready yet; check: docker compose -f $DOCKER_DIR/docker-compose.yml ps" >&2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "warning: node not found, skip Cursor proxy. Install Node.js to use Cursor models." >&2
else
  if curl -fsS -m 2 "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1; then
    echo "==> Cursor proxy already up on :${PROXY_PORT}"
  else
    echo "==> starting Cursor OpenAI proxy on :${PROXY_PORT}"
    nohup "$PROXY_DIR/start.sh" >"$PROXY_LOG" 2>&1 &
    echo $! >"$PROXY_PID_FILE"
    proxy_ok=0
    for _ in $(seq 1 20); do
      if curl -fsS -m 2 "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1; then
        proxy_ok=1
        break
      fi
      sleep 1
    done
    if [ "$proxy_ok" -ne 1 ]; then
      echo "warning: Cursor proxy failed to start. See $PROXY_LOG" >&2
    fi
  fi
fi

echo
echo "Started:"
echo "  1-9  middleware   mysql redis elasticsearch minio etcd milvus nsqlookupd nsqd nsqadmin"
echo "  10   backend      coze-server"
echo "  11   frontend     coze-web          http://127.0.0.1:8888"
echo "  12   cursor proxy server.mjs        http://127.0.0.1:${PROXY_PORT}/health"
echo
compose --env-file .env -f docker-compose.yml ps
