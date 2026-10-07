# dopadopa（開発中）

Claude Code の複数セッションを、ブラウザのライブボードで見渡す herdr プラグイン。

- 開発を始める人（Claude Code 含む）: `CLAUDE.md` → `HANDOFF.md` の順に読む
- 引き継ぎ用のプロンプト: `HANDOFF_PROMPT.md`

## 開発用セットアップ

1. 前提: herdr 0.9 以上、Node 18 以上、`herdr integration install claude` 済み
2. `herdr plugin link "$PWD"`
3. `herdr plugin action invoke dopadopa.board.restart`（ブリッジ起動）
4. `hooks/claude-settings.json` の `hooks` を `~/.claude/settings.json` にマージ
   （`~/.dopadopa/forward.sh` はブリッジ起動時に自動でコピーされる）
5. `herdr plugin action invoke dopadopa.board.open`

## セキュリティ

127.0.0.1 のみで待ち受け、起動ごとのランダムトークン（`~/.dopadopa/token`, 0600）がない要求は拒否する。
