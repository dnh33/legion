/**
 * The Marshal's window: the panel's form bounds and checks text (pure), then a REAL render through esbuild +
 * react-dom/server proving the panel draws what runs and why that bot, what is blocked and why, what is next,
 * the switch and its bounds, and the per-item done-when entry with the ledger's own count. (ui/projects/board.)
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { CHECK_MAX, STALL_BOUNDS, WAVE_BOUNDS, checksError, checksText, draftErrors, draftOf, draftToConfig, parseChecks, runLine } from '../ui/src/projects/board/marshalLogic.js';
import { MAX_DONE_WHEN } from '../src/core/marshal/ledger.js';
import type { BoardMarshalStatus, MarshalConfig } from '../src/shared/board.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

// ---------------------------------------------------------------- the form's logic

test('the form enforces the route’s bounds, and only those', () => {
  assert.deepEqual(WAVE_BOUNDS, [1, 10]);
  assert.deepEqual(STALL_BOUNDS, [1, 240]);
  for (const wave of ['0', '11', '2.5', '', '   ', 'abc', 'NaN']) {
    assert.ok(draftErrors({ enabled: true, waveSize: wave, stallMinutes: '8' }).length === 1, `wave ${JSON.stringify(wave)} is refused`);
  }
  for (const stall of ['0', '241', '15.5', '', '-1', 'ten']) {
    assert.ok(draftErrors({ enabled: true, waveSize: '3', stallMinutes: stall }).length === 1, `stall ${JSON.stringify(stall)} is refused`);
  }
  assert.deepEqual(draftErrors({ enabled: true, waveSize: '1', stallMinutes: '1' }), [], 'the low edges are allowed');
  assert.deepEqual(draftErrors({ enabled: false, waveSize: '10', stallMinutes: '240' }), [], 'and the high edges');
  assert.deepEqual(draftToConfig({ enabled: true, waveSize: ' 4 ', stallMinutes: '30' }), { enabled: true, waveSize: 4, stallMinutes: 30 });
  assert.deepEqual(draftOf(undefined), { enabled: false, waveSize: '3', stallMinutes: '8' }, 'nothing loaded yet: the shipped defaults');
  const msgs = draftErrors({ enabled: true, waveSize: '99', stallMinutes: '999' });
  assert.match(msgs[0]!, /between 1 and 10/);
  assert.match(msgs[1]!, /whole number of minutes between 1 and 240/);
});

test('the checks text is one check per line, bounded by the ledger’s own count', () => {
  assert.equal(CHECK_MAX, MAX_DONE_WHEN, 'the panel shows the bound the ledger enforces');
  assert.equal(CHECK_MAX, 6);
  assert.deepEqual(parseChecks('it parses\n\n  the test passes  \n'), ['it parses', 'the test passes'], 'empty and padded lines are dropped, nothing else is touched');
  assert.equal(checksText(['a', 'b']), 'a\nb');
  assert.equal(checksText(undefined), '');
  assert.equal(checksError('one\ntwo'), undefined);
  assert.match(checksError(['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n'))!, /At most 6 checks/);
  assert.match(checksError(`ok\n${'x'.repeat(201)}`)!, /Check 2 is too long/);
  assert.equal(checksError(''), undefined, 'no checks yet is a state, not an error');
});

test('a running line names the bot, its model, and says when the approval card will gate it', () => {
  const base = {
    itemId: 'wi_aaaaaaaaaaaa', title: 'Send the update', botId: 'herald', botName: 'Herald', model: 'sonnet',
    tier: 'ask', irreversible: ['send'], gated: true, why: 'it drafts comms', score: 40, rankWhy: 'high priority',
    taskId: 'task_1', startedAt: 1, attempts: 1,
  };
  assert.equal(runLine(base), 'Send the update → Herald (sonnet, gated)');
  assert.equal(runLine({ ...base, gated: false, irreversible: [] }), 'Send the update → Herald (sonnet)');
});

// ---------------------------------------------------------------- the real render

type Render = Record<string, (...args: any[]) => string>;
async function loadPanel(): Promise<{ r: Render; saved: MarshalConfig[]; cleanup: () => void }> {
  const entry = `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MarshalPanel, DoneWhen } from ${JSON.stringify(join(REPO, 'ui/src/projects/board/MarshalPanel.tsx'))};
    const render = (el) => renderToStaticMarkup(el);
    export const panel = (view, o) => render(createElement(MarshalPanel, { view, busy: !!(o && o.busy), readOnly: !!(o && o.readOnly), onSave: (cfg) => { globalThis.__saved.push(cfg); } }));
    export const checks = (o) => render(createElement(DoneWhen, { value: o.value, onChange: () => {}, onSave: () => {}, saved: !!o.saved, disabled: !!o.disabled, busy: !!o.busy }));`;
  const out = await build({
    stdin: { resolveDir: REPO, sourcefile: 'entry.tsx', loader: 'tsx', contents: entry },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
    loader: { '.css': 'empty' },
  });
  const dir = cleanupTemp('marshal-ui-');
  const file = join(dir, 'ui.cjs');
  writeFileSync(file, out.outputFiles[0]!.text);
  const g = globalThis as { __saved?: MarshalConfig[] };
  g.__saved = [];
  return { r: createRequire(file)(file) as Render, saved: g.__saved, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const cfg: MarshalConfig = { enabled: true, waveSize: 4, stallMinutes: 30 };
const view = (): BoardMarshalStatus => ({
  status: {
    running: [{
      itemId: 'wi_aaaaaaaaaaaa', title: 'Write the parser', botId: 'scout', botName: 'Scout', model: 'sonnet', tier: 'ask',
      irreversible: ['delete'], gated: true, why: 'it ships working code', score: 84, rankWhy: 'high priority, due tomorrow',
      taskId: 'task_9', startedAt: 1770000000000, attempts: 1,
    }],
    blocked: [{ itemId: 'wi_bbbbbbbbbbbb', title: 'Write the legal copy', reason: 'No eligible bot for this item: herald (never send)' }],
    next: [{ itemId: 'wi_cccccccccccc', title: 'Check the docs', score: 52, why: 'normal priority' }],
  },
  statusText: 'STATUS 1 running, 1 blocked, 1 next',
  checks: { wi_aaaaaaaaaaaa: ['it parses', 'the test passes'] },
  marshal: cfg,
});

test('render: the panel shows what runs and why that bot, what is blocked and why, what is next', async () => {
  const { r, cleanup } = await loadPanel();
  try {
    const html = r.panel(view(), {});
    assert.match(html, />The Marshal</, 'the section heads');
    assert.match(html, />\s*On\s*</, 'and says it is on');
    assert.match(html, /Write the parser → Scout \(sonnet, gated\)/, 'the run names the bot and its own model');
    assert.match(html, /Why this bot: it ships working code/, 'with why that bot');
    assert.match(html, /Irreversible: delete; the approval card will gate it/, 'and why the card will gate it');
    assert.match(html, /high priority, due tomorrow/, 'and the board’s line for its place');
    assert.match(html, /Write the legal copy/, 'the blocked item is shown');
    assert.match(html, /No eligible bot for this item: herald \(never send\)/, 'with its reason');
    assert.match(html, /Check the docs/, 'the next item is shown');
    assert.match(html, /score 52/, 'with the score that put it there');
    assert.match(html, /normal priority/, 'and why it ranks there');
    assert.match(html, /STATUS 1 running, 1 blocked, 1 next/, 'the plain lines are one disclosure away');
    assert.match(html, /Wave size/, 'the bounds are offered');
    assert.match(html, /Stop a silent run after \(minutes\)/);
    assert.match(html, /value="4"/, 'the stored wave is in the field');
    assert.match(html, /value="30"/, 'and the stored stall budget');
    assert.match(html, /type="checkbox"[^>]*checked/, 'the switch reads as on');
  } finally { cleanup(); }
});

test('render: an off project says so plainly, empty states are honest, and an archived board cannot save', async () => {
  const { r, cleanup } = await loadPanel();
  try {
    const empty: BoardMarshalStatus = {
      status: { running: [], blocked: [], next: [] },
      statusText: 'STATUS 0 running, 0 blocked, 0 next',
      checks: {},
      marshal: { enabled: false, waveSize: 3, stallMinutes: 8 },
    };
    const off = r.panel(empty, {});
    assert.match(off, />\s*Off\s*</, 'the switch reads as off');
    assert.match(off, /Nothing is matched and no bot is started until you switch this on./, 'and what off means');
    assert.match(off, /Nothing is running\./);
    assert.match(off, /Nothing is blocked\./);
    assert.match(off, /Nothing is queued\./);
    assert.ok(!/type="checkbox"[^>]*checked/.test(off), 'the switch is not checked');

    const ro = r.panel(view(), { readOnly: true });
    assert.match(ro, /This project is archived/, 'an archived board says why it cannot change');
    assert.ok(/<button[^>]*disabled[^>]*>Save</.test(ro), 'and its Save is disabled');
    assert.ok(/<input[^>]*type="number"[^>]*disabled/.test(ro), 'as are the bounds');
    assert.ok(/<input[^>]*type="checkbox"[^>]*disabled/.test(ro), 'including the switch');

    const busy = r.panel(view(), { busy: true });
    assert.ok(/<button[^>]*disabled[^>]*>Save</.test(busy), 'a save in flight is not offered twice');
  } finally { cleanup(); }
});

test('render: the done-when entry counts the lines, refuses past the ledger’s bound, and says when it saved', async () => {
  const { r, cleanup } = await loadPanel();
  try {
    const two = r.checks({ value: 'it parses\nthe test passes' });
    assert.match(two, /Done when/);
    assert.match(two, /2 of 6 checks\./, 'the count is the ledger’s own bound');
    assert.ok(!/<button[^>]*disabled[^>]*>Save checks</.test(two), 'two checks may be saved');

    const none = r.checks({ value: '' });
    assert.match(none, /No checks yet: nothing dispatches this item until you write them./, 'the empty state says what it blocks');

    const tooMany = r.checks({ value: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n') });
    assert.match(tooMany, /At most 6 checks: they are what decides whether this item is done\./);
    assert.ok(/<button[^>]*disabled[^>]*>Save checks</.test(tooMany), 'and cannot be saved');

    const saved = r.checks({ value: 'it parses', saved: true });
    assert.match(saved, /Saved\. The Marshal will dispatch on exactly these\./, 'the write is confirmed on the row');

    const ro = r.checks({ value: 'it parses', disabled: true });
    assert.ok(/<textarea[^>]*disabled/.test(ro), 'an archived board cannot edit');
    assert.ok(/<button[^>]*disabled[^>]*>Save checks</.test(ro));
  } finally { cleanup(); }
});
