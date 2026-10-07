#!/usr/bin/env node
'use strict';
// hooks/claude-settings.json の内容を ~/.claude/settings.json に足す（--remove で外す）。
// 既存のフックには触れず、dopadopa の行だけを出し入れする。書き換える前に必ずバックアップを取る。
// 使い方: node bin/install-hooks.js [--remove] [--settings <path>]

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const settingsArg = args.indexOf('--settings');
const requested = settingsArg >= 0 ? args[settingsArg + 1] : path.join(os.homedir(), '.claude', 'settings.json');
// 設定がシンボリックリンクのとき、リンクを実ファイルで置き換えてしまわないよう実体のほうを書き換える
const target = requested && fs.existsSync(requested) ? fs.realpathSync(requested) : requested;
const source = path.join(__dirname, '..', 'hooks', 'claude-settings.json');
const OURS = /[\\/]\.dopadopa[\\/]forward\.sh/;

function fail(message) {
  console.error('dopadopa: ' + message);
  process.exit(1);
}
if (!target) fail('--settings にはファイルのパスを指定してください');

const isOurs = (entry) => Array.isArray(entry.hooks) && entry.hooks.some((h) => OURS.test(String(h.command || '')));

let settings = {};
let original = null;
if (fs.existsSync(target)) {
  original = fs.readFileSync(target, 'utf8');
  try {
    settings = JSON.parse(original);
  } catch (e) {
    fail(`${target} を JSON として読めません（${e.message}）。壊さないよう何も変更していません`);
  }
}
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) fail(`${target} の中身が設定の形ではありません。何も変更していません`);
const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
const wanted = JSON.parse(fs.readFileSync(source, 'utf8')).hooks;

const changed = [];
for (const event of Object.keys(wanted)) {
  const current = Array.isArray(hooks[event]) ? hooks[event] : [];
  const others = current.filter((entry) => !isOurs(entry));
  const next = remove ? others : [...others, ...wanted[event]];
  if (JSON.stringify(next) !== JSON.stringify(current)) changed.push(event);
  if (next.length) hooks[event] = next; else delete hooks[event];
}
if (!changed.length) {
  console.log(`dopadopa: 変更はありません（${remove ? 'フックは入っていません' : 'フックは設定済みです'}）`);
  process.exit(0);
}
if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;

fs.mkdirSync(path.dirname(target), { recursive: true });
if (original !== null) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const backup = `${target}.dopadopa-backup-${stamp}`;
  fs.writeFileSync(backup, original, { mode: 0o600 });
  console.log(`dopadopa: バックアップ ${backup}`);
}
// 書きかけの設定を Claude Code に読ませないよう、別名に書いてから置き換える
fs.writeFileSync(target + '.dopadopa-tmp', JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(target + '.dopadopa-tmp', target);
console.log(`dopadopa: ${remove ? 'フックを外しました' : 'フックを入れました'}（${changed.join(', ')}）`);
console.log(`dopadopa: 実行中の Claude Code には、起動し直すか /hooks で確認するまで反映されません`);
