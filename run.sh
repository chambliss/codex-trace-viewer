#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

HOST="127.0.0.1"
PORT="8123"
OPEN_FLAG="--open"
CODEX_HOME_ARG=()
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOST="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --codex-home)
      CODEX_HOME_ARG=("--codex-home" "$2")
      shift 2
      ;;
    --no-open)
      OPEN_FLAG=""
      shift
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

CMD=(uv run python server.py --host "$HOST" --port "$PORT")
if [[ -n "$OPEN_FLAG" ]]; then
  CMD+=("$OPEN_FLAG")
fi
if [[ ${#CODEX_HOME_ARG[@]} -gt 0 ]]; then
  CMD+=("${CODEX_HOME_ARG[@]}")
fi
if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  CMD+=("${EXTRA_ARGS[@]}")
fi

exec "${CMD[@]}"
