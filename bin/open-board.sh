#!/bin/sh
set -eu
PORT="$(cat "$HOME/.dopadopa/port" 2>/dev/null || echo 4517)"
TOKEN="$(cat "$HOME/.dopadopa/token" 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  echo "dopadopa: ブリッジが起動していません（「dopadopa: ブリッジを再起動」を実行してください）" >&2
  exit 1
fi
# トークンのない要求はブリッジが拒否するので、開く側が URL に付けて渡す
URL="http://127.0.0.1:$PORT/?token=$TOKEN"
if command -v open >/dev/null 2>&1; then open "$URL"; else xdg-open "$URL"; fi
