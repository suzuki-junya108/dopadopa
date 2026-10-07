# データの定義

画面の各表示が、何から・どう計算されるか。T0 の実機確認で変わったら更新すること。

## 入力

| 入力 | 中身 |
|---|---|
| herdr `agent.list`（3秒ごと） | pane id、名前、エージェント種別、状態、cwd |
| herdr `events.subscribe`（`pane.agent_status_changed`） | 状態の変化を即時に |
| Claude Code hooks（`POST /hook?pane=$HERDR_PANE_ID`） | `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Notification` / `Stop` / `SessionEnd` の JSON |

セッションの紐づけ: hooks の `pane` があればそれ。なければ `session_id` → 過去の対応表 → cwd が一致する herdr エージェント。

## 状態

| 表示 | 条件 |
|---|---|
| あなた待ち | herdr の状態が `blocked`（`Notification` の文言を添える） |
| 考え中 / 編集中 / テスト中 | herdr が `working` で、直近のツールが Read・Grep 等 / Edit・Write 等 / テスト実行らしい Bash |
| 失敗→自動修正中 | テスト実行らしい Bash の PostToolUse が失敗（終了コード ≠ 0 など。T0 で取れる情報を確認） |
| 完了 | タスク完了（下記）から次の指示まで |

## 数

| 表示 | 定義 |
|---|---|
| ステップ完了 | TodoWrite の todo が `completed` に変わった瞬間に +1 |
| タスク完了 | そのターンの Todo がすべて completed になったとき。Todo がないターンは、herdr が `working` → `idle`/`done` に変わったとき（`Stop` hook も参考） |
| 今日完了したステップ | ステップ完了の合計（日付で区切る） |
| 次の区切り | 25 ステップごと |
| セッション別 今日の完了ステップ | セッションごとの合計 |
| 止まらずに進んだステップ | ステップ完了で +1。最後のステップ完了から一定時間（設定、既定 3 分）ステップがなければ 0。承認でもタイマーを戻す |
| 最高 | 今日の「止まらずに進んだステップ」の最大値 |
| 今日の目標 | タスクを 10 件完了。達成したら +5 件 |
| ほかの目標 | 許可待ちを 10 秒以内に承認する（2回）/ 止まらずに 15 ステップ進める / テストを 400 件通過させる |
| テスト通過 | PostToolUse の Bash 出力からテストランナーの結果行を拾う（例: `Tests: 24 passed`、`24 passed in 1.2s`）。取れなければ表示しない |
| 変更行 | Edit / Write の入力から概算 |
| ◯ステップ連続で進行中（カード） | そのセッションで失敗をはさまずに続いたステップ数。3 以上で表示 |

## 残り時間

`(残りステップ数) × (そのセッションの平均ステップ時間) − (今のステップの経過時間)` を ±30% の幅で「残り約 4:10〜7:40」。
平均が取れない（完了ステップ 0）ときは「見積もり中」。Todo がないときは表示しない。

## 保存

`$HERDR_PLUGIN_STATE_DIR/stats-YYYY-MM-DD.json` に、今日の合計・セッション別・最高記録・目標の進捗を保存。起動時に今日のファイルがあれば読み込む。

## SSE で送るもの

- スナップショット（変化があったとき、最大で毎秒）: セッション一覧、今日の数、目標、最近の出来事
- イベント（起きた瞬間）: `step` / `task` / `milestone` / `goal` / `streak`（10・20・30）/ `streak_reset` / `approved` / `blocked` / `error` / `mission`
  - UI はスナップショットで表示を更新し、イベントで演出だけを起こす
