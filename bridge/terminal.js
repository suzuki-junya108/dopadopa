'use strict';
// herdr の画面を表示している端末アプリを探す。入出力は持たず、`ps -axo pid=,ppid=,tty=,comm=` の出力を受け取る。
// ボードはブラウザにあるので、herdr の中でペインを切り替えただけでは端末アプリが後ろに隠れたままになる。

const APP_BUNDLE = /^(.*?\.app)\/Contents\/MacOS\//;

function parseProcesses(psOutput) {
  const byPid = new Map();
  for (const line of String(psOutput || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (m) byPid.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), tty: m[3], comm: m[4] });
  }
  return byPid;
}

// 端末に付いている herdr（＝画面を出しているクライアント）から親をたどり、最初に見つかったアプリの場所を返す
function findTerminalApp(psOutput) {
  const byPid = parseProcesses(psOutput);
  for (const p of byPid.values()) {
    const isClient = p.tty !== '??' && p.tty !== '?' && /(^|\/)herdr$/.test(p.comm);
    if (!isClient) continue;
    const seen = new Set();
    for (let cur = p; cur && !seen.has(cur.pid); cur = byPid.get(cur.ppid)) {
      seen.add(cur.pid);
      const m = cur.comm.match(APP_BUNDLE);
      if (m) return m[1];
    }
  }
  return '';
}

module.exports = { findTerminalApp };
