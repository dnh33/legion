/** The task sheet and the New task sheet (pure): the second-run warning, best fit, cost line, Esc with a draft, layout, the card per status. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkItem } from '../src/shared/board.js';
import { PARKED_PREFIX, TURN_LIMIT_PREFIX } from '../src/shared/continue.js';
import type { ApprovalRequest, Task } from '../src/shared/types.js';
import type { PageFacts } from '../ui/src/projects/page/pageLogic.js';
import {
  ESC_NOTE, bestFit, canStart, costLine, escStep, layoutFor, newTaskBody, secondRun, taskCard, typicalCost,
} from '../ui/src/projects/page/sheetLogic.js';

const NOW = Date.parse('2026-10-14T11:30:00');
const iso = (hhmm: string, day = '2026-10-14'): string => new Date(`${day}T${hhmm}:00`).toISOString();
const P1 = 'proj_aaaaaaaaaaaa', P2 = 'proj_bbbbbbbbbbbb';
const task = (id: string, agentId: string, over: Partial<Task> = {}): Task => ({ id, agentId, title: `Task ${id}`, status: 'running', source: 'ui', requestedModel: 'auto', projectId: P1, createdAt: iso('08:00'), updatedAt: iso('11:00'), ...over } as Task);
const agents = ['builder', 'scout', 'scribe'].map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), description: id, model: 'sonnet' as const, approval: 'ask' as const }));
const facts = (over: Partial<PageFacts> = {}): PageFacts => ({
  project: { id: P1, name: 'Shop', members: ['builder', 'scout', 'scribe'], status: 'active', createdAt: iso('00:00', '2026-10-01') },
  projects: [{ id: P1, name: 'Shop', status: 'active' }, { id: P2, name: 'Atlas', status: 'active' }],
  agents, tasks: [], approvals: [], questions: [], queue: null, nowMs: NOW, ...over,
});

test('second run: only a live run of the same agent in the same project warns', () => {
  const f = facts({ tasks: [task('t1', 'builder', { title: 'Publish the package' }), task('t2', 'scout', { projectId: P2 }), task('t3', 'scribe', { status: 'queued' })] });
  assert.deepEqual(secondRun(f, 'builder'), { agentId: 'builder', agentName: 'Builder', taskTitle: 'Publish the package' });
  assert.equal(secondRun(f, 'scout'), null, 'a run elsewhere is the "Also working in" note, not a warning');
  assert.equal(secondRun(f, 'scribe'), null, 'a queued run is not live');
  assert.equal(secondRun(f, 'nobody'), null);
});

test('best fit: the member with the fewest live runs here; ties keep member order; none when empty', () => {
  const f = facts({ tasks: [task('t1', 'builder'), task('t2', 'builder'), task('t3', 'scout')] });
  assert.equal(bestFit(f), 'scribe');
  assert.equal(bestFit(facts({ tasks: [task('t1', 'builder'), task('t2', 'scout')] })), 'scribe');
  assert.equal(bestFit(facts({ tasks: [] })), 'builder');
  assert.equal(bestFit(facts({ project: { ...facts().project, members: [] } })), undefined);
});

test('typical cost: the mean of that agent\'s done tasks, else the default; the line says it plainly', () => {
  const ts = [task('a', 'builder', { status: 'done', costUsd: 1 }), task('b', 'builder', { status: 'done', costUsd: 2 }), task('c', 'builder', { status: 'error', costUsd: 50 }), task('d', 'scout', { status: 'done', costUsd: 9 })];
  assert.equal(typicalCost(ts, 'builder'), 1.5);
  assert.equal(typicalCost(ts, 'scribe'), 1.5, 'no history: the default');
  assert.equal(typicalCost(ts, 'scout'), 9);
  assert.equal(typicalCost([task('z', 'builder', { status: 'done', costUsd: NaN })], 'builder'), 1.5, 'a bad number never shows');
  assert.equal(costLine(1.5), 'About $1.50 for a task like this.');
});

test('Start does nothing until a second run is answered (Run anyway or Queue after it) and there is text', () => {
  const warn = { agentId: 'builder', agentName: 'Builder', taskTitle: 'x' };
  assert.deepEqual(canStart({ text: '  ', warning: null, choice: undefined }), { ok: false, why: 'empty' });
  assert.deepEqual(canStart({ text: 'go', warning: warn, choice: undefined }), { ok: false, why: 'choose' });
  assert.deepEqual(canStart({ text: 'go', warning: warn, choice: 'run' }), { ok: true });
  assert.deepEqual(canStart({ text: 'go', warning: warn, choice: 'after' }), { ok: true });
  assert.deepEqual(canStart({ text: 'go', warning: null, choice: undefined }), { ok: true });
  // a choice made for an earlier warning does not leak when the warning is gone
  assert.deepEqual(canStart({ text: 'go', warning: null, choice: 'after' }), { ok: true });
});

test('the body sent: Queue after it maps to startAfter, Run anyway and no warning do not; the project is always named', () => {
  const warn = { agentId: 'builder', agentName: 'Builder', taskTitle: 'x' };
  assert.deepEqual(newTaskBody({ agentId: 'builder', projectId: P1, text: ' go ', warning: warn, choice: 'after' }), { agentId: 'builder', projectId: P1, prompt: 'go', startAfter: true });
  assert.deepEqual(newTaskBody({ agentId: 'builder', projectId: P1, text: 'go', warning: warn, choice: 'run' }), { agentId: 'builder', projectId: P1, prompt: 'go' });
  assert.deepEqual(newTaskBody({ agentId: 'builder', projectId: P1, text: 'go', warning: null, choice: 'after' }), { agentId: 'builder', projectId: P1, prompt: 'go' }, 'no live run left: just start');
});

test('Esc with a draft arms first and keeps the draft; the second Esc closes; without a draft it closes at once', () => {
  assert.equal(ESC_NOTE, 'Press Esc again to close. Your draft is kept.');
  assert.equal(escStep({ dirty: false, armed: false }), 'close');
  assert.equal(escStep({ dirty: true, armed: false }), 'arm');
  assert.equal(escStep({ dirty: true, armed: true }), 'close');
});

test('layout: push the list when 520 px stay free beside the 480 px sheet, else cover it', () => {
  assert.equal(layoutFor(1000), 'push');
  assert.equal(layoutFor(999), 'over');
  assert.equal(layoutFor(700), 'over');
  assert.equal(layoutFor(Number.NaN), 'over');
});

test('the card per status says what is true and nothing else', () => {
  const f = facts({
    tasks: [
      task('w', 'builder', { title: 'Payment flag' }),
      task('q', 'scout', { status: 'queued', title: 'Sitemap' }),
      task('s', 'scribe', { status: 'error', error: `${TURN_LIMIT_PREFIX} 200 steps`, turns: 200, resumable: true, title: 'Long one' }),
      task('f', 'scribe', { status: 'error', error: 'The build exited with code 1.', title: 'Image' }),
      task('d', 'builder', { status: 'done', result: 'Release notes written.\nThree sections.', costUsd: 2.27, title: 'Notes' }),
      task('c', 'builder', { status: 'cancelled', title: 'Dropped' }),
      task('p', 'scout', { status: 'error', error: PARKED_PREFIX, title: 'Parked' }),
    ],
    queue: { cap: 4, running: 4, items: [{ taskId: 'q', reason: 'slot', position: 1 }] },
    progress: { w: { turn: 18, todos: [{ content: 'Wire the flag', status: 'in_progress', activeForm: 'Wiring the flag' }] } } as unknown as PageFacts['progress'],
  });
  const w = taskCard(f, 'w')!;
  assert.equal(w.kind, 'working'); assert.equal(w.headline, 'Builder is working'); assert.equal(w.detail, 'Wiring the flag'); assert.deepEqual(w.actions.map((a) => a.act), ['stop']);
  const q = taskCard(f, 'q')!;
  assert.equal(q.kind, 'queued'); assert.equal(q.headline, 'Waiting for a free slot (4 of 4 running in all projects)');
  assert.equal(q.lastMessage, 'Not started yet. It is waiting in line.'); assert.deepEqual(q.actions.map((a) => a.label), ['Stop waiting']);
  const s = taskCard(f, 's')!;
  assert.equal(s.kind, 'stopped'); assert.equal(s.headline, 'Stopped after 200 steps. Work kept.'); assert.deepEqual(s.actions.map((a) => a.act), ['continue']);
  const fl = taskCard(f, 'f')!;
  assert.equal(fl.kind, 'failed'); assert.equal(fl.headline, 'Failed: the build exited with code 1.'); assert.equal(fl.lastMessage, 'The build exited with code 1.'); assert.deepEqual(fl.actions.map((a) => a.act), ['retry']);
  const d = taskCard(f, 'd')!;
  assert.equal(d.kind, 'done'); assert.equal(d.lastMessage, 'Release notes written.\nThree sections.'); assert.deepEqual(d.actions, []);
  assert.equal(taskCard(f, 'c')!.kind, 'cancelled');
  assert.equal(taskCard(f, 'nope'), null, 'a task that is gone has no card (the sheet closes)');
});

test('a task with an open ask is "waiting", not "working", and Stop is not offered while it waits on you', () => {
  const ap = { id: 'a1', taskId: 'w', agentId: 'builder', toolName: 'Bash', summary: 'npm publish', input: { command: 'npm publish' }, at: iso('11:20') } as unknown as ApprovalRequest;
  const f = facts({ tasks: [task('w', 'builder')], approvals: [ap] });
  const c = taskCard(f, 'w')!;
  assert.equal(c.kind, 'waiting'); assert.equal(c.headline, 'Builder is waiting on you');
  assert.deepEqual(c.actions.map((a) => a.act), []);
});

test('a board item in review for this task says so and offers Mark done', () => {
  const item = { id: 'item_1', title: 'Payment flag', status: 'review', assignee: { kind: 'agent', id: 'builder' }, taskIds: ['d'], lastRun: { taskId: 'd', status: 'done', endedAt: iso('11:00'), tainted: false, preview: 'ok' }, updatedAt: iso('11:00') } as unknown as WorkItem;
  const f = facts({ tasks: [task('d', 'builder', { status: 'done', result: 'ok' })], board: { items: [item], inbox: [] } });
  const c = taskCard(f, 'd')!;
  assert.equal(c.kind, 'review'); assert.equal(c.headline, 'Builder says it is done');
  assert.deepEqual(c.actions.map((a) => a.act), ['mark-done']); assert.equal(c.actions[0]!.itemId, 'item_1');
});

test('no em or en dash and no "this computer" in the sheet copy', () => {
  const src = readFileSync(join(process.cwd(), 'ui', 'src', 'projects', 'page', 'sheetLogic.ts'), 'utf8');
  assert.equal(/[–—]/.test(src), false);
  assert.equal(/this (computer|machine)/i.test(src), false);
});
