/**
 * Agent-to-agent bridge UX (audit claude/audit-agent-to-agent-ux.md, B1 and B3-B7): what a person reads when one agent asks or
 * tells another. The pure view-model (ui/src/chat/bridgeView.ts) is checked directly; a real render of the components through
 * esbuild + react-dom/server (store and api stubbed) proves the components draw what the view-model says, in the error style.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { bridgeOutcome, pendingAskAgent, replyFailure, workingToolLabel } from '../ui/src/chat/bridgeView.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

// ---------------------------------------------------------------- view-model

test('B1: a refused tell reads "Not sent: <reason>" in the error style, never "Sent."', () => {
  for (const raw of ['Error: Rate limit: more than 6 messages from zealot to builder in 10 minutes. Finish the work yourself or ask the user.',
    'Error: Unknown agent "nobody". Available: builder', 'Error: delegation too deep (max 4)', 'Error: Bridge hop limit reached (8). Finish the work yourself or ask the user.']) {
    const o = bridgeOutcome('tell', raw, 'Builder', true);
    assert.equal(o.tone, 'error', raw);
    assert.equal(o.text, `Not sent: ${raw.slice('Error: '.length)}`, raw);
    assert.doesNotMatch(o.text, /^Sent\./, raw);
  }
  // the success case is unchanged: a taskId came back
  const ok = bridgeOutcome('tell', JSON.stringify({ taskId: 't_1' }), 'Builder', true);
  assert.equal(ok.text, 'Sent. Builder’s reply will arrive in this task.');
  assert.equal(ok.taskId, 't_1');
  assert.notEqual(ok.tone, 'error');
});

test('B1: a tell with no result yet is not called sent', () => {
  assert.equal(bridgeOutcome('tell', undefined, 'Builder', true).text, 'Sending to Builder…');
  assert.equal(bridgeOutcome('tell', undefined, 'Builder', false).text, 'No result was recorded for this call.');
});

test('B3: a pending ask reads "Waiting for <X>…" while the calling task runs; afterwards "No result was recorded"', () => {
  const p = bridgeOutcome('ask', undefined, 'Builder', true);
  assert.equal(p.text, 'Waiting for Builder…');
  assert.equal(p.tone, 'pending');
  assert.equal(bridgeOutcome('ask', undefined, 'Builder', false).text, 'No result was recorded for this call.');
});

test('B4: an ask timeout is read out in plain words, with a way to their task, not raw JSON', () => {
  const raw = JSON.stringify({ taskId: 't_9', status: 'running', note: 'Still working; use ask again later or tell. Timed out after 600s.' });
  const o = bridgeOutcome('ask', raw, 'Builder', true);
  assert.equal(o.text, 'Still working after 600 s; Builder keeps going.');
  assert.equal(o.taskId, 't_9');
  assert.equal(o.heading, undefined, 'not under a "Result" heading');
  assert.notEqual(o.tone, 'error');
  assert.doesNotMatch(o.text, /[{"]/);
  // a note without a number still reads as words
  assert.equal(bridgeOutcome('ask', JSON.stringify({ taskId: 't_9', status: 'running', note: 'Still working.' }), 'Builder', true).text, 'Still working; Builder keeps going.');
});

test('B5: a refused ask reads "Not sent: <reason>"; a failed or cancelled callee reads "<X> could not finish: …"; both in the error style', () => {
  const refused = bridgeOutcome('ask', 'Error: would deadlock: Zealot is waiting on this chain. Use tell instead.', 'Zealot', true);
  assert.deepEqual([refused.tone, refused.text, refused.heading], ['error', 'Not sent: would deadlock: Zealot is waiting on this chain. Use tell instead.', undefined]);
  const failed = bridgeOutcome('ask', JSON.stringify({ taskId: 't_2', status: 'error', result: 'Claude ended without producing a result' }), 'Builder', false);
  assert.deepEqual([failed.tone, failed.text, failed.heading, failed.taskId], ['error', 'Builder could not finish: Claude ended without producing a result', undefined, 't_2']);
  const cancelled = bridgeOutcome('ask', JSON.stringify({ taskId: 't_3', status: 'cancelled', result: 'cancelled' }), 'Builder', false);
  assert.deepEqual([cancelled.tone, cancelled.text], ['error', 'Builder could not finish: the task was cancelled.']);
  // errors raised AFTER the message was delivered are not "not sent"
  for (const after of ['Cancelled', 'The target task was deleted', 'The target task no longer exists']) {
    const o = bridgeOutcome('ask', `Error: ${after}`, 'Builder', false);
    assert.equal(o.tone, 'error', after);
    assert.match(o.text, /^Builder could not finish: /, after);
  }
  // a normal answer is unchanged
  const done = bridgeOutcome('ask', JSON.stringify({ taskId: 't_4', status: 'done', model: 'sonnet', result: 'All 12 files counted.' }), 'Builder', false);
  assert.deepEqual([done.tone, done.heading, done.text], ['ok', 'Result', 'All 12 files counted.']);
});

test('B6: a failed tell reply reads "<X> could not finish: …", decided by the outcome Legion writes in the header, never by the text', () => {
  assert.deepEqual(replyFailure('(failed) The target task no longer exists', 'Builder', 'failed'), { text: 'Builder could not finish: The target task no longer exists' });
  assert.deepEqual(replyFailure('(error) Claude ended without producing a result', 'Builder', 'error'), { text: 'Builder could not finish: Claude ended without producing a result' });
  assert.deepEqual(replyFailure('(cancelled)', 'Builder', 'cancelled'), { text: 'Builder could not finish: the task was cancelled.' });
  assert.deepEqual(replyFailure('(gone)', 'Builder', 'gone'), { text: 'Builder could not finish: the task no longer exists.' });
  assert.equal(replyFailure('Done. 12 files counted.', 'Builder'), null);
  // the regression the 0.2.5-f review found: an ordinary answer that starts like a marker is still an answer
  assert.equal(replyFailure('(error) handling in parse.ts is fixed; tests pass.', 'Builder'), null, 'no outcome token: an ordinary reply');
  assert.equal(replyFailure('(failed) nothing', 'Builder', 'done'), null, 'only the outcomes the core writes');
});

test('B7: while an ask waits, the working row names the agent, not the tool', () => {
  const msgs = [
    { role: 'tool', toolName: 'mcp__legion__ask', toolUseId: 'u1', text: JSON.stringify({ agent: 'scout', message: 'old' }) },
    { role: 'tool', resultFor: 'u1', text: '{"taskId":"t","status":"done","result":"x"}' },
    { role: 'tool', toolName: 'mcp__legion__ask', toolUseId: 'u2', text: '{"agent":"builder","message":"' + 'x'.repeat(600) }, // clipped when stored
  ];
  assert.equal(pendingAskAgent(msgs), 'builder');
  assert.equal(pendingAskAgent(msgs.slice(0, 2)), undefined, 'the answered ask is not pending');
  assert.equal(workingToolLabel('mcp__legion__ask', 'Builder'), 'Waiting on Builder');
  assert.equal(workingToolLabel('mcp__legion__ask', undefined), 'Waiting on another agent');
  assert.equal(workingToolLabel('Bash', 'Builder'), 'Bash', 'other tools are unchanged');
});

// ---------------------------------------------------------------- real render

type Render = {
  detail: (b: unknown) => string;
  message: (m: unknown) => string;
  working: (taskId: string) => string;
  chips: (items: unknown[], results: Record<string, string>) => string;
};
async function loadUi(state: Record<string, unknown>): Promise<{ r: Render; cleanup: () => void }> {
  const ui = (p: string) => JSON.stringify(join(REPO, p));
  const reactReal = createRequire(join(REPO, 'package.json')).resolve('react');
  const out = await build({
    stdin: {
      resolveDir: REPO, sourcefile: 'entry.ts', loader: 'ts',
      contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
        import { BridgeDetail, ToolGroup } from ${ui('ui/src/components/ToolChip.tsx')};
        import { MessageView } from ${ui('ui/src/components/MessageView.tsx')};
        import { WorkingRow } from ${ui('ui/src/components/WorkingRow.tsx')};
        export const detail = (b) => renderToStaticMarkup(createElement(BridgeDetail, { b }));
        export const message = (m) => renderToStaticMarkup(createElement(MessageView, { m }));
        export const working = (taskId) => renderToStaticMarkup(createElement(WorkingRow, { taskId, queued: false, waiting: false }));
        export const chips = (items, results) => renderToStaticMarkup(createElement(ToolGroup, { items, results }));`,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    plugins: [{
      name: 'ui-stubs',
      setup(b) {
        // ToolChip's one useState is the open chip: a shim lets the test render the expanded panel (no click in a static render)
        b.onResolve({ filter: /^react$/ }, (a) => (/ToolChip\.tsx$/.test(a.importer) ? { path: 'react-open', namespace: 'stub' } : undefined));
        b.onLoad({ filter: /^react-open$/, namespace: 'stub' }, () => ({ resolveDir: REPO, loader: 'js', contents: `
          export * from ${JSON.stringify(reactReal)};
          export const useState = (i) => [globalThis.__open ?? i, () => {}];` }));
        b.onResolve({ filter: /^(\.\.\/)+store$/ }, () => ({ path: 'store', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onLoad({ filter: /^store$/, namespace: 'stub' }, () => ({ loader: 'js', contents: `
          export const useStore = (sel) => sel(globalThis.__st);
          export const selectTask = () => {};` }));
        b.onLoad({ filter: /^api$/, namespace: 'stub' }, () => ({ loader: 'js', contents: `
          export const openExternal = () => {}; export const request = async () => ({}); export class ApiError extends Error {};` }));
      },
    }],
  });
  const dir = cleanupTemp('bridge-ux-');
  const file = join(dir, 'ui.cjs');
  writeFileSync(file, out.outputFiles[0]!.text);
  (globalThis as { __st?: unknown }).__st = state;
  return { r: createRequire(file)(file) as Render, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const AGENTS = [{ id: 'builder', name: 'Builder', emoji: 'B' }, { id: 'zealot', name: 'Zealot', emoji: 'Z' }];
const baseState = (over: Record<string, unknown> = {}) => ({ agents: AGENTS, tasks: [{ id: 'tz', status: 'running' }], messages: {}, progress: {}, catalog: null, ...over });

test('render B1/B5: a refused tell and a failed ask are drawn in the error style; a sent tell is not', async () => {
  const { r, cleanup } = await loadUi(baseState());
  try {
    const refused = r.detail({ verb: 'Told', kind: 'tell', target: 'Builder', message: 'go', outcome: bridgeOutcome('tell', 'Error: Rate limit: too many', 'Builder', true) });
    assert.match(refused, /<p class="err-s"[^>]*>Not sent: Rate limit: too many<\/p>/);
    assert.doesNotMatch(refused, /Sent\./);
    const failed = r.detail({ verb: 'Asked', kind: 'ask', target: 'Builder', message: 'go', outcome: bridgeOutcome('ask', JSON.stringify({ taskId: 't2', status: 'error', result: 'boom' }), 'Builder', false) });
    assert.match(failed, /<p class="err-s"[^>]*>Builder could not finish: boom/);
    assert.doesNotMatch(failed, />Result</, 'a failure is not shown under a neutral Result heading');
    const sent = r.detail({ verb: 'Told', kind: 'tell', target: 'Builder', message: 'go', outcome: bridgeOutcome('tell', '{"taskId":"t1"}', 'Builder', true) });
    assert.match(sent, /class="muted-s"[^>]*>Sent\. Builder/);
    assert.doesNotMatch(sent, /err-s/);
  } finally { cleanup(); }
});

test('render B3/B1: the open chip reads the calling task’s status: a pending ask or tell waits while it runs, and not after', async () => {
  const ask = [{ id: 'm1', taskId: 'tz', role: 'tool', toolName: 'mcp__legion__ask', toolUseId: 'u1', text: '{"agent":"builder","message":"count"}', at: '' }];
  const tell = [{ id: 'm2', taskId: 'tz', role: 'tool', toolName: 'mcp__legion__tell', toolUseId: 'u2', text: '{"agent":"builder","message":"go"}', at: '' }];
  const g = globalThis as { __open?: string };
  const { r, cleanup } = await loadUi(baseState());
  try {
    g.__open = 'm1';
    const running = r.chips(ask, {});
    assert.match(running, /Waiting for Builder…/);
    assert.doesNotMatch(running, /No result was recorded/);
    g.__open = 'm2';
    assert.match(r.chips(tell, {}), /Sending to Builder…/);
    assert.doesNotMatch(r.chips(tell, {}), /Sent\./, 'nothing came back yet: not "Sent."');
    (globalThis as { __st?: unknown }).__st = baseState({ tasks: [{ id: 'tz', status: 'done' }] });
    g.__open = 'm1';
    assert.match(r.chips(ask, {}), /No result was recorded for this call\./);
  } finally { delete g.__open; cleanup(); }
});

test('render B6: a failed tell reply is drawn as a failure, not an ordinary reply bubble', async () => {
  const { r, cleanup } = await loadUi(baseState());
  try {
    const html = r.message({ role: 'user', fromAgentId: 'builder', text: '[Reply from Builder · task t_7 · error] (error) Claude ended without producing a result' });
    assert.match(html, /class="msg from-agent failed"/);
    assert.match(html, /class="fa-body err-s"[^>]*>Builder could not finish: Claude ended without producing a result</);
    assert.doesNotMatch(html, /\(error\)/);
    const ordinary = r.message({ role: 'user', fromAgentId: 'builder', text: '[Reply from Builder · task t_7] Counted 12 files.' });
    assert.match(ordinary, /class="msg from-agent"/);
    assert.match(ordinary, /class="fa-body">Counted 12 files\.</);
    const lookalike = r.message({ role: 'user', fromAgentId: 'builder', text: '[Reply from Builder · task t_7] (error) handling in parse.ts is fixed; tests pass.' });
    assert.match(lookalike, /class="msg from-agent"/, 'an answer that starts with "(error)" is drawn as an answer');
  } finally { cleanup(); }
});

test('render B7: the working row says "Waiting on Builder" during an ask, not mcp__legion__ask', async () => {
  const messages = { tz: [{ id: 'm1', taskId: 'tz', role: 'tool', toolName: 'mcp__legion__ask', toolUseId: 'u1', text: '{"agent":"builder","message":"count"}', at: '' }] };
  const progress = { tz: { startedAt: new Date().toISOString(), turn: 2, maxTurns: 50, tool: 'mcp__legion__ask' } };
  const { r, cleanup } = await loadUi(baseState({ messages, progress }));
  try {
    const html = r.working('tz');
    assert.match(html, /Waiting on Builder/);
    assert.doesNotMatch(html, /mcp__legion__ask/);
  } finally { cleanup(); }
});

test('a refusal reads "Not sent" whether Claude Code hands it back bare or wrapped in <tool_use_error> tags (PC check AB1)', () => {
  const wrapped = bridgeOutcome('tell', '<tool_use_error>Error: rate limit: 30 in 10 min</tool_use_error>', 'Scout', true);
  assert.deepEqual([wrapped.tone, wrapped.text], ['error', 'Not sent: rate limit: 30 in 10 min']);
  const askWrapped = bridgeOutcome('ask', '<tool_use_error>Error: would deadlock</tool_use_error>', 'Zealot', true);
  assert.deepEqual([askWrapped.tone, askWrapped.text], ['error', 'Not sent: would deadlock']);
});

test('render B1: a refused tell is visible on the CLOSED chip ("Not sent to Builder", error style); a delivered one still reads "Told Builder"', async () => {
  const items = [{ id: 'm9', taskId: 'tz', role: 'tool', toolName: 'mcp__legion__tell', toolUseId: 'u9', text: '{"agent":"builder","message":"go"}', at: '' }];
  const { r, cleanup } = await loadUi(baseState());
  try {
    const refused = r.chips(items, { u9: 'Error: Rate limit: 30 in 10 min' });
    assert.match(refused, /class="chip bridge failed"/);
    assert.match(refused, /<b>Not sent to Builder<\/b>/);
    const sent = r.chips(items, { u9: '{"taskId":"t1"}' });
    assert.match(sent, /class="chip bridge"/);
    assert.match(sent, /<b>Told Builder<\/b>/);
  } finally { cleanup(); }
});
