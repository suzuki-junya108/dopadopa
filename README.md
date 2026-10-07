# dopadopa（開発中）

Claude Code の複数セッションを、ブラウザのライブボードで見渡す herdr プラグイン。

- 開発を始める人（Claude Code 含む）: `CLAUDE.md` → `HANDOFF.md` の順に読む
- 引き継ぎ用のプロンプト: `HANDOFF_PROMPT.md`

## 開発用セットアップ

1. 前提: herdr 0.9 以上、Node 18 以上、`herdr integration install claude` 済み
2. `herdr plugin link "$PWD"`
3. `herdr plugin action invoke dopadopa.board.restart`（ブリッジ起動）
4. `herdr plugin action invoke dopadopa.board.install-hooks`（`~/.claude/settings.json` にフックを足す。先にバックアップを取り、既存のフックには触れない。外すときは `node bin/install-hooks.js --remove`）
   - 実行中の Claude Code には、起動し直すか `/hooks` で確認するまで反映されない
   - フックを入れないセッションも状態（作業中・あなた待ちなど）は出るが、ステップは数えられない
5. `herdr plugin action invoke dopadopa.board.open`

テスト: `npm test`、構文チェック: `npm run check`

## セキュリティ

127.0.0.1 のみで待ち受け、起動ごとのランダムトークン（`~/.dopadopa/token`, 0600）がない要求は、ボードのページを含めてすべて拒否する。ボードは「ボードを開く」操作がトークン付きの URL で開く（URL はブラウザの履歴に残る。トークンはブリッジを再起動すると変わる）。

## 扱うデータ

- フックは、Claude Code への指示文・実行するコマンド・ツールの入力と出力を、このマシン内のブリッジに送る。ブリッジはそれを使って画面を作り、指示文の冒頭 60 文字・コマンドの 1 行目・ファイル名をボードに表示する
- ファイルに保存するのは、今日の件数（ステップ・タスク・テストなど）とフォルダ名だけ（`stats-YYYY-MM-DD.json`）。指示文・コマンド・ツールの出力は保存しない
- マシンの外への通信は、ボードがフォントを読み込む Google Fonts だけ。作業内容は外に送らない
- ボードの「承認する」「拒否」は、その許可待ちのペインに `Enter` / `esc` を 1 回だけ送る。画面のボタンを押したとき以外は送らない
