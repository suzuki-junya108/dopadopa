#!/bin/sh
# Claude Code の hook から呼ばれ、stdin の JSON をブリッジへ転送する。
# ブリッジが落ちていても Claude Code の動作を止めないよう、必ず exit 0 で終わる。
PORT="$(cat "$HOME/.dopadopa/port" 2>/dev/null || echo 4517)"
TOKEN="$(cat "$HOME/.dopadopa/token" 2>/dev/null || true)"
[ -z "$TOKEN" ] && exit 0
curl -s -m 1 -X POST \
  -H "Content-Type: application/json" \
  -H "X-Dopadopa-Token: $TOKEN" \
  --data-binary @- \
  "http://127.0.0.1:$PORT/hook?pane=${HERDR_PANE_ID:-}" >/dev/null 2>&1
exit 0
