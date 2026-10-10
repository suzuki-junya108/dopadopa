#!/bin/sh
set -eu
# 再起動と同時に呼ばれることがある（herdr は操作を並行して実行する）。古い合言葉で開くと
# 「このページは開けません」になるので、ブリッジが受け付ける合言葉が読めるまで待つ。
# 止まりかけの古いブリッジも応答を返すため、少し置いてもう一度確かめてから開く
WAIT_TRIES=20
SETTLE_SECONDS=0.6
accepted() {
  [ -n "$2" ] && [ "$(curl -s -m 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/?token=$2" 2>/dev/null || true)" = "200" ]
}
read_token() { cat "$HOME/.dopadopa/token" 2>/dev/null || true; }
i=0
while [ "$i" -lt "$WAIT_TRIES" ]; do
  PORT="$(cat "$HOME/.dopadopa/port" 2>/dev/null || echo 4517)"
  TOKEN="$(read_token)"
  if accepted "$PORT" "$TOKEN"; then
    sleep "$SETTLE_SECONDS"
    if [ "$(read_token)" = "$TOKEN" ] && accepted "$PORT" "$TOKEN"; then
      # トークンのない要求はブリッジが拒否するので、開く側が URL に付けて渡す
      URL="http://127.0.0.1:$PORT/?token=$TOKEN"
      if command -v open >/dev/null 2>&1; then open "$URL"; else xdg-open "$URL"; fi
      exit 0
    fi
  fi
  sleep 0.2
  i=$((i + 1))
done
echo "dopadopa: ブリッジにつながりません（「dopadopa: ブリッジを再起動」を実行してください）" >&2
exit 1
