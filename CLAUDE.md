# Watchtower

Claude Code の複数セッションを、ブラウザのライブボードで「全体を一目で」「個別にも分かりやすく」「見ていて楽しく」表示する herdr プラグイン。

経緯・決定事項・次のタスクは `HANDOFF.md`、見た目と言葉のルールは `docs/design-spec.md`、データの定義は `docs/data-mapping.md` を読むこと。

## 構成（案B：herdr はデータ源、画面はブラウザ）

```
Claude Code ×N（herdr のペイン）
  ├─ herdr サーバー ……… 状態（working / blocked / idle / done）
  └─ Claude Code hooks …… 何をしているか・Todo・ツール操作
        ↓
  bridge/server.js（常駐、127.0.0.1:4517、トークン認証）
        ↓ SSE
  ui/index.html（ライブボード）
        ↑ 承認・拒否 → herdr agent send-keys
```

| パス | 役割 |
|---|---|
| `herdr-plugin.toml` | プラグイン定義。startup でブリッジ起動、actions: open / restart / stop |
| `bin/start-bridge.sh` | ブリッジを nohup で常駐起動（startup hook は一回きりのため） |
| `bin/open-board.sh` | ブラウザでボードを開く |
| `bridge/server.js` | herdr socket（agent.list ポーリング + events.subscribe）と hooks を統合し SSE 配信。依存なし |
| `hooks/forward.sh` | Claude Code hook → ブリッジへ転送。失敗しても必ず exit 0 |
| `hooks/claude-settings.json` | `~/.claude/settings.json` に足す hooks 設定 |
| `ui/index.html` | ボード（現状は最小版。デザイン移植が次のタスク） |
| `design/prototype.dc.html` | 確定デザインの試作（Claude の Design 形式。参照用で、そのままは動かない） |

## コマンド

```sh
npm run check                                   # 構文チェック
herdr plugin link "$PWD"                         # 開発中のプラグインを登録
herdr plugin action invoke watchtower.board.restart
herdr plugin action invoke watchtower.board.open
herdr plugin log list --plugin watchtower.board
herdr agent list
herdr agent explain <target>
```

ブリッジのログ: `$HERDR_PLUGIN_STATE_DIR/bridge.log`（場所は `herdr plugin config-dir watchtower.board` の近く。分からなければ `ps` で探す）。
herdr-plugin.toml を変えたら `herdr plugin unlink watchtower.board && herdr plugin link "$PWD"` で再登録。

## 守るルール

1. **言葉**: 画面の文言は `docs/design-spec.md` の用語表に従う。ゲーム用語（XP、レベル、ボス、宝箱、称号、ガチャ、クリティカル、コンボ、FEVER、クエスト、CLEAR など）は使わない。ユーザーから「意味がわからない」と2回指摘されて削除した経緯がある。
2. **数字は本物だけ**: 画面に出す数字は、実際の作業の数（ステップ、タスク、承認、テストなど）だけ。作り物のポイントを足さない。
3. **演出は派手に**: 紙吹雪・画面の揺れ・フラッシュ・大きな告知・効果音は維持する（ユーザーの要望）。ただし `prefers-reduced-motion` で止まり、揺れと音はオフにできること。
4. **Claude Code を止めない**: hooks は必ず短時間で exit 0。ブリッジが落ちていても Claude Code に影響させない。
5. **セキュリティ**: 127.0.0.1 のみで待ち受け、トークンのない要求は拒否。承認キー送信はユーザー操作からのみ。
6. **依存を増やさない**: ブリッジは Node 標準ライブラリのみ。UI は単一 HTML（外部はフォントだけ）。
7. 推測で herdr の CLI・ソケット仕様を書かない。`--help`、`https://herdr.dev/docs/`、実機の出力で確認してから実装する。
