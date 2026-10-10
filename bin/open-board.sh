#!/bin/sh
set -eu
# 再起動の直後は、新しいブリッジが合言葉を書き終えていないことがある。
# 古い合言葉で開くと「このページは開けません」になるので、ブリッジが受け付ける合言葉が読めるまで少し待つ
WAIT_TRIES=25
PORT=4517
TOKEN=""
i=0
while [ "$i" -lt "$WAIT_TRIES" ]; do
  PORT="$(cat "$HOME/.dopadopa/port" 2>/dev/null || echo 4517)"
  TOKEN="$(cat "$HOME/.dopadopa/token" 2>/dev/null || true)"
  if [ -n "$TOKEN" ] && [ "$(curl -s -m 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/?token=$TOKEN" 2>/dev/null || true)" = "200" ]; then
    # トークンのない要求はブリッジが拒否するので、開く側が URL に付けて渡す
    URL="http://127.0.0.1:$PORT/?token=$TOKEN"
    if command -v open >/dev/null 2>&1; then open "$URL"; else xdg-open "$URL"; fi
    exit 0
  fi
  sleep 0.2
  i=$((i + 1))
done
echo "dopadopa: ブリッジにつながりません（「dopadopa: ブリッジを再起動」を実行してください）" >&2
exit 1
