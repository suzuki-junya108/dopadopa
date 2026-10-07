#!/bin/sh
# herdr の startup hook / action から呼ばれる。
# startup hook は一回きりのコマンドなので、ブリッジは nohup で切り離して常駐させる。
set -eu

ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
STATE="${HERDR_PLUGIN_STATE_DIR:-$HOME/.watchtower}"
CONFIG="${HERDR_PLUGIN_CONFIG_DIR:-$HOME/.watchtower}"
PIDFILE="$STATE/bridge.pid"
LOG="$STATE/bridge.log"
mkdir -p "$STATE"

# 任意設定: $CONFIG/env に WATCHTOWER_PORT=4517 などを書ける
if [ -f "$CONFIG/env" ]; then . "$CONFIG/env"; fi

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

stop_bridge() {
  if is_running; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    sleep 0.3
  fi
  rm -f "$PIDFILE"
}

case "${1:-}" in
  --stop) stop_bridge; echo "watchtower: stopped"; exit 0 ;;
  --restart) stop_bridge ;;
esac

if is_running; then
  echo "watchtower: already running (pid $(cat "$PIDFILE"))"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "watchtower: node が見つかりません (Node 18 以上が必要)" >&2
  exit 1
fi

# herdr が注入した HERDR_SOCKET_PATH / HERDR_BIN_PATH を引き継いで起動
nohup env \
  HERDR_SOCKET_PATH="${HERDR_SOCKET_PATH:-}" \
  HERDR_BIN_PATH="${HERDR_BIN_PATH:-herdr}" \
  WATCHTOWER_PORT="${WATCHTOWER_PORT:-4517}" \
  node "$ROOT/bridge/server.js" >>"$LOG" 2>&1 &
echo $! >"$PIDFILE"
echo "watchtower: started (pid $!, http://127.0.0.1:${WATCHTOWER_PORT:-4517})"
