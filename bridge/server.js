#!/usr/bin/env node
'use strict';
// dopadopa bridge
//  入力1: herdr の socket API（agent.list のポーリング + events.subscribe）→ 状態（working / blocked / idle / done）
//  入力2: Claude Code の hooks（POST /hook）→ 何をしているか・ステップ・タスク
//  出力 : ブラウザのボードへ Server-Sent Events（GET /stream）
// 数え方は core.js、ここは入出力だけを持つ。依存パッケージなし。Node 18 以上。

const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createCore } = require('./core.js');

const PORT = Number(process.env.DOPADOPA_PORT || 4517);
const SOCK = process.env.HERDR_SOCKET_PATH || path.join(os.homedir(), '.config', 'herdr', 'herdr.sock');
const HERDR = process.env.HERDR_BIN_PATH || 'herdr';
const RUNTIME = path.join(os.homedir(), '.dopadopa');
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || RUNTIME;
const ROOT = path.join(__dirname, '..');
const TOKEN = crypto.randomBytes(16).toString('hex');
const STREAK_SECONDS = Number(process.env.DOPADOPA_STREAK_SECONDS) > 0 ? Number(process.env.DOPADOPA_STREAK_SECONDS) : 180;

const POLL_MS = 3000;
const TICK_MS = 1000;
const SNAPSHOT_MIN_INTERVAL_MS = 1000;
const SAVE_DELAY_MS = 2000;
const KEEPALIVE_MS = 20000;
const BRANCH_CACHE_MS = 10000;
const SOCKET_TIMEOUT_MS = 5000;
const BODY_LIMIT_BYTES = 2e6;

fs.mkdirSync(RUNTIME, { recursive: true, mode: 0o700 });
fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(RUNTIME, 'token'), TOKEN, { mode: 0o600 });
fs.chmodSync(path.join(RUNTIME, 'token'), 0o600);
fs.writeFileSync(path.join(RUNTIME, 'port'), String(PORT));
fs.copyFileSync(path.join(ROOT, 'hooks', 'forward.sh'), path.join(RUNTIME, 'forward.sh'));

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- SSE
const clients = new Set();
function write(payload) {
  const data = 'data: ' + JSON.stringify(payload) + '\n\n';
  for (const res of clients) res.write(data);
}
let lastSnapshotAt = 0;
let snapshotTimer = null;
// 変化があったときだけ、最大で毎秒 1 回。演出のきっかけ（イベント）は待たせずに別で送る
function scheduleSnapshot() {
  if (snapshotTimer) return;
  const wait = Math.max(0, lastSnapshotAt + SNAPSHOT_MIN_INTERVAL_MS - Date.now());
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    lastSnapshotAt = Date.now();
    write(core.snapshot());
  }, wait);
}

// ---------------------------------------------------------------- 今日の数字の保存
const statsFile = (day) => path.join(STATE_DIR, `stats-${day}.json`);
let saveTimer = null;
function saveNow() {
  const stats = core.exportStats();
  const file = statsFile(stats.day);
  try {
    // 書きかけのファイルを読ませないよう、別名に書いてから置き換える
    fs.writeFileSync(file + '.tmp', JSON.stringify(stats), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  } catch (e) {
    log('stats save failed:', e.message);
  }
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, SAVE_DELAY_MS);
}

const core = createCore({
  streakMs: STREAK_SECONDS * 1000,
  emit: (event) => write({ ...event, kind: event.type, type: 'event' }),
  onChange: () => { scheduleSnapshot(); scheduleSave(); },
});
try {
  const file = statsFile(core.dayKey());
  if (fs.existsSync(file) && core.importStats(JSON.parse(fs.readFileSync(file, 'utf8')))) log('stats loaded:', file);
} catch (e) {
  log('stats load failed:', e.message);
}
setInterval(() => core.tick(), TICK_MS);
setInterval(() => { for (const res of clients) res.write(': keepalive\n\n'); }, KEEPALIVE_MS);

// ---------------------------------------------------------------- git のブランチ名
const branchCache = new Map(); // cwd -> { at, branch }
function readBranch(cwd) {
  if (!cwd) return '';
  const hit = branchCache.get(cwd);
  if (hit && Date.now() - hit.at < BRANCH_CACHE_MS) return hit.branch;
  let branch = '';
  try {
    let dir = cwd;
    for (;;) {
      const dotGit = path.join(dir, '.git');
      if (fs.existsSync(dotGit)) {
        let gitDir = dotGit;
        // worktree では .git が「gitdir: <実体>」と書かれたファイルになっている
        if (fs.statSync(dotGit).isFile()) {
          const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
          gitDir = m ? path.resolve(dir, m[1].trim()) : '';
        }
        const m = gitDir && fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').match(/^ref:\s*refs\/heads\/(.+)$/m);
        branch = m ? m[1].trim() : '';
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    branch = '';
  }
  branchCache.set(cwd, { at: Date.now(), branch });
  return branch;
}

// ---------------------------------------------------------------- herdr socket
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = 'dd-' + crypto.randomBytes(4).toString('hex');
    const c = net.createConnection(SOCK);
    let buf = '';
    const timer = setTimeout(() => { c.destroy(); reject(new Error('timeout ' + method)); }, SOCKET_TIMEOUT_MS);
    c.on('connect', () => c.write(JSON.stringify({ id, method, params }) + '\n'));
    c.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== id) continue;
        clearTimeout(timer); c.end();
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
    c.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// 任意の深さから最初に見つかったキーの値を返す（イベントのペイロード形状の差を吸収）
function pick(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  for (const v of Object.values(obj)) {
    const r = pick(v, keys, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

const subscribed = new Map(); // pane -> socket
function subscribe(pane) {
  if (subscribed.has(pane)) return;
  const c = net.createConnection(SOCK);
  subscribed.set(pane, c);
  let buf = '';
  c.on('connect', () => c.write(JSON.stringify({
    id: 'sub-' + pane, method: 'events.subscribe',
    params: { subscriptions: [{ type: 'pane.agent_status_changed', pane_id: pane }] },
  }) + '\n'));
  c.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      const st = pick(m, ['agent_status']);
      if (typeof st === 'string') core.setPaneStatus(pane, st);
    }
  });
  const drop = () => subscribed.delete(pane);
  c.on('error', drop); c.on('close', drop);
}

let herdrOk = null;
async function poll() {
  try {
    const r = await request('agent.list');
    const items = Array.isArray(r) ? r : (r && r.agents) || [];
    const seen = new Set();
    core.setHerdrAgents(items.filter((it) => it.pane_id).map((it) => {
      seen.add(it.pane_id);
      subscribe(it.pane_id);
      return {
        pane: it.pane_id, status: it.agent_status, cwd: it.cwd || it.foreground_cwd || '', kind: it.agent || '',
        title: it.terminal_title_stripped || '', sessionId: it.agent_session && it.agent_session.value,
        branch: readBranch(it.cwd || it.foreground_cwd || ''),
      };
    }));
    for (const [pane, sock] of subscribed) if (!seen.has(pane)) sock.destroy();
    if (herdrOk !== true) { herdrOk = true; log('herdr connected:', items.length, 'agents'); }
  } catch (e) {
    if (herdrOk !== false) { herdrOk = false; log('herdr poll failed:', e.message); }
  }
}
setInterval(poll, POLL_MS);
poll();

// ---------------------------------------------------------------- respond to blocked agents
function herdr(args) {
  return new Promise((resolve) => {
    const p = spawn(HERDR, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
    p.on('error', (e) => resolve({ code: -1, out: e.message }));
  });
}
// Claude Code の許可プロンプトは「1. Yes」が選ばれた状態で出るので Enter で承認、esc で取り消しになる。
// キー名は `herdr agent send-keys --help` の表記（esc が正式名）に合わせている。
const KEYS = { approve: ['Enter'], deny: ['esc'] };

// ---------------------------------------------------------------- HTTP
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > BODY_LIMIT_BYTES) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function sameToken(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const FORBIDDEN_PAGE = '<!doctype html><html lang="ja"><meta charset="utf-8"><title>dopadopa</title>'
  + '<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#120A24;color:#FFFFFF;font-family:sans-serif">'
  + '<main style="max-width:32em;padding:24px;line-height:1.8"><h1 style="font-size:22px">このページは開けません</h1>'
  + '<p>ブリッジを再起動すると、前に開いたページは使えなくなります。herdr のメニューから「dopadopa: ボードを開く」を選んで開き直してください。</p></main></body></html>';

const server = http.createServer(async (req, res) => {
  // 別サイトが名前解決を差し替えてこのポートを叩く攻撃（DNS リバインディング）を、Host の照合で止める
  if (!ALLOWED_HOSTS.has(req.headers.host)) { res.writeHead(403); return res.end('forbidden'); }
  const url = new URL(req.url, 'http://127.0.0.1');
  const tokenOk = sameToken(req.headers['x-dopadopa-token']) || sameToken(url.searchParams.get('token'));

  if (!tokenOk) {
    const wantsPage = req.method === 'GET' && url.pathname === '/';
    res.writeHead(403, { 'Content-Type': wantsPage ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(wantsPage ? FORBIDDEN_PAGE : 'forbidden');
  }

  if (req.method === 'GET' && url.pathname === '/') {
    const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8').replace('__DOPADOPA_TOKEN__', TOKEN);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    return res.end(html);
  }
  if (req.method === 'GET' && url.pathname === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: ' + JSON.stringify(core.snapshot()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/hook') {
    core.handleHook(url.searchParams.get('pane') || '', await readBody(req));
    res.writeHead(204); return res.end();
  }
  if (req.method === 'POST' && url.pathname === '/api/respond') {
    const { key, action } = await readBody(req);
    if (!KEYS[action] || !core.canRespond(key)) { res.writeHead(409, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ code: 1, out: 'not waiting for approval' })); }
    const r = await herdr(['agent', 'send-keys', core.agents.get(key).pane, ...KEYS[action]]);
    if (r.code === 0) core.recordResponse(key, action);
    else log('send-keys failed:', r.out.trim());
    res.writeHead(r.code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ code: r.code }));
  }
  if (req.method === 'POST' && url.pathname === '/api/focus') {
    const { key } = await readBody(req);
    const a = core.agents.get(key);
    const r = a && a.pane ? await herdr(['agent', 'focus', a.pane]) : { code: 1, out: 'no pane' };
    if (r.code !== 0) log('focus failed:', r.out.trim());
    res.writeHead(r.code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ code: r.code }));
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => log(`dopadopa bridge on http://127.0.0.1:${PORT} (herdr socket: ${SOCK})`));
function shutdown() {
  saveNow();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
