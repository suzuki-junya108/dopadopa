#!/bin/sh
# herdr の startup hook / action から呼ばれる。
# startup hook は一回きりのコマンドなので、ブリッジは nohup で切り離して常駐させる。
set -eu

ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
STATE="${HERDR_PLUGIN_STATE_DIR:-$HOME/.dopadopa}"
CONFIG="${HERDR_PLUGIN_CONFIG_DIR:-$HOME/.dopadopa}"
PIDFILE="$STATE/bridge.pid"
LOG="$STATE/bridge.log"
mkdir -p "$STATE"

# 任意設定: $CONFIG/env に DOPADOPA_PORT=4517 などを書ける
if [ -f "$CONFIG/env" ]; then . "$CONFIG/env"; fi

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

# 止めたブリッジの合言葉を残すと、「ボードを開く」が使えない URL を作る。合言葉も消し、ポートが空くまで待つ
STOP_TRIES=30
stop_bridge() {
  if is_running; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    i=0
    while is_running && [ "$i" -lt "$STOP_TRIES" ]; do sleep 0.1; i=$((i + 1)); done
  fi
  rm -f "$PIDFILE" "$HOME/.dopadopa/token"
}

case "${1:-}" in
  --stop) stop_bridge; echo "dopadopa: stopped"; exit 0 ;;
  --restart) stop_bridge ;;
esac

if is_running; then
  echo "dopadopa: already running (pid $(cat "$PIDFILE"))"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "dopadopa: node が見つかりません (Node 18 以上が必要)" >&2
  exit 1
fi

# herdr が注入した HERDR_SOCKET_PATH / HERDR_BIN_PATH を引き継いで起動
nohup env \
  HERDR_SOCKET_PATH="${HERDR_SOCKET_PATH:-}" \
  HERDR_BIN_PATH="${HERDR_BIN_PATH:-herdr}" \
  DOPADOPA_PORT="${DOPADOPA_PORT:-4517}" \
  node "$ROOT/bridge/server.js" >>"$LOG" 2>&1 &
echo $! >"$PIDFILE"
echo "dopadopa: started (pid $!, http://127.0.0.1:${DOPADOPA_PORT:-4517})"
