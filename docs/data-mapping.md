# データの定義

画面の各表示が、何から・どう計算されるか。実装は `bridge/core.js`、確かめた事実は `docs/herdr-findings.md`。

## 前提の変更（2026-10-07）

当初は「ステップ＝Todo の 1 項目が完了」で設計していたが、実機の Claude Code（2.1.292）には Todo 系ツールがなく、会話記録 1,010 件でも使用は 0 回だった。そのためユーザー判断で **ステップ＝ツール操作 1 回の完了** に切り替えた。これに伴い、全体の量が分からないと出せない「%」と「残り時間」は表示しない。

## 入力

| 入力 | 中身 |
|---|---|
| herdr `agent.list`（3秒ごと） | `pane_id`、`agent`、`agent_status`、`cwd`、`terminal_title_stripped`、`agent_session.value` |
| herdr `events.subscribe`（`pane.agent_status_changed`） | 状態の変化を即時に |
| Claude Code hooks（`POST /hook?pane=$HERDR_PANE_ID`） | `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `Notification` / `Stop` / `SessionEnd` の JSON |

セッションの紐づけ: hooks の `pane` があればそれ。なければ `session_id` → 過去の対応表（herdr の `agent_session.value` も使う）→ cwd が一致する herdr エージェント。

カードの名前は cwd の最後のフォルダ名、ブランチは cwd から上にたどった `.git/HEAD`。

## 状態

| 表示 | 条件 |
|---|---|
| あなた待ち | herdr の状態が `blocked` |
| 考え中 | 作業中で、直近の操作が読み込み・検索など |
| 編集中 | 作業中で、直近の操作が Edit / Write など |
| コマンド実行中 | 作業中で、直近の操作がテスト以外の Bash |
| テスト中 | 作業中で、直近の操作がテスト実行らしい Bash（`npm test`、`pytest`、`go test`、`node --test` など） |
| 失敗→自動修正中 | テスト実行らしい Bash が `PostToolUseFailure` になってから、次にテストが通るまで |
| 完了 | タスク完了（下記）から次の指示まで |
| 待機中 | 今日まだタスクを完了していない、作業していないセッション |

## 数

| 表示 | 定義 |
|---|---|
| ステップ完了 | `PostToolUse` 1 回につき +1。失敗した操作（`PostToolUseFailure`）は数えない |
| タスク完了 | `Stop` が届いたとき（1 回の指示への対応が終わった）。フックが届かないセッションは、herdr が `working` → `idle`/`done` に変わったとき |
| 今日完了したステップ | ステップ完了の合計（日付で区切る） |
| 次の区切り | 100 ステップごと |
| セッション別 今日の完了ステップ | 名前（フォルダ名）ごとの合計 |
| 止まらずに進んだステップ | ステップ完了で +1。最後のステップ完了から一定時間（`DOPADOPA_STREAK_SECONDS`、既定 180 秒）ステップがなければ 0。ボードからの承認でもタイマーを戻す |
| 最高 | 今日の「止まらずに進んだステップ」の最大値 |
| ◯ステップ連続！（告知） | 止まらずに進んだステップが 50 / 100 / 150 に達したとき |
| 今日の目標 | タスクを 10 件完了。達成したら +5 件 |
| ほかの目標 | 許可待ちを 10 秒以内に承認する（2回、ボードの承認ボタンから）/ 止まらずに 100 ステップ進める / テストを 400 件通過させる |
| テスト通過 | テスト実行らしい Bash の出力から結果行を拾う（jest / vitest / pytest / node --test / cargo / mocha）。1 件も取れていない間は「テスト通過」の数を表示しない |
| 変更行 | Edit / Write で書き込んだ文字列の行数（概算） |
| カードの大きな数字 | いまの指示で完了したステップ数 |
| ◯ステップ連続で進行中（カード） | そのセッションで失敗をはさまずに続いたステップ数。作業中で 10 以上のとき表示 |
| 経過 | いまの指示を受けてからの時間（完了後は完了までの時間） |

区切り・連続・目標の数値は、ステップが Todo 単位だった試作（25 / 10・20・30 / 15）から、操作単位に合わせて大きくしている。

## 許可待ち

- 何の許可か: `PreToolUse` が届いて `PostToolUse` がまだ届いていない操作（Bash ならコマンドの 1 行目）
- 承認・拒否ボタンを出す条件: herdr の状態が `blocked`、保留中の操作がある、その操作が質問（AskUserQuestion）や計画の確認（ExitPlanMode）ではない、まだ応答していない
- 送るキー: 承認は `Enter`、拒否は `esc`（`herdr agent send-keys`）

## 保存

`$HERDR_PLUGIN_STATE_DIR/stats-YYYY-MM-DD.json`（なければ `~/.dopadopa/`）に、今日の合計・セッション別・最高記録・目標の進捗を保存。起動時に今日のファイルがあれば読み込む。保存するのは件数とフォルダ名だけで、指示文・コマンド・ツールの出力は保存しない。

## SSE で送るもの

`GET /stream` に、1 行 1 件の JSON を `data:` で送る。

- スナップショット（`type: "snapshot"`、変化があったとき、最大で毎秒）: セッション一覧、今日の数、目標、最近の出来事。時間とともに進む表示（経過・待ち時間・連続のバー）は、時刻を渡して画面側で進める
- イベント（`type: "event"`、起きた瞬間）: `kind` が `step` / `task` / `milestone` / `goal` / `streak` / `streak_reset` / `approved` / `blocked` / `error` / `mission`
  - UI はスナップショットで表示を更新し、イベントで演出だけを起こす
