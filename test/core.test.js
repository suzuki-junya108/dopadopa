'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCore, countPassedTests, isTestCommand, changedLines, MILESTONE_STEPS, GOAL_START, GOAL_INCREMENT } = require('../bridge/core.js');

const START = new Date(2026, 9, 7, 10, 0, 0).getTime();
const STREAK_MS = 180000;

function setup() {
  const clock = { t: START };
  const events = [];
  const core = createCore({ now: () => clock.t, streakMs: STREAK_MS, emit: (e) => events.push(e) });
  const types = () => events.map((e) => e.type);
  return { clock, events, core, types };
}
const herdr = (pane, status, extra = {}) => ({ pane, status, cwd: `/work/${extra.name || 'web-app'}`, kind: 'claude', ...extra });
let toolSeq = 0;
function runTool(core, pane, tool, input, { fail = false, response = {}, error = '' } = {}) {
  const id = `tool-${++toolSeq}`;
  core.handleHook(pane, { hook_event_name: 'PreToolUse', session_id: 's-' + pane, tool_name: tool, tool_input: input, tool_use_id: id });
  if (fail) core.handleHook(pane, { hook_event_name: 'PostToolUseFailure', session_id: 's-' + pane, tool_name: tool, tool_input: input, tool_use_id: id, error });
  else core.handleHook(pane, { hook_event_name: 'PostToolUse', session_id: 's-' + pane, tool_name: tool, tool_input: input, tool_use_id: id, tool_response: response });
}
const prompt = (core, pane, text) => core.handleHook(pane, { hook_event_name: 'UserPromptSubmit', session_id: 's-' + pane, prompt: text });
const stop = (core, pane) => core.handleHook(pane, { hook_event_name: 'Stop', session_id: 's-' + pane });
const agentOf = (core, key) => core.snapshot().agents.find((a) => a.key === key);

test('ツール操作 1 回の完了が 1 ステップになり、失敗した操作は数えない', () => {
  const { core, types } = setup();
  core.setHerdrAgents([herdr('p1', 'working')]);
  prompt(core, 'p1', 'ログインを直して');
  runTool(core, 'p1', 'Read', { file_path: '/work/web-app/a.ts' });
  runTool(core, 'p1', 'Edit', { file_path: '/work/web-app/a.ts', new_string: 'x\ny' });
  runTool(core, 'p1', 'Bash', { command: 'ls /nope' }, { fail: true, error: 'Exit code 1' });

  const s = core.snapshot();
  assert.equal(s.today.steps, 2);
  assert.equal(agentOf(core, 'p1').turnSteps, 2);
  assert.equal(agentOf(core, 'p1').daySteps, 2);
  assert.equal(agentOf(core, 'p1').lines, 2);
  assert.deepEqual(s.today.rank, [{ name: 'web-app', steps: 2 }]);
  assert.equal(types().filter((t) => t === 'step').length, 2);
});

test('Stop でタスク完了になり、同じ指示では二重に数えない', () => {
  const { core, types } = setup();
  core.setHerdrAgents([herdr('p1', 'working')]);
  prompt(core, 'p1', 'README を直して');
  runTool(core, 'p1', 'Read', { file_path: 'README.md' });
  stop(core, 'p1');
  assert.equal(agentOf(core, 'p1').state, 'done', 'herdr がまだ working でも完了と表示する');
  stop(core, 'p1');
  core.setHerdrAgents([herdr('p1', 'idle')]);

  const s = core.snapshot();
  assert.equal(s.today.tasks, 1);
  assert.equal(s.today.goal.done, 1);
  assert.equal(agentOf(core, 'p1').state, 'done');
  assert.deepEqual(agentOf(core, 'p1').ops, [{ text: 'README.md を読み込み', ok: true }]);
  assert.equal(types().filter((t) => t === 'task').length, 1);
  assert.ok(s.feed.some((f) => f.text === 'タスク完了: README を直して'));
});

test('フックが届かないセッションは herdr の working → idle でタスク完了にする', () => {
  const { core } = setup();
  core.setHerdrAgents([herdr('p9', 'idle')]);
  assert.equal(agentOf(core, 'p9').state, 'idle');
  core.setHerdrAgents([herdr('p9', 'working')]);
  core.setHerdrAgents([herdr('p9', 'idle')]);
  assert.equal(core.snapshot().today.tasks, 1);
  assert.equal(agentOf(core, 'p9').state, 'done');
});

test('状態は直近の操作で決まり、テスト失敗から通過までは「失敗→自動修正中」になる', () => {
  const { core, types } = setup();
  core.setHerdrAgents([herdr('p1', 'working')]);
  prompt(core, 'p1', 'テストを通して');
  core.handleHook('p1', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.ts' }, tool_use_id: 'r1' });
  assert.equal(agentOf(core, 'p1').state, 'think');
  core.handleHook('p1', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.ts' }, tool_use_id: 'e1' });
  assert.equal(agentOf(core, 'p1').state, 'edit');
  core.handleHook('p1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, tool_use_id: 'b1' });
  assert.equal(agentOf(core, 'p1').state, 'run');
  core.handleHook('p1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'b2' });
  assert.equal(agentOf(core, 'p1').state, 'test');

  runTool(core, 'p1', 'Bash', { command: 'npm test' }, { fail: true, error: 'Exit code 1\nTests: 1 failed, 23 passed, 24 total' });
  assert.equal(agentOf(core, 'p1').state, 'error');
  assert.equal(agentOf(core, 'p1').run, 0);
  assert.ok(types().includes('error'));
  runTool(core, 'p1', 'Edit', { file_path: 'a.ts', new_string: 'fix' });
  assert.equal(agentOf(core, 'p1').state, 'error');
  runTool(core, 'p1', 'Bash', { command: 'npm test' }, { response: { stdout: 'Tests: 24 passed, 24 total' } });
  assert.equal(agentOf(core, 'p1').state, 'test');
  assert.equal(core.snapshot().today.tests, 47);
});

test('止まらずに進んだステップは一定時間ステップがないと 0 に戻り、最高は残る', () => {
  const { core, clock, types } = setup();
  core.setHerdrAgents([herdr('p1', 'working')]);
  runTool(core, 'p1', 'Read', { file_path: 'a' });
  clock.t += STREAK_MS - 1000;
  core.tick();
  runTool(core, 'p1', 'Read', { file_path: 'b' });
  assert.equal(core.snapshot().today.streak, 2);
  assert.equal(core.snapshot().today.streakDeadline, clock.t + STREAK_MS);

  clock.t += STREAK_MS;
  core.tick();
  const s = core.snapshot();
  assert.equal(s.today.streak, 0);
  assert.equal(s.today.best, 2);
  assert.ok(types().includes('streak_reset'));
  assert.ok(s.feed.some((f) => f.text === '2ステップで止まりました（最高 2）'));
});

test('区切りと連続の節目でイベントが出る', () => {
  const { core, events } = setup();
  core.setHerdrAgents([herdr('p1', 'working')]);
  for (let i = 0; i < MILESTONE_STEPS; i++) runTool(core, 'p1', 'Read', { file_path: 'a' });
  const milestone = events.filter((e) => e.type === 'milestone');
  assert.deepEqual(milestone.map((e) => [e.steps, e.next]), [[MILESTONE_STEPS, MILESTONE_STEPS * 2]]);
  assert.deepEqual(events.filter((e) => e.type === 'streak').map((e) => e.streak), [50, 100]);
  assert.deepEqual(events.filter((e) => e.type === 'mission').map((e) => e.id), ['streak']);
  assert.equal(agentOf(core, 'p1').showRun, true);
});

test('今日の目標を達成すると次の目標が増える', () => {
  const { core, events } = setup();
  core.setHerdrAgents([herdr('p1', 'working')]);
  for (let i = 0; i < GOAL_START; i++) { prompt(core, 'p1', `指示 ${i}`); stop(core, 'p1'); }
  const goal = events.filter((e) => e.type === 'goal');
  assert.deepEqual(goal.map((e) => [e.target, e.next]), [[GOAL_START, GOAL_START + GOAL_INCREMENT]]);
  assert.deepEqual(core.snapshot().today.goal, { target: GOAL_START + GOAL_INCREMENT, done: GOAL_START });
});

test('許可待ちは保留中の操作を示し、質問には承認ボタンを出さない', () => {
  const { core, clock, events } = setup();
  core.setHerdrAgents([herdr('p1', 'working')]);
  prompt(core, 'p1', '依存を入れて');
  core.handleHook('p1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm install\necho done' }, tool_use_id: 'b1' });
  core.setPaneStatus('p1', 'blocked');
  let a = agentOf(core, 'p1');
  assert.equal(a.state, 'wait');
  assert.equal(a.ask, 'npm install');
  assert.equal(a.canRespond, true);
  assert.equal(a.blockedSince, clock.t);
  assert.equal(events.filter((e) => e.type === 'blocked')[0].ask, 'npm install');

  clock.t += 4000;
  core.recordResponse('p1', 'approve');
  assert.equal(events.filter((e) => e.type === 'approved')[0].waited, 4);
  assert.equal(core.canRespond('p1'), false, '同じ許可待ちには一度しか応答できない');
  assert.ok(core.snapshot().feed.some((f) => f.text === '承認: npm install（待ち時間 4秒）'));
  assert.equal(core.snapshot().today.missions.find((m) => m.id === 'fast').value, 1);

  core.setPaneStatus('p1', 'working');
  core.handleHook('p1', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm install' }, tool_use_id: 'b1', tool_response: {} });
  core.handleHook('p1', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: {}, tool_use_id: 'q1' });
  core.setPaneStatus('p1', 'blocked');
  a = agentOf(core, 'p1');
  assert.equal(a.canRespond, false);
  assert.equal(core.canRespond('p1'), false);
});

test('今日の数字は書き出して読み戻せ、日付が違う保存は読み込まない', () => {
  const { core, clock } = setup();
  core.setHerdrAgents([herdr('p1', 'working')]);
  prompt(core, 'p1', 'x');
  runTool(core, 'p1', 'Read', { file_path: 'a' });
  stop(core, 'p1');
  const saved = core.exportStats();

  const again = createCore({ now: () => clock.t, streakMs: STREAK_MS });
  assert.equal(again.importStats(saved), true);
  const t = again.snapshot().today;
  assert.equal(t.steps, 1);
  assert.equal(t.tasks, 1);
  assert.equal(t.streak, 1);
  assert.deepEqual(t.rank, [{ name: 'web-app', steps: 1 }]);

  const nextDay = createCore({ now: () => clock.t + 86400000, streakMs: STREAK_MS });
  assert.equal(nextDay.importStats(saved), false);
  assert.equal(nextDay.snapshot().today.steps, 0);
});

test('日付が変わると今日の数字は 0 に戻る', () => {
  const { core, clock } = setup();
  core.setHerdrAgents([herdr('p1', 'working')]);
  runTool(core, 'p1', 'Read', { file_path: 'a' });
  clock.t += 86400000;
  core.tick();
  assert.equal(core.snapshot().today.steps, 0);
  assert.notEqual(core.dayKey(), '2026-10-07');
});

test('並び順はあなた待ち → 作業中 → それ以外', () => {
  const { core } = setup();
  core.setHerdrAgents([herdr('p1', 'idle', { name: 'aaa' }), herdr('p2', 'working', { name: 'bbb' }), herdr('p3', 'blocked', { name: 'ccc' })]);
  assert.deepEqual(core.snapshot().agents.map((a) => a.name), ['ccc', 'bbb', 'aaa']);
});

test('herdr から消えたペインは一覧から外れる', () => {
  const { core } = setup();
  core.setHerdrAgents([herdr('p1', 'idle'), herdr('p2', 'idle', { name: 'api' })]);
  core.setHerdrAgents([herdr('p2', 'idle', { name: 'api' })]);
  assert.deepEqual(core.snapshot().agents.map((a) => a.key), ['p2']);
});

test('テスト実行の判定と通過件数の読み取り', () => {
  assert.equal(isTestCommand('Bash', { command: 'cd app && npm run test -- --watch=false' }), true);
  assert.equal(isTestCommand('Bash', { command: 'node --test' }), true);
  assert.equal(isTestCommand('Bash', { command: 'python -m pytest -q' }), true);
  assert.equal(isTestCommand('Bash', { command: 'git commit -m "add test"' }), false);
  assert.equal(isTestCommand('Read', { command: 'npm test' }), false);
  assert.equal(countPassedTests('Tests:       2 failed, 22 passed, 24 total'), 22);
  assert.equal(countPassedTests(' Tests  1 failed | 30 passed (31)'), 30);
  assert.equal(countPassedTests('===== 24 passed in 1.20s ====='), 24);
  assert.equal(countPassedTests('ℹ tests 12\nℹ pass 12\nℹ fail 0'), 12);
  assert.equal(countPassedTests('test result: ok. 8 passed; 0 failed'), 8);
  assert.equal(countPassedTests('no result here'), 0);
  assert.equal(changedLines('Write', { content: 'a\nb\nc\n' }), 3);
  assert.equal(changedLines('MultiEdit', { edits: [{ new_string: 'a' }, { new_string: 'b\nc' }] }), 3);
  assert.equal(changedLines('Read', { file_path: 'x' }), 0);
});
