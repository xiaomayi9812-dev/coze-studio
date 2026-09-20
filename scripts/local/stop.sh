#!/usr/bin/env bash
# Thoroughly stop Coze frontend, backend, middleware, and the Cursor proxy.
# Keeps MySQL/MinIO data under docker/data unless you pass --wipe.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOCKER_DIR="$ROOT/docker"
PROXY_DIR="$ROOT/scripts/cursor-openai-proxy"
PROXY_PORT="${PROXY_PORT:-8787}"
PROXY_PID_FILE="${PROXY_PID_FILE:-$PROXY_DIR/proxy.pid}"
WIPE=0

for arg in "$@"; do
  case "$arg" in
    --wipe) WIPE=1 ;;
    -h|--help)
      echo "Usage: $0 [--wipe]"
      echo "  default  stop all Coze containers + Cursor proxy, keep data"
      echo "  --wipe   also delete compose volumes and docker/data"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
    return
  fi
  docker-compose "$@"
}

kill_pids() {
  local pid
  for pid in "$@"; do
    [ -n "$pid" ] || continue
    kill "$pid" >/dev/null 2>&1 || true
    sleep 0.2
    kill -9 "$pid" >/dev/null 2>&1 || true
  done
}

pids_on_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
    return
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser "${port}/tcp" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$' || true
  fi
}

echo "==> Coze local stop (thorough)"

echo "==> stopping Cursor OpenAI proxy"
if [ -f "$PROXY_PID_FILE" ]; then
  kill_pids "$(cat "$PROXY_PID_FILE" 2>/dev/null || true)"
  rm -f "$PROXY_PID_FILE"
fi
if command -v pgrep >/dev/null 2>&1; then
  kill_pids $(pgrep -f 'scripts/cursor-openai-proxy/server.mjs' 2>/dev/null || true)
  kill_pids $(pgrep -f 'cursor-openai-proxy/start.sh' 2>/dev/null || true)
fi
kill_pids $(pids_on_port "$PROXY_PORT")

echo "==> stopping Docker Coze stack"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if [ -f "$DOCKER_DIR/docker-compose.yml" ]; then
    cd "$DOCKER_DIR"
    ENV_ARGS=()
    if [ -f .env ]; then
      ENV_ARGS=(--env-file .env)
    fi
    if [ "$WIPE" -eq 1 ]; then
      compose "${ENV_ARGS[@]}" -f docker-compose.yml down --remove-orphans --volumes --timeout 30 || true
    else
      compose "${ENV_ARGS[@]}" -f docker-compose.yml down --remove-orphans --timeout 30 || true
    fi
  fi

  leftover="$(docker ps -aq --filter 'name=^coze-' 2>/dev/null || true)"
  if [ -n "$leftover" ]; then
    echo "==> removing leftover coze-* containers"
    # shellcheck disable=SC2086
    docker rm -f $leftover >/dev/null 2>&1 || true
  fi
else
  echo "warning: Docker is not running; will still kill host ports" >&2
fi

echo "==> freeing host ports 8888 / 8787"
kill_pids $(pids_on_port 8888)
kill_pids $(pids_on_port "$PROXY_PORT")

if [ "$WIPE" -eq 1 ]; then
  echo "==> wiping docker/data"
  rm -rf "$DOCKER_DIR/data"
fi

echo
echo "Stopped:"
echo "  Docker   mysql redis elasticsearch minio etcd milvus nsqlookupd nsqd nsqadmin coze-server coze-web"
echo "  Host     cursor-openai-proxy (:${PROXY_PORT})"
if [ "$WIPE" -eq 1 ]; then
  echo "  Data     docker/data and compose volumes deleted"
else
  echo "  Data     kept in docker/data  (use --wipe to delete)"
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  still="$(docker ps --format '{{.Names}}' --filter 'name=^coze-' 2>/dev/null || true)"
  if [ -n "$still" ]; then
    echo "warning: still running: $still" >&2
    exit 1
  fi
fi
echo "OK: Coze frontend/backend/middleware/proxy are down."
