# 引き継ぎメモ

## 目的（ユーザーの言葉の要約）

Mac で動く Claude Code の複数セッションを、リアルタイムに分かりやすく表示したい。

- ターミナルは流れてしまうと読めない、そもそも読みにくい
- 全体が見渡せて、個別にも分かりやすい
- 何をしていて、どんな状況で、あとどれくらいで終わるかが分かる
- 簡潔で分かりやすく、見ていて飽きない。演出は「ドーパミンが出る」くらい派手に
- 配布できる形にしたい

## これまでの決定

| 決定 | 理由 |
|---|---|
| herdr プラグインとして作る | herdr が Claude Code の状態検知（working / blocked / idle）と通知をすでに持っている |
| 案B：herdr はデータ源、画面はブラウザ | herdr プラグイン v1 はターミナルペインしか持てず、派手な演出ができない |
| 「何をしているか」は Todo の in_progress 項目の文を使う | 要約用の AI 呼び出しが不要になる |
| 残り時間は「残りステップ × 平均ステップ時間」を幅で表示 | 断言しない。Todo がなければ「見積もり中」 |
| アクアリウム（生き物）表示はやめた | ユーザー判断：見にくい |
| ゲーム要素（XP・ボス・宝箱など）は削除 | ユーザー判断：意味が伝わらない。演出だけ残し、数字はすべて実際の作業量に置き換えた |
| 配布は GitHub + `herdr-plugin` トピック | herdr マーケットプレイスが自動で拾う。`herdr plugin install owner/repo` で入る |

確定デザインの試作: `design/prototype.dc.html`（Claude の Design 形式。テンプレート記法 `{{...}}` と `class Component extends DCLogic` で書かれている。ロジックと見た目の参照用）

## 現状

- `bridge/server.js`: 動作する。herdr なしの環境で hooks 受信 → SSE 配信まで確認済み。herdr 実機では未確認
- `ui/index.html`: 動作確認用の最小版。確定デザインは未移植
- 今日の数字（ステップ数など）の保存: 未実装（再起動で 0 に戻る）
- hooks の導入: 手作業（`hooks/claude-settings.json` を `~/.claude/settings.json` にマージ）

## タスク（上から順に）

### T0. 実機確認（最初に必ず）

ブリッジの `pick()` で揺れを吸収しているが、以下は実機の出力で確定させる。

1. Claude Code のペイン内で `echo $HERDR_PANE_ID` が値を返すか
   - 返さない → `bridge/server.js` の `resolveKey()` の cwd 紐づけに頼る。精度を確認
2. `herdr agent list` の出力形（ソケットの `agent.list` も）。pane id・name・status・cwd のキー名
3. `events.subscribe`（`pane.agent_status_changed`）で届く行の形
4. 許可プロンプトで承認・拒否するために送るキー。`herdr agent send-keys --help` と実際のプロンプトの選択肢で決める
   - `bridge/server.js` の `KEYS` を更新
5. `herdr plugin link` → startup でブリッジが起動し、`dopadopa.board.open` でボードが開くか

※ 許可プロンプトを出す操作（例：「test.txt を作って」と頼む）はユーザーに依頼すること。勝手に承認キーを送らない。

完了条件: 上記の結果を `docs/herdr-findings.md` に記録し、ブリッジのコードを合わせた。

### T1. ブリッジを新しい数字に対応させる

`docs/data-mapping.md` の定義どおりに実装する。

- 今日の完了ステップ、セッション別完了ステップ、完了タスク、止まらずに進んだステップ（連続）と最高記録、今日の目標、ほかの目標の進捗
- 演出のきっかけになるイベントを SSE で送る（`step` / `task` / `milestone` / `goal` / `streak` / `streak_reset` / `approved` / `error`）。UI はこれを見て演出する
- 日付単位で `$HERDR_PLUGIN_STATE_DIR/stats-YYYY-MM-DD.json` に保存し、起動時に読み込む。日付が変わったらリセット

完了条件: ブリッジを再起動しても今日の数字が残る。イベントが SSE に流れる。

### T2. 確定デザインを ui/index.html に移植

- `design/prototype.dc.html` の見た目・文言・演出を、素の HTML/CSS/JS（単一ファイル、フレームワークなし）で再現する
- データはシミュレーションではなく SSE（`/stream`）から取る。演出は T1 のイベントで起こす
- 画面全体を毎秒 innerHTML で作り直さない（アニメーションが途中で切れる）。要素を保持して差分更新する
- 効果音は Web Audio の合成音のみ（外部ファイルなし）。初期値はオフ
- 承認・拒否ボタンは `/api/respond`、「herdr で開く」は `/api/focus`

完了条件: 実機の Claude Code を 2 つ以上動かし、ステップ完了・タスク完了・許可待ち・承認がボードに正しく出て、演出が動く。

### T3. 導入を簡単にする

- herdr プラグインに「hooks をインストール」アクションを追加（`~/.claude/settings.json` をバックアップしてからマージ。既存の hooks を壊さない）
- もしくは hooks 部分を Claude Code プラグインとしても配布する（どちらが良いか調べて提案）

### T4. 配布

- README（日本語、スクリーンショットか GIF）、LICENSE（ユーザーに確認）
- `min_herdr_version` を実際に確認した最も古いバージョンにする
- GitHub に公開し `herdr-plugin` トピックを付ける

## 未解決の論点

- テスト通過数の取り方: hooks の PostToolUse の出力から、テストランナーの結果行（jest / vitest / pytest など）を正規表現で拾う案。難しければ「ほかの目標」から外す
- 変更行数: Edit / Write の入力から概算する
- 連続記録が 0 に戻るまでの時間: 試作は 14 秒（デモ用）。実運用は数分が妥当。設定で変えられるようにする
- Claude Code のバージョンにより Todo のツール名が TodoWrite 以外の可能性がある（T0 で hooks の実データを確認）
