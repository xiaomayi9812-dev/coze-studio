#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Pull CURSOR_API_KEY from common shell/env files without sourcing zsh into bash.
load_cursor_api_key() {
  if [ -n "${CURSOR_API_KEY:-}" ]; then
    return 0
  fi
  local f line val
  for f in \
    "$ROOT/.env" \
    "$ROOT/../../docker/.env" \
    "${HOME:-}/.zshrc" \
    "${HOME:-}/.zprofile" \
    "${HOME:-}/.bashrc" \
    "${HOME:-}/.bash_profile" \
    "${HOME:-}/.profile"; do
    [ -f "$f" ] || continue
    line="$(grep -E '^[[:space:]]*(export[[:space:]]+)?CURSOR_API_KEY=' "$f" | tail -n 1 || true)"
    [ -n "$line" ] || continue
    val="${line#*=}"
    val="${val%\"}"
    val="${val#\"}"
    val="${val%\'}"
    val="${val#\'}"
    if [ -n "$val" ]; then
      export CURSOR_API_KEY="$val"
      return 0
    fi
  done
}

load_cursor_api_key

if [ -z "${CURSOR_API_KEY:-}" ]; then
  echo "CURSOR_API_KEY is empty. Add it to ~/.zshrc / ~/.bashrc or export it first." >&2
  exit 1
fi

export PROXY_PORT="${PROXY_PORT:-8787}"
export CURSOR_PROXY_MODEL="${CURSOR_PROXY_MODEL:-composer-2.5}"
exec node "$ROOT/server.mjs"
