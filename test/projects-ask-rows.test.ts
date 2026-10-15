/** The digest's ask rows (pure): kinds, chips, wait lines, and who gets an inline Allow. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkItem } from '../src/shared/board.js';
import { BLENDER_EXEC_TOOL } from '../src/shared/blender.js';
import type { ApprovalRequest, PendingQuestion, Task } from '../src/shared/types.js';
import { buildAskRows, waitLine, DEFAULT_WAIT_MIN } from '../ui/src/projects/page/askLogic.js';
import type { PageFacts } from '../ui/src/projects/page/pageLogic.js';

const NOW = Date.parse('2026-10-14T11:30:00');
const iso = (hhmm: string): string => new Date(`2026-10-14T${hhmm}:00`).toISOString();
const P1 = 'proj_aaaaaaaaaaaa';
const task = (id: string, agentId: string, title = `Task ${id}`): Task => ({ id, agentId, title, status: 'running', source: 'ui', requestedModel: 'auto', projectId: P1, createdAt: iso('08:00'), updatedAt: iso('11:00') } as Task);
const bash = (id: string, taskId: string, command: string, over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ id, taskId, agentId: 'builder', toolName: 'Bash', summary: command, input: { command }, at: iso('11:16'), projectId: P1, ...over });
const read = (id: string, n: number): ApprovalRequest => ({ id, taskId: 't1', agentId: 'scout', toolName: 'Read', summary: `orders/${n}.csv`, input: { file_path: `/proj/orders/${n}.csv` }, at: iso('10:58'), projectId: P1, consequence: { level: 1, tags: ['reads'], chip: 'Read only, inside this project', certain: true } });
const agents = ['builder', 'scout', 'scribe'].map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), description: '', model: 'sonnet' as const, approval: 'ask' as const }));
const facts = (over: Partial<PageFacts> = {}): PageFacts => ({
  project: { id: P1, name: 'Shop', members: ['builder', 'scout', 'scribe'], status: 'active', createdAt: iso('00:00') },
  projects: [{ id: P1, name: 'Shop', status: 'active' }], agents, tasks: [task('t1', 'builder', 'Publish the package')], approvals: [], questions: [], queue: null, nowMs: NOW, ...over,
});
const policy = { mode: 'deny' as const, parkMinutes: 3 };

test('a publish command: neutral Allow, a divider, Deny, Open; names carry agent and item', () => {
  const rows = buildAskRows(facts({ approvals: [bash('a1', 't1', 'npm publish --access public')] }), policy);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.kind, 'command');
  assert.equal(r.level, 3);
  assert.equal(r.chip, 'Leaves your computer, cannot be undone');
  assert.equal(r.code, 'npm publish --access public');
  assert.equal(r.hold, 10_000);
  assert.equal(r.ing, 'Publishing');
  assert.deepEqual(r.buttons.map((b) => b.act), ['allow', 'deny', 'open']);
  assert.equal(r.buttons[1]!.sepBefore, true);
  assert.equal(r.buttons[0]!.held, true);
  assert.equal(r.buttons[1]!.held, false, 'Deny is sent at once');
  assert.ok(r.buttons.every((b) => b.aria.includes('Builder')), 'every button names the agent');
  assert.ok(r.buttons[0]!.aria.startsWith('Allow: Builder'));
});

test('inline Allow is never offered for an unknown effect, a click-only card or a card with no Remember', () => {
  const unknown = bash('a1', 't1', 'frobnicate --all');
  const blender = bash('a2', 't1', 'scene.py', { toolName: BLENDER_EXEC_TOOL, input: {} });
  const noRem = bash('a3', 't1', 'npm publish', { noRemember: true });
  const rows = buildAskRows(facts({ approvals: [unknown, blender, noRem] }), policy);
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.ok(!r.buttons.some((b) => b.act === 'allow'), `${r.key} has no inline Allow`);
    assert.equal(r.buttons[0]!.act, 'open', 'Open leads');
    assert.ok(r.buttons.some((b) => b.act === 'deny'), 'Deny stays: denying is always safe');
  }
  const u = rows.find((r) => r.key === 'a1')!;
  assert.equal(u.chip, 'Unknown effect, check it');
});

test('repeated reads of one kind merge into one row with Allow all', () => {
  const rows = buildAskRows(facts({ approvals: [read('r1', 1), read('r2', 2), read('r3', 3)] }), policy);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, 'reads');
  assert.deepEqual(rows[0]!.ids, ['r1', 'r2', 'r3']);
  assert.equal(rows[0]!.what, 'asked 3 times to read files in orders');
  assert.deepEqual(rows[0]!.buttons.map((b) => b.label), ['Allow all 3', 'Review']);
  assert.equal(rows[0]!.hold, 5000);
  assert.equal(rows[0]!.chip, 'Read only, inside this project');
  assert.equal(rows[0]!.quiet, true);
});

test('a question: one button per option, Open; a many-part question only Open', () => {
  const q = (over: Partial<PendingQuestion> = {}): PendingQuestion => ({
    id: 'q1', taskId: 't1', agentId: 'scribe', at: iso('10:49'), projectId: P1,
    questions: [{ question: 'Which checkout copy should ship?', header: 'Copy', multiSelect: false, options: [{ label: 'Pay now', description: 'Shorter' }, { label: 'Pay now, delivery included', description: 'Explains the fee' }] }], ...over,
  });
  const r = buildAskRows(facts({ questions: [q()] }), policy)[0]!;
  assert.equal(r.kind, 'question');
  assert.equal(r.what, 'asks: Which checkout copy should ship?');
  assert.deepEqual(r.buttons.map((b) => [b.act, b.label]), [['opt', 'Pay now'], ['opt', 'Pay now, delivery included'], ['open', 'Open']]);
  assert.equal(r.buttons[0]!.option, 'Pay now');
  assert.equal(r.hold, 5000);
  assert.equal(r.level, 0);
  const multi = buildAskRows(facts({ questions: [q({ questions: [q().questions[0]!, q().questions[0]!] })] }), policy)[0]!;
  assert.deepEqual(multi.buttons.map((b) => b.act), ['open']);
  const many = buildAskRows(facts({ questions: [q({ questions: [{ ...q().questions[0]!, multiSelect: true }] })] }), policy)[0]!;
  assert.deepEqual(many.buttons.map((b) => b.act), ['open']);
});

test('a board proposal is tinted, untrusted, and never reads as certain-safe', () => {
  const item = { id: 'wi_aaaaaaaaaaaa', projectId: P1, title: 'Move the deploy to one step', description: 'push to main', createdAt: iso('10:02'), createdBy: { kind: 'agent', id: 'scout' }, proposal: { suggestedAssignee: 'builder' } } as unknown as WorkItem;
  const r = buildAskRows(facts({ board: { items: [], inbox: [item] } }), policy)[0]!;
  assert.equal(r.kind, 'proposal');
  assert.equal(r.untrusted, true);
  assert.equal(r.chip, 'Written after outside content');
  assert.deepEqual(r.buttons.map((b) => b.act), ['read', 'accept', 'reject']);
  assert.equal(r.buttons[0]!.strong, true);
  assert.equal(r.buttons[1]!.label, 'Accept, keep it marked');
  assert.equal(r.buttons[1]!.held, true);
  assert.equal(r.buttons[2]!.held, false);
  assert.equal(r.trust, 'Accepting or editing keeps it marked untrusted. Only "Mark as reviewed" clears it.');
  assert.equal(r.boardId, 'wi_aaaaaaaaaaaa');
});

test('rows come riskiest first, then oldest first', () => {
  const rows = buildAskRows(facts({ approvals: [read('r1', 1), bash('a1', 't1', 'npm publish'), bash('a2', 't1', 'rm -rf dist/old', { at: iso('11:26') })] }), policy);
  assert.deepEqual(rows.map((r) => r.key), ['a1', 'a2', 'r1']);
});

test('wait line: deny, park, quiet hours; an ask that just arrived', () => {
  assert.equal(DEFAULT_WAIT_MIN, 10);
  const at = iso('11:23');
  assert.equal(waitLine(at, NOW, policy), 'Waiting 7 min, denied at 10 min');
  assert.equal(waitLine(at, NOW, { mode: 'park', parkMinutes: 3 }), 'Waiting 7 min, parks at 3 min');
  assert.equal(waitLine(iso('11:30'), NOW, policy), 'Waiting under 1 min, denied at 10 min');
  const quiet = { mode: 'deny' as const, parkMinutes: 3, quiet: { enabled: true, from: '11:00', to: '13:00' } };
  assert.equal(waitLine(at, NOW, quiet), 'Waiting: quiet hours until 13:00');
  assert.equal(waitLine(at, NOW, { ...quiet, quiet: { enabled: false, from: '11:00', to: '13:00' } }), 'Waiting 7 min, denied at 10 min');
});

/* ---------- which rows are on screen ---------- */
import { reconcileShown } from '../ui/src/projects/page/askLogic.js';

test('shown rows: the top three fill in order; the rest wait behind "N more"', () => {
  const r = reconcileShown({ prev: [], live: ['a', 'b', 'c', 'd', 'e'], answered: new Set(), cap: 3, expanded: false, frozen: false });
  assert.deepEqual(r.shown, ['a', 'b', 'c']);
  assert.equal(r.more, 2);
});

test('shown rows: a row answered elsewhere leaves at once and the next one is promoted', () => {
  const r = reconcileShown({ prev: ['a', 'b', 'c'], live: ['a', 'c', 'd', 'e'], answered: new Set(), cap: 3, expanded: false, frozen: false });
  assert.deepEqual(r.shown, ['a', 'c', 'd']);
});

test('shown rows: while the pointer or focus is inside, nothing is promoted and an answered row keeps its place', () => {
  const live = ['a', 'c', 'd', 'e'];
  const r = reconcileShown({ prev: ['a', 'b', 'c'], live, answered: new Set(['b']), cap: 3, expanded: false, frozen: true });
  assert.deepEqual(r.shown, ['a', 'b', 'c'], 'b is answered and gone from the core, but stays in its slot');
  const after = reconcileShown({ prev: r.shown, live, answered: new Set(), cap: 3, expanded: false, frozen: false });
  assert.deepEqual(after.shown, ['a', 'c', 'd'], 'once nothing is under the pointer the slot closes and d moves up');
});

test('shown rows: frozen does not stop a vanished, unanswered row from leaving', () => {
  const r = reconcileShown({ prev: ['a', 'b'], live: ['a'], answered: new Set(), cap: 3, expanded: false, frozen: true });
  assert.deepEqual(r.shown, ['a']);
});

test('shown rows: expanded shows every live row, and a new ask never hides one', () => {
  const r = reconcileShown({ prev: ['a', 'b', 'c'], live: ['a', 'b', 'c', 'd', 'e'], answered: new Set(), cap: 3, expanded: true, frozen: false });
  assert.deepEqual(r.shown, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(r.more, 0);
  const total = reconcileShown({ prev: ['a', 'b', 'c'], live: ['x', 'a', 'b', 'c'], answered: new Set(), cap: 3, expanded: false, frozen: false });
  assert.equal(total.shown.length + total.more, 4, 'every open ask is either shown or counted');
});

test('shown rows: a first render under a resting pointer still shows the top three', () => {
  const r = reconcileShown({ prev: [], live: ['a', 'b', 'c', 'd'], answered: new Set(), cap: 3, expanded: false, frozen: true });
  assert.deepEqual(r.shown, ['a', 'b', 'c']);
});

test('reconcileShown: a pinned row (the one an open-ask landed for) is shown even past the cap', () => {
  const r = reconcileShown({ prev: [], live: ['a', 'b', 'c', 'd', 'e'], answered: new Set(), cap: 3, expanded: false, frozen: false, pin: 'e' });
  assert.deepEqual(r.shown, ['a', 'b', 'c', 'e']);
  assert.equal(r.more, 1);
  const r2 = reconcileShown({ prev: [], live: ['a', 'b', 'c', 'd'], answered: new Set(), cap: 3, expanded: false, frozen: false, pin: 'gone' });
  assert.deepEqual(r2.shown, ['a', 'b', 'c']);
});
