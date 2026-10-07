#!/bin/sh
set -eu
PORT="$(cat "$HOME/.watchtower/port" 2>/dev/null || echo 4517)"
URL="http://127.0.0.1:$PORT/"
if command -v open >/dev/null 2>&1; then open "$URL"; else xdg-open "$URL"; fi
