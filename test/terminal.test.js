'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findTerminalApp } = require('../bridge/terminal.js');

test('端末に付いている herdr から親をたどって端末アプリを見つける', () => {
  const ps = [
    '  764     1 ??       /Applications/Ghostty.app/Contents/MacOS/ghostty',
    '  798     1 ??       /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
    '  853   764 ttys000  /usr/bin/login',
    '  856   853 ttys000  -/bin/zsh',
    '15572   856 ttys000  herdr',
    '15573 15572 ??       /opt/homebrew/bin/herdr',
  ].join('\n');
  assert.equal(findTerminalApp(ps), '/Applications/Ghostty.app');
});

test('画面を出している herdr が無い・アプリにたどり着かないときは空を返す', () => {
  assert.equal(findTerminalApp('15573     1 ??       /opt/homebrew/bin/herdr'), '', 'サーバーだけでは端末は分からない');
  assert.equal(findTerminalApp('  10     1 ttys001  sshd\n  11    10 ttys001  herdr'), '', 'SSH 越しなどアプリが無い');
  assert.equal(findTerminalApp('  20     1 ttys002  /usr/local/bin/herdr-helper'), '', '名前が似ているだけの別物');
  assert.equal(findTerminalApp(''), '');
});

test('アプリ名に空白があっても場所を取り違えない', () => {
  const ps = '  5     1 ??       /Applications/My Term.app/Contents/MacOS/my term\n  6     5 ttys003  /opt/homebrew/bin/herdr';
  assert.equal(findTerminalApp(ps), '/Applications/My Term.app');
});
