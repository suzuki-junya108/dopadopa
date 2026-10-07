#!/usr/bin/env node
'use strict';
// Watchtower bridge
//  入力1: herdr の socket API（agent.list のポーリング + events.subscribe）→ 状態（working / blocked / idle / done）
//  入力2: Claude Code の hooks（POST /hook）→ 何をしているか・Todo 進捗・残り時間
//  出力 : ブラウザのボードへ Server-Sent Events（GET /stream）
// 依存パッケージなし。Node 18 以上。

const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.WATCHTOWER_PORT || 4517);
const SOCK = process.env.HERDR_SOCKET_PATH || path.join(os.homedir(), '.config', 'herdr', 'herdr.sock');
const HERDR = process.env.HERDR_BIN_PATH || 'herdr';
const RUNTIME = path.join(os.homedir(), '.watchtower');
const ROOT = path.join(__dirname, '..');
const TOKEN = crypto.randomBytes(16).toString('hex');

fs.mkdirSync(RUNTIME, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(RUNTIME, 'token'), TOKEN, { mode: 0o600 });
fs.writeFileSync(path.join(RUNTIME, 'port'), String(PORT));
fs.copyFileSync(path.join(ROOT, 'hooks', 'forward.sh'), path.join(RUNTIME, 'forward.sh'));

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- state
const agents = new Map(); // key = herdr pane id（hook だけで pane 不明なら "session:<id>"）
const sessionToKey = new Map();
const feed = []; // 全体の出来事（新しい順）
const stats = { tasksDone: 0, steps: 0, approvals: 0, startedAt: Date.now() };

function blank(key) {
  return {
    key, pane: key.startsWith('session:') ? null : key, name: key, kind: '', cwd: '',
    status: 'unknown', blockedSince: null, doneAt: null,
    title: '', summary: '', lastAction: '', notice: '',
    todos: [], stepTimes: [], lastStepAt: Date.now(),
    filesTouched: new Set(), toolCount: 0, updatedAt: Date.now(),
  };
}
function getAgent(key) {
  if (!agents.has(key)) agents.set(key, blank(key));
  return agents.get(key);
}
function pushFeed(a, text, kind) {
  feed.unshift({ t: Date.now(), key: a.key, name: a.name, text, kind });
  if (feed.length > 200) feed.length = 200;
}

// 任意の深さから最初に見つかったキーの値を返す（socket のペイロード形状の差を吸収）
function pick(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  for (const v of Object.values(obj)) {
    const r = pick(v, keys, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

function setStatus(a, status) {
  if (!status || status === a.status) return;
  const prev = a.status;
  a.status = status;
  a.updatedAt = Date.now();
  if (status === 'blocked') { a.blockedSince = Date.now(); pushFeed(a, a.notice || 'あなたの対応を待っています', 'wait'); }
  else a.blockedSince = null;
  if (status === 'working' && prev !== 'working') pushFeed(a, '作業を開始', 'work');
  if ((status === 'done' || status === 'idle') && prev === 'working') {
    a.doneAt = Date.now(); stats.tasksDone++;
    pushFeed(a, 'ターン完了', 'done');
  }
  schedule();
}

// ---------------------------------------------------------------- herdr socket
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = 'wt-' + crypto.randomBytes(4).toString('hex');
    const c = net.createConnection(SOCK);
    let buf = '';
    const timer = setTimeout(() => { c.destroy(); reject(new Error('timeout ' + method)); }, 5000);
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
      const st = pick(m, ['agent_status', 'status', 'state']);
      if (typeof st === 'string' && st !== 'subscription_started') setStatus(getAgent(pane), st);
    }
  });
  const drop = () => subscribed.delete(pane);
  c.on('error', drop); c.on('close', drop);
}

async function poll() {
  try {
    const r = await request('agent.list');
    const items = Array.isArray(r) ? r : (r && (r.agents || r.items)) || [];
    const seen = new Set();
    for (const it of items) {
      const pane = it.pane_id || it.pane || it.id;
      if (!pane) continue;
      seen.add(pane);
      const a = getAgent(pane);
      a.name = it.name || it.label || a.name;
      a.kind = it.kind || it.agent || a.kind;
      a.cwd = it.cwd || a.cwd;
      setStatus(a, it.agent_status || it.status || it.state);
      subscribe(pane);
    }
    for (const [key, a] of agents) {
      if (a.pane && !seen.has(a.pane)) { agents.delete(key); subscribed.get(key)?.destroy(); }
    }
    schedule();
  } catch (e) {
    log('herdr poll failed:', e.message);
  }
}
setInterval(poll, 3000);
poll();

// ---------------------------------------------------------------- Claude Code hooks
function describe(tool, input = {}) {
  const f = input.file_path || input.path || input.notebook_path;
  const base = f ? path.basename(f) : '';
  switch (tool) {
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return `${base} を編集`;
    case 'Read': return `${base} を読み込み`;
    case 'Bash': return `$ ${String(input.command || '').split('\n')[0].slice(0, 70)}`;
    case 'Grep': return `「${String(input.pattern || '').slice(0, 30)}」を検索`;
    case 'Glob': return 'ファイルを探索';
    case 'WebFetch': case 'WebSearch': return 'Web を調査';
    case 'Task': return 'サブエージェントに依頼';
    case 'TodoWrite': return 'Todo を更新';
    default: return tool || '';
  }
}

function resolveKey(pane, ev) {
  const sid = ev.session_id;
  if (pane) { if (sid) sessionToKey.set(sid, pane); return pane; }
  if (sid && sessionToKey.has(sid)) return sessionToKey.get(sid);
  // pane が分からない場合は cwd が一致する herdr エージェントに寄せる
  for (const a of agents.values()) if (a.pane && ev.cwd && a.cwd === ev.cwd) { sessionToKey.set(sid, a.key); return a.key; }
  return 'session:' + (sid || 'unknown');
}

function updateTodos(a, todos) {
  const before = new Map(a.todos.map((t) => [t.content, t.status]));
  for (const t of todos) {
    if (t.status === 'completed' && before.get(t.content) !== 'completed') {
      const now = Date.now();
      a.stepTimes.push(now - a.lastStepAt);
      if (a.stepTimes.length > 20) a.stepTimes.shift();
      a.lastStepAt = now;
      stats.steps++;
      pushFeed(a, '完了: ' + t.content, 'step');
    }
  }
  a.todos = todos.map((t) => ({ content: t.content, status: t.status, activeForm: t.activeForm || t.content }));
}

function handleHook(pane, ev) {
  const a = getAgent(resolveKey(pane, ev));
  if (!a.pane && ev.cwd) a.name = path.basename(ev.cwd);
  a.cwd = a.cwd || ev.cwd || '';
  a.updatedAt = Date.now();
  switch (ev.hook_event_name) {
    case 'SessionStart': pushFeed(a, 'セッション開始', 'work'); break;
    case 'UserPromptSubmit':
      a.title = String(ev.prompt || '').replace(/\s+/g, ' ').slice(0, 60);
      a.todos = []; a.stepTimes = []; a.lastStepAt = Date.now(); a.doneAt = null;
      pushFeed(a, '新しい指示: ' + a.title, 'work');
      break;
    case 'PreToolUse':
      a.lastAction = describe(ev.tool_name, ev.tool_input);
      a.toolCount++;
      if (ev.tool_name === 'TodoWrite' && Array.isArray(ev.tool_input?.todos)) updateTodos(a, ev.tool_input.todos);
      { const f = ev.tool_input?.file_path; if (f && /Edit|Write/.test(ev.tool_name)) a.filesTouched.add(f); }
      break;
    case 'Notification':
      a.notice = String(ev.message || '');
      pushFeed(a, a.notice, 'wait');
      break;
    case 'Stop': a.lastAction = '返答を完了'; break;
    case 'SessionEnd': pushFeed(a, 'セッション終了', 'done'); break;
  }
  schedule();
}

// ---------------------------------------------------------------- snapshot / ETA
function snapshot() {
  const now = Date.now();
  const list = [...agents.values()].map((a) => {
    const total = a.todos.length;
    const done = a.todos.filter((t) => t.status === 'completed').length;
    const current = a.todos.find((t) => t.status === 'in_progress');
    let eta = null;
    if (total && done < total && a.stepTimes.length) {
      const avg = a.stepTimes.reduce((x, y) => x + y, 0) / a.stepTimes.length;
      const remaining = Math.max(0, (total - done) * avg - (now - a.lastStepAt));
      eta = { low: Math.round(remaining * 0.7 / 1000), high: Math.round(remaining * 1.3 / 1000), samples: a.stepTimes.length };
    }
    return {
      key: a.key, pane: a.pane, name: a.name, kind: a.kind, status: a.status,
      title: a.title, summary: current ? current.activeForm : a.lastAction, lastAction: a.lastAction,
      notice: a.status === 'blocked' ? a.notice : '',
      blockedFor: a.blockedSince ? Math.round((now - a.blockedSince) / 1000) : 0,
      justDone: a.doneAt && now - a.doneAt < 6000,
      todos: a.todos, done, total, eta,
      files: a.filesTouched.size, tools: a.toolCount,
    };
  });
  const order = { blocked: 0, working: 1, idle: 2, done: 2, unknown: 3 };
  list.sort((x, y) => (order[x.status] ?? 3) - (order[y.status] ?? 3) || x.name.localeCompare(y.name));
  return { now, agents: list, feed: feed.slice(0, 30), stats };
}

// ---------------------------------------------------------------- SSE
const clients = new Set();
let pending = null;
function schedule() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    const data = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
    for (const res of clients) res.write(data);
  }, 120);
}
setInterval(schedule, 1000); // 経過時間・残り時間の表示を毎秒更新

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
// 注意: Claude Code の許可プロンプトに送るキーはバージョンで変わる可能性がある。
// `herdr agent send-keys --help` と実際のプロンプトで確認してから使うこと。
const KEYS = { approve: ['Enter'], deny: ['Escape'] };

// ---------------------------------------------------------------- HTTP
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const tokenOk = req.headers['x-watchtower-token'] === TOKEN || url.searchParams.get('token') === TOKEN;

  if (req.method === 'GET' && url.pathname === '/') {
    const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8').replace('__WATCHTOWER_TOKEN__', TOKEN);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (!tokenOk) { res.writeHead(403); return res.end('forbidden'); }

  if (req.method === 'GET' && url.pathname === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/hook') {
    handleHook(url.searchParams.get('pane') || '', await readBody(req));
    res.writeHead(204); return res.end();
  }
  if (req.method === 'POST' && url.pathname === '/api/respond') {
    const { key, action } = await readBody(req);
    const a = agents.get(key);
    if (!a || !a.pane || !KEYS[action]) { res.writeHead(400); return res.end('bad request'); }
    const r = await herdr(['agent', 'send-keys', a.pane, ...KEYS[action]]);
    if (r.code === 0 && action === 'approve') stats.approvals++;
    pushFeed(a, action === 'approve' ? '承認しました' : '拒否しました', action === 'approve' ? 'done' : 'error');
    schedule();
    res.writeHead(r.code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  if (req.method === 'POST' && url.pathname === '/api/focus') {
    const { key } = await readBody(req);
    const a = agents.get(key);
    const r = a?.pane ? await herdr(['agent', 'focus', a.pane]) : { code: 1, out: 'no pane' };
    res.writeHead(r.code === 0 ? 200 : 500); return res.end(r.out);
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => log(`watchtower bridge on http://127.0.0.1:${PORT} (herdr socket: ${SOCK})`));
process.on('SIGTERM', () => process.exit(0));
