'use strict';
// dopadopa の数え方と状態の決め方。入出力（socket / HTTP / ファイル）は server.js が持ち、
// ここは時刻と通知先を外から受け取るだけにして、テストで同じ結果を再現できるようにする。
//
// 定義は docs/data-mapping.md と揃えること。
//  ステップ = ツール操作 1 回の完了（PostToolUse）
//  タスク   = 1 回の指示への対応が完了（Stop。フックが届かないセッションは herdr の working → idle/done）

const path = require('node:path');

const MILESTONE_STEPS = 100;
// 大きな区切りの間が空きすぎないよう、その手前に小さな区切りを置く
const SMALL_MARK_STEPS = 25;
const TURN_MARK_STEPS = 10;
const STREAK_MARKS = [50, 100, 150];
const RUN_BADGE_MIN = 10;
const GOAL_START = 10;
const GOAL_INCREMENT = 5;
const FAST_APPROVAL_SECONDS = 10;
const DEFAULT_STREAK_MS = 3 * 60 * 1000;
const FEED_MAX = 200;
const FLOW_MAX = 14;
const TITLE_MAX = 120;
const SAY_MAX = 280;
// 実測でコマンドの説明は最長 126 文字。途中で切らずに渡し、何行見せるかは画面が決める
const OP_TEXT_MAX = 130;
const PACE_WINDOW_MS = 60 * 1000;
const HOURS_IN_DAY = 24;
const DONE_MAX = 200;
const DONE_SHOWN = 30;
// ステップの内訳。実測では操作は調べる → 書く → 確かめるの順に進まず行き来するので、段階ではなく種類ごとの件数として出す
const KINDS = ['look', 'write', 'run', 'check'];
const KIND_OF_MODE = { think: 'look', edit: 'write', run: 'run', test: 'check' };
// フックを設定ファイルとプラグインの両方に入れると、同じ出来事が同時に 2 通届く（実測で中身は 1 バイトも違わない）
const REPEAT_WINDOW_MS = 2000;

const MISSIONS = [
  { id: 'fast', label: '許可待ちを10秒以内に承認する（2回）', target: 2 },
  { id: 'streak', label: '止まらずに100ステップ進める', target: 100 },
  { id: 'tests', label: 'テストを400件通過させる', target: 400 },
];

const WORKING_STATES = new Set(['think', 'edit', 'run', 'test']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
// Enter / esc を送ると意図しない選択になるため、承認・拒否ボタンを出さないツール
// 値は、その操作で止まっているときに画面へ出す説明（許可ではないので「許可待ち」とは書かない）
const NO_RESPOND_TOOLS = new Map([
  ['AskUserQuestion', '質問への回答を待っています'],
  ['ExitPlanMode', '計画の確認を待っています'],
]);
const TEST_COMMAND = /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?test\b|(npx\s+|bunx\s+)?(jest|vitest|mocha|playwright\s+test)\b|pytest\b|python3?\s+-m\s+(pytest|unittest)\b|go\s+test\b|cargo\s+test\b|node\s+--test\b|deno\s+test\b|swift\s+test\b|xcodebuild\s+[^\n]*\btest\b|rspec\b|phpunit\b|make\s+test\b)/;
// 結果行から通過件数を拾う。ランナーごとに 1 行だけ数え、同じ出力を二重に数えない。
const TEST_RESULT_PATTERNS = [
  /Tests:\s+(?:\d+\s+\w+,\s+)*?(\d+)\s+passed/, // jest
  /Tests\s+(?:\d+\s+\w+\s+\|\s+)*?(\d+)\s+passed/, // vitest
  /test result: \w+\.\s+(\d+)\s+passed/, // cargo
  /^(?:#|ℹ)\s+pass\s+(\d+)\s*$/m, // node --test
  /(\d+)\s+passed(?:,|\s+in\s)/, // pytest / playwright
  /(\d+)\s+passing\b/, // mocha
];

function dayKeyOf(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function firstLine(s) {
  return String(s || '').split('\n')[0];
}

function isTestCommand(tool, input) {
  return tool === 'Bash' && TEST_COMMAND.test(String(input?.command || ''));
}

function countPassedTests(text) {
  const s = String(text || '');
  for (const re of TEST_RESULT_PATTERNS) {
    const m = s.match(re);
    if (m) return Number(m[1]);
  }
  return 0;
}

// Claude の説明文は Markdown で書かれる。カードに出すのは地の文だけなので、見出し・表・コードの塊を落とす
function plainText(markdown) {
  const kept = [];
  let inCode = false;
  for (const raw of String(markdown || '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) { inCode = !inCode; continue; }
    if (inCode || !line || line.startsWith('#') || line.startsWith('|') || /^[-=*_]{3,}$/.test(line)) continue;
    kept.push(line
      .replace(/^(?:[-*+]|\d+\.)\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|`)/g, ''));
  }
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

function countLines(s) {
  const t = String(s || '');
  return t ? t.replace(/\n$/, '').split('\n').length : 0;
}

function changedLines(tool, input = {}) {
  if (tool === 'Write') return countLines(input.content);
  if (tool === 'Edit') return countLines(input.new_string);
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) return input.edits.reduce((n, e) => n + countLines(e.new_string), 0);
  if (tool === 'NotebookEdit') return countLines(input.new_source);
  return 0;
}

// 進行中は「〜中」、終わった操作の一覧では言い切りの形にする
function describe(tool, input = {}, finished = false) {
  const f = input.file_path || input.path || input.notebook_path;
  const base = f ? path.basename(String(f)) : '';
  const ing = finished ? '' : '中';
  if (EDIT_TOOLS.has(tool)) return `${base} を編集${ing}`;
  switch (tool) {
    case 'Read': return `${base} を読み込み${ing}`;
    // Bash には人が読める説明（description）が付く。無いときだけコマンドそのものを出す
    case 'Bash': return input.description ? String(input.description).replace(/\s+/g, ' ').trim().slice(0, OP_TEXT_MAX) : `$ ${firstLine(input.command).slice(0, OP_TEXT_MAX)}`;
    case 'Grep': return `「${String(input.pattern || '').slice(0, 30)}」を検索${ing}`;
    case 'Glob': return `ファイルを探索${ing}`;
    case 'WebFetch': case 'WebSearch': return `Web を調査${ing}`;
    case 'Agent': case 'Task': return input.description ? `サブエージェントに依頼${ing}: ${String(input.description).slice(0, OP_TEXT_MAX)}` : `サブエージェントに依頼${ing}`;
    case 'AskUserQuestion': return 'あなたへの質問';
    case 'Skill': return input.skill ? `手順書「${String(input.skill).slice(0, 30)}」を読み込み${ing}` : `手順書を読み込み${ing}`;
    default: return tool || '';
  }
}

// 許可待ちの帯に出す「何の許可か」
function askText(tool, input = {}) {
  if (tool === 'Bash') return firstLine(input.command).slice(0, 80);
  const f = input.file_path || input.path || input.notebook_path;
  if (f && EDIT_TOOLS.has(tool)) return `${path.basename(String(f))} の編集`;
  return tool || '';
}

function modeOf(tool, input) {
  if (EDIT_TOOLS.has(tool)) return 'edit';
  if (tool === 'Bash') return isTestCommand(tool, input) ? 'test' : 'run';
  return 'think';
}

function blankKinds() {
  return Object.fromEntries(KINDS.map((k) => [k, 0]));
}

function blankToday(day) {
  return {
    day, steps: 0, tasks: 0, tests: 0, approvals: 0,
    streak: 0, best: 0, streakDeadline: 0,
    goal: { target: GOAL_START, done: 0 },
    fast: 0, claimed: {}, perSession: {},
    hours: new Array(HOURS_IN_DAY).fill(0), done: [], kinds: blankKinds(),
  };
}

function createCore({ now = Date.now, streakMs = DEFAULT_STREAK_MS, emit = () => {}, onChange = () => {} } = {}) {
  const agents = new Map(); // key = herdr の pane id（フックだけで pane 不明なら "session:<id>"）
  const sessionToKey = new Map();
  const feed = [];
  let feedSeq = 0;
  let today = blankToday(dayKeyOf(now()));
  let recent = []; // 直近 1 分のステップの時刻。「勢い」の表示に使い、保存はしない

  function blankAgent(key) {
    return {
      key, pane: key.startsWith('session:') ? null : key, name: key, kind: '', cwd: '', branch: '',
      status: 'unknown', hooked: false, terminalTitle: '',
      title: '', activity: '', notice: '', mode: 'think', failing: false,
      turnOpen: false, turnStartedAt: null, doneAt: null, activeAt: 0, blockedSince: null, responded: false,
      turnSteps: 0, run: 0, lines: 0, tests: 0, kinds: blankKinds(), say: '', sayAt: null, flow: [], pending: new Map(),
    };
  }
  function getAgent(key) {
    if (!agents.has(key)) agents.set(key, blankAgent(key));
    return agents.get(key);
  }
  function pushFlow(a, entry) {
    a.flow.push({ ...entry, t: now() });
    if (a.flow.length > FLOW_MAX) a.flow.shift();
  }
  function pushFeed(name, text, kind) {
    feed.unshift({ id: ++feedSeq, t: now(), name, text, kind });
    if (feed.length > FEED_MAX) feed.length = FEED_MAX;
  }
  function send(type, a, extra = {}) {
    emit({ type, t: now(), key: a ? a.key : null, name: a ? a.name : null, ...extra });
  }

  function rollover() {
    const day = dayKeyOf(now());
    if (day !== today.day) today = blankToday(day);
  }

  function missionValues() {
    return { fast: today.fast, streak: today.best, tests: today.tests };
  }
  function checkMissions() {
    const vals = missionValues();
    for (const m of MISSIONS) {
      if (vals[m.id] >= m.target && !today.claimed[m.id]) {
        today.claimed[m.id] = true;
        pushFeed('ほかの目標', `達成: ${m.label}`, 'done');
        send('mission', null, { id: m.id, label: m.label });
      }
    }
  }

  function openTurn(a, title) {
    a.turnOpen = true;
    a.turnStartedAt = now();
    a.doneAt = null;
    a.turnSteps = 0; a.lines = 0; a.tests = 0; a.kinds = blankKinds(); a.flow = []; a.say = ''; a.sayAt = null;
    a.failing = false;
    a.pending.clear();
    if (title !== undefined) a.title = title;
  }

  function completeTask(a) {
    if (!a.turnOpen) return;
    a.turnOpen = false;
    a.doneAt = now();
    a.failing = false;
    a.pending.clear();
    today.tasks++;
    today.goal.done++;
    const title = a.title || a.terminalTitle;
    const seconds = a.turnStartedAt ? Math.round((a.doneAt - a.turnStartedAt) / 1000) : 0;
    today.done.push({ t: a.doneAt, name: a.name, title, steps: a.turnSteps, seconds });
    if (today.done.length > DONE_MAX) today.done.shift();
    pushFeed(a.name, title ? `タスク完了: ${title}` : 'タスク完了', 'done');
    send('task', a, { title, tasks: today.tasks, steps: a.turnSteps, seconds });
    if (today.goal.done >= today.goal.target) {
      const reached = today.goal.target;
      today.goal.target += GOAL_INCREMENT;
      pushFeed('今日の目標', `達成: タスク ${reached} 件完了`, 'done');
      send('goal', null, { target: reached, next: today.goal.target });
    }
  }

  function stepDone(a, kind) {
    today.steps++;
    today.kinds[kind]++;
    a.kinds[kind]++;
    today.perSession[a.name] = (today.perSession[a.name] || 0) + 1;
    a.turnSteps++;
    a.run++;
    today.streak++;
    today.streakDeadline = now() + streakMs;
    if (today.streak > today.best) today.best = today.streak;
    today.hours[new Date(now()).getHours()]++;
    recent.push(now());
    recent = recent.filter((t) => t > now() - PACE_WINDOW_MS);
    send('step', a, { steps: today.steps, run: a.run, turnSteps: a.turnSteps, stepKind: kind, first: a.kinds[kind] === 1 });
    if (a.turnSteps % TURN_MARK_STEPS === 0) send('turn_mark', a, { turnSteps: a.turnSteps });
    if (today.steps % MILESTONE_STEPS !== 0 && today.steps % SMALL_MARK_STEPS === 0) {
      send('mark', null, { steps: today.steps, next: (Math.floor(today.steps / MILESTONE_STEPS) + 1) * MILESTONE_STEPS });
    }
    if (today.steps % MILESTONE_STEPS === 0) {
      pushFeed('今日完了したステップ', `今日 ${today.steps} ステップ完了`, 'done');
      send('milestone', null, { steps: today.steps, next: today.steps + MILESTONE_STEPS });
    }
    if (STREAK_MARKS.includes(today.streak)) send('streak', null, { streak: today.streak });
    checkMissions();
  }

  function setStatus(a, status) {
    if (!status || status === a.status) return;
    const prev = a.status;
    a.status = status;
    a.activeAt = now();
    if (status === 'blocked') {
      a.blockedSince = now();
      const ask = currentAsk(a);
      pushFeed(a.name, ask && ask.canRespond ? `許可待ち: ${ask.text}` : `あなた待ち: ${waitNotice(a, ask)}`, 'wait');
      send('blocked', a, { ask: ask && ask.canRespond ? ask.text : '' });
    } else {
      a.blockedSince = null;
    }
    a.responded = false;
    // フックが届かないセッションは herdr の状態だけでタスクの区切りを決める
    if (!a.hooked) {
      if (status === 'working' && !a.turnOpen) openTurn(a);
      if ((status === 'idle' || status === 'done') && prev === 'working') completeTask(a);
    }
  }

  function waitNotice(a, ask) {
    return (ask && ask.waitText) || a.notice || 'あなたの対応を待っています';
  }
  function currentAsk(a) {
    for (const p of a.pending.values()) return p;
    return null;
  }

  // ---------------------------------------------------------------- herdr
  function setHerdrAgents(items) {
    rollover();
    const seen = new Set();
    for (const it of items) {
      if (!it.pane) continue;
      seen.add(it.pane);
      const a = getAgent(it.pane);
      if (it.cwd) { a.cwd = it.cwd; a.name = path.basename(it.cwd) || a.name; }
      a.kind = it.kind || a.kind;
      a.branch = it.branch || '';
      a.terminalTitle = it.title || '';
      if (it.sessionId) sessionToKey.set(it.sessionId, it.pane);
      setStatus(a, it.status);
    }
    for (const [key, a] of agents) if (a.pane && !seen.has(a.pane)) agents.delete(key);
    onChange();
  }

  function setPaneStatus(pane, status) {
    if (!agents.has(pane)) return;
    rollover();
    setStatus(agents.get(pane), status);
    onChange();
  }

  // ---------------------------------------------------------------- Claude Code hooks
  function resolveKey(pane, ev) {
    const sid = ev.session_id;
    if (pane) { if (sid) sessionToKey.set(sid, pane); return pane; }
    if (sid && sessionToKey.has(sid)) return sessionToKey.get(sid);
    for (const a of agents.values()) if (a.pane && ev.cwd && a.cwd === ev.cwd) { if (sid) sessionToKey.set(sid, a.key); return a.key; }
    return 'session:' + (sid || 'unknown');
  }

  // derived = 会話記録から組み立てた出来事。フックが届いているセッションでは二重に数えないよう捨てる
  function handleHook(pane, ev, { derived = false } = {}) {
    if (!ev || typeof ev !== 'object' || !ev.hook_event_name) return;
    rollover();
    const a = getAgent(resolveKey(pane, ev));
    if (derived && a.hooked) return;
    if (!derived) a.hooked = true;
    a.activeAt = now();
    if (!a.cwd && ev.cwd) { a.cwd = ev.cwd; a.name = path.basename(ev.cwd) || a.name; }
    const tool = ev.tool_name;
    const input = ev.tool_input || {};
    const paneless = !a.pane;

    switch (ev.hook_event_name) {
      case 'UserPromptSubmit': {
        const title = String(ev.prompt || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
        // フックなしのセッションは herdr の状態で先に区切りが始まっていることがある。そのときは数字を消さず題だけ入れる
        if (derived && a.turnOpen && a.turnSteps === 0) a.title = title;
        else openTurn(a, title);
        a.activity = '';
        if (paneless) setStatus(a, 'working');
        pushFeed(a.name, a.title ? `新しいタスクを開始: ${a.title}` : '新しいタスクを開始', 'think');
        break;
      }
      case 'PreToolUse': {
        if (!a.turnOpen) openTurn(a);
        a.mode = modeOf(tool, input);
        a.activity = describe(tool, input);
        a.pending.set(ev.tool_use_id || `${tool}:${now()}`, { tool, text: askText(tool, input), canRespond: !NO_RESPOND_TOOLS.has(tool), waitText: NO_RESPOND_TOOLS.get(tool) || '' });
        if (paneless) setStatus(a, 'working');
        break;
      }
      case 'PostToolUse': {
        a.pending.delete(ev.tool_use_id);
        pushFlow(a, { kind: 'op', text: describe(tool, input, true), ok: true });
        a.lines += changedLines(tool, input);
        if (isTestCommand(tool, input)) {
          const passed = countPassedTests(ev.tool_response?.stdout);
          a.tests += passed; today.tests += passed;
          const recovered = a.failing;
          if (recovered) { a.failing = false; pushFeed(a.name, '修正後のテストが通りました', 'done'); }
          stepDone(a, 'check');
          // 画面のポップは後から来たもので置き換わる。ステップより後に送り、テスト通過のほうを残す
          if (passed > 0 || recovered) send('tests', a, { passed, recovered });
          break;
        }
        stepDone(a, KIND_OF_MODE[modeOf(tool, input)]);
        break;
      }
      case 'PostToolUseFailure': {
        a.pending.delete(ev.tool_use_id);
        if (ev.is_interrupt) break;
        pushFlow(a, { kind: 'op', text: describe(tool, input, true), ok: false });
        a.run = 0;
        if (isTestCommand(tool, input)) {
          const passed = countPassedTests(ev.error);
          a.tests += passed; today.tests += passed;
          a.failing = true;
          a.activity = 'テスト失敗 → 原因を特定して修正中';
          pushFeed(a.name, 'テスト失敗を検知、自動で修正中', 'error');
          send('error', a);
          checkMissions();
        }
        break;
      }
      case 'Notification':
        a.notice = String(ev.message || '');
        break;
      case 'Stop':
        completeTask(a);
        a.activity = '';
        if (paneless) setStatus(a, 'done');
        break;
      case 'SessionEnd':
        if (paneless) agents.delete(a.key);
        break;
    }
    onChange();
  }

  // ---------------------------------------------------------------- 会話記録（Claude の説明文）
  // initial = ボードを開いた時点で既にあった最後の説明文。流れには足さず、カードの表示だけ埋める
  function addNarration(sessionId, markdown, { initial = false } = {}) {
    const a = agents.get(sessionToKey.get(sessionId));
    if (!a) return;
    const text = plainText(markdown).slice(0, SAY_MAX);
    if (!text || (initial && a.say)) return;
    a.say = text;
    a.sayAt = now();
    if (!initial) a.activeAt = now();
    if (!initial) pushFlow(a, { kind: 'say', text });
    onChange();
  }
  function handleDerived(sessionId, ev) {
    const key = sessionToKey.get(sessionId);
    if (key) handleHook(key, ev, { derived: true });
  }

  // ---------------------------------------------------------------- 承認・拒否の記録
  function recordResponse(key, action) {
    const a = agents.get(key);
    if (!a) return;
    const ask = currentAsk(a);
    const waited = a.blockedSince ? Math.round((now() - a.blockedSince) / 1000) : 0;
    const what = ask ? ask.text : '';
    // 同じ許可待ちにキーを二度送ると、プロンプトが消えたあとの画面に Enter が入ってしまう
    a.responded = true;
    if (action === 'approve') {
      today.approvals++;
      if (waited <= FAST_APPROVAL_SECONDS) today.fast++;
      if (today.streak > 0) today.streakDeadline = now() + streakMs;
      pushFeed(a.name, `承認: ${what}（待ち時間 ${waited}秒）`, 'done');
      send('approved', a, { waited });
      checkMissions();
    } else {
      pushFeed(a.name, `拒否: ${what}`, 'error');
    }
    onChange();
  }

  function canRespond(key) {
    const a = agents.get(key);
    if (!a || !a.pane || a.status !== 'blocked' || a.responded) return false;
    const ask = currentAsk(a);
    return !!ask && ask.canRespond;
  }

  // ---------------------------------------------------------------- 時間で変わるもの
  function tick() {
    const before = today.day;
    rollover();
    let changed = before !== today.day;
    if (today.streak > 0 && now() >= today.streakDeadline) {
      pushFeed('連続記録', `${today.streak}ステップで止まりました（最高 ${today.best}）`, 'error');
      send('streak_reset', null, { streak: today.streak, best: today.best });
      today.streak = 0;
      today.streakDeadline = 0;
      changed = true;
    }
    if (changed) onChange();
  }

  // ---------------------------------------------------------------- 表示用
  function displayState(a) {
    if (a.status === 'blocked') return 'wait';
    // Stop が届いてから herdr が idle に変わるまでの短い間を「考え中」と見せない
    if (a.status === 'working' && (a.turnOpen || !a.hooked)) return a.failing ? 'error' : a.mode;
    return a.doneAt ? 'done' : 'idle';
  }

  function snapshot() {
    const order = { wait: 0, error: 1, think: 1, edit: 1, run: 1, test: 1, done: 2, idle: 3 };
    const list = [...agents.values()].map((a) => {
      const state = displayState(a);
      const ask = a.status === 'blocked' ? currentAsk(a) : null;
      return {
        key: a.key, pane: a.pane, name: a.name, branch: a.branch, state,
        title: a.title || a.terminalTitle,
        activity: a.activity, notice: a.status === 'blocked' ? waitNotice(a, ask) : '',
        ask: ask && ask.canRespond ? ask.text : '', canRespond: canRespond(a.key),
        blockedSince: a.blockedSince, turnStartedAt: a.turnOpen || a.doneAt ? a.turnStartedAt : null, doneAt: a.doneAt,
        turnSteps: a.turnSteps, daySteps: today.perSession[a.name] || 0,
        run: a.run, showRun: a.run >= RUN_BADGE_MIN && WORKING_STATES.has(state),
        activeAt: a.activeAt, lines: a.lines, tests: a.tests, kinds: { ...a.kinds }, say: a.say, sayAt: a.sayAt, flow: a.flow.slice(),
      };
    });
    // 左から: 長く待たせている順 → 新しく指示を受けた順 → 最近まで動いていた順。作業中の並びはステップごとに入れ替えない
    const within = (x, y) => {
      if (order[x.state] === 0) return x.blockedSince - y.blockedSince;
      if (order[x.state] === 1) return (y.turnStartedAt || 0) - (x.turnStartedAt || 0);
      return y.activeAt - x.activeAt;
    };
    list.sort((x, y) => order[x.state] - order[y.state] || within(x, y) || x.name.localeCompare(y.name) || x.key.localeCompare(y.key));
    const vals = missionValues();
    return {
      type: 'snapshot', now: now(),
      today: {
        steps: today.steps, tasks: today.tasks, tests: today.tests,
        streak: today.streak, best: today.best, streakDeadline: today.streakDeadline, streakWindow: streakMs,
        milestone: MILESTONE_STEPS,
        goal: { target: today.goal.target, done: today.goal.done },
        missions: MISSIONS.map((m) => ({ id: m.id, label: m.label, target: m.target, value: Math.min(vals[m.id], m.target), done: !!today.claimed[m.id] })),
        hours: today.hours.slice(), kinds: { ...today.kinds },
        done: today.done.slice(-DONE_SHOWN).reverse(),
        recent: recent.filter((t) => t > now() - PACE_WINDOW_MS), paceWindow: PACE_WINDOW_MS,
        rank: Object.entries(today.perSession).map(([name, steps]) => ({ name, steps })).sort((x, y) => y.steps - x.steps || x.name.localeCompare(y.name)),
      },
      agents: list,
      feed: feed.slice(0, 30),
    };
  }

  // ---------------------------------------------------------------- 保存
  function exportStats() {
    const stats = JSON.parse(JSON.stringify(today));
    // ファイルに残すのは件数とフォルダ名だけ。指示文（題）は保存しない
    stats.done = stats.done.map(({ title, ...rest }) => rest);
    return stats;
  }
  function importStats(saved) {
    if (!saved || typeof saved !== 'object' || saved.day !== dayKeyOf(now())) return false;
    const base = blankToday(saved.day);
    const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
    today = {
      ...base,
      steps: num(saved.steps, 0), tasks: num(saved.tasks, 0), tests: num(saved.tests, 0), approvals: num(saved.approvals, 0),
      streak: num(saved.streak, 0), best: num(saved.best, 0), streakDeadline: num(saved.streakDeadline, 0),
      goal: { target: num(saved.goal?.target, GOAL_START) || GOAL_START, done: num(saved.goal?.done, 0) },
      fast: num(saved.fast, 0),
      claimed: saved.claimed && typeof saved.claimed === 'object' ? { ...saved.claimed } : {},
      perSession: {},
    };
    if (Array.isArray(saved.hours) && saved.hours.length === HOURS_IN_DAY) today.hours = saved.hours.map((v) => num(v, 0));
    if (saved.kinds && typeof saved.kinds === 'object') for (const k of KINDS) today.kinds[k] = num(saved.kinds[k], 0);
    if (Array.isArray(saved.done)) {
      today.done = saved.done.filter((d) => d && typeof d === 'object').slice(-DONE_MAX)
        .map((d) => ({ t: num(d.t, 0), name: String(d.name || ''), title: String(d.title || ''), steps: num(d.steps, 0), seconds: num(d.seconds, 0) }));
    }
    if (saved.perSession && typeof saved.perSession === 'object') {
      for (const [k, v] of Object.entries(saved.perSession)) today.perSession[k] = num(v, 0);
    }
    return true;
  }

  return { handleHook, handleDerived, addNarration, setHerdrAgents, setPaneStatus, recordResponse, canRespond, tick, snapshot, exportStats, importStats, agents, dayKey: () => today.day };
}

// 同じ内容が短い間に続けて届いたら、2 通目以降を知らせる。二重に入ったフックでステップを倍に数えないため
function createRepeatFilter({ windowMs = REPEAT_WINDOW_MS, now = Date.now } = {}) {
  const seenAt = new Map();
  return (key) => {
    const t = now();
    for (const [k, at] of seenAt) if (t - at >= windowMs) seenAt.delete(k);
    if (seenAt.has(key)) return true;
    seenAt.set(key, t);
    return false;
  };
}

module.exports = { createCore, createRepeatFilter, REPEAT_WINDOW_MS, dayKeyOf, plainText, isTestCommand, countPassedTests, changedLines, MILESTONE_STEPS, SMALL_MARK_STEPS, TURN_MARK_STEPS, STREAK_MARKS, GOAL_START, GOAL_INCREMENT };
