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

## まだ実機で確かめていないこと

- 承認（`Enter`）・拒否（`esc`）のキーが、実際の許可プロンプトで意図どおり効くか。模擬の herdr では、ボードの承認ボタンから `agent send-keys <pane> Enter` が 1 回だけ送られることまで確認した。実物の確認はユーザーの操作が必要（勝手に承認キーを送らない決まりのため）
- `Notification` の中身（許可待ちのときの文言と項目）
