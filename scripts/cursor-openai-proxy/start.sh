#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [ -f /root/.bashrc ]; then
  # Non-interactive shells skip bashrc; load it so CURSOR_API_KEY is visible.
  # /etc/bashrc reads $BASHRCSOURCED under set -u-unsafe tests; relax flags while sourcing.
  set +eu
  set -a
  # shellcheck disable=SC1091
  . /root/.bashrc
  set +a
  set -eu
fi

if [ -z "${CURSOR_API_KEY:-}" ]; then
  echo "CURSOR_API_KEY is empty. Add it to ~/.bashrc or export it first." >&2
  exit 1
fi

export PROXY_PORT="${PROXY_PORT:-8787}"
export CURSOR_PROXY_MODEL="${CURSOR_PROXY_MODEL:-composer-2.5}"
exec node "$ROOT/server.mjs"
