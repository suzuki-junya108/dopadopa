# 実機で確かめたこと（T0）

2026-10-07、macOS、herdr のペイン内、Claude Code 2.1.292 で確認。

## herdr

| 確認したこと | 結果 |
|---|---|
| Claude Code のペイン内の `$HERDR_PANE_ID` | 値が入っている（例 `wK:p1`）。フックの紐づけは pane id で足りる |
| `agent.list`（ソケット）の形 | `{"result":{"type":"agent_list","agents":[…]}}`。各要素は `pane_id` / `agent` / `agent_status` / `cwd` / `foreground_cwd` / `terminal_title_stripped` / `agent_session.value`（Claude Code の session id）/ `workspace_id` / `tab_id` など。`name` や `status` というキーは無い |
| `events.subscribe` | 最初に `{"result":{"type":"subscription_started"}}` が返る。その後の変化の行は `agent_status` を読む |
| `herdr agent send-keys <TARGET> <KEY>...` | Escape の正式名は `esc` |
| `herdr agent focus <target>` | pane id を渡す |
| `herdr plugin link` | 登録できる。ただし startup は herdr サーバー起動時だけ走るので、登録直後は `dopadopa.board.restart` でブリッジを起こす |

## Claude Code のフック

| 確認したこと | 結果 |
|---|---|
| Todo 系ツール（TodoWrite / TaskCreate / TaskUpdate） | この版には無い。`~/.claude/projects` の会話記録 1,010 件で使用 0 回。ステップの定義を操作単位に変えた理由 |
| 操作の失敗 | `PostToolUse` ではなく別イベント `PostToolUseFailure` で届く。`error`（例 `Exit code 1\n…`）と `is_interrupt` を持つ。`tool_response` は無い |
| `PostToolUse` の Bash | `tool_response.stdout` / `stderr` / `interrupted`。終了コードの欄は無い |
| 共通の項目 | `session_id` / `cwd` / `prompt_id` / `tool_use_id` / `duration_ms` |
| `Stop` | `last_assistant_message` などを持つ。1 回の指示への対応が終わるたびに届く |
| 設定の反映 | `~/.claude/settings.json` のフックを書き換えても、実行中のセッションには起動し直すか `/hooks` で確認するまで反映されない |

## 承認・拒否（実物の許可プロンプトで確認済み）

検証用のペインを `herdr pane split` で作り、`herdr agent start <name> --kind claude --pane <id> -- --permission-mode default` で Claude Code を起動して確かめた。

| 確認したこと | 結果 |
|---|---|
| 許可プロンプトの初期選択 | 「1. Yes」が選ばれた状態で出る（2: 常に許可、3: auto mode に切り替え、4: No）。herdr の状態は `blocked` |
| ボードの「承認する」（`Enter`） | 許可が通り、コマンドが実行された（ファイルが作られた） |
| ボードの「拒否」（`esc`） | コマンドは実行されず、Claude Code は「Interrupted」で指示待ちに戻る。`Stop` は届かない |
| フォルダを信頼するかの確認（初回起動時） | 初期選択は「No, exit」。herdr の状態は `blocked` だが、保留中の操作が無いのでボードは承認ボタンを出さない。ここに Enter を送ると Claude Code が終了するので、出さないのが正しい |
| 質問（AskUserQuestion） | herdr の状態は `blocked`。承認ボタンは出さず「質問への回答を待っています」と出す |
| `herdr agent prompt` | 起動直後に送ると届かないことがあった。`herdr agent wait` で idle を待ってから送る |

検証で承認キーを送るのは、自分で作った検証用ペインだけにする。ユーザーが作業中のセッションには送らない。

## まだ実機で確かめていないこと

- `Notification` の中身（許可待ちのときの文言と項目）。いまは表示に使っていない
