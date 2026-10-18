/** Gates PR 2, dead rows: every switch on the Gates page acts. Stall ladder, budget stop and digest hold are read per run (UI half: gates-dead-rows-ui.test.ts); ask-timeout-deny is a rail; the goal and QA rows wait for goals. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATES, LIMIT_GATE_IDS, PERMISSION_GATE_IDS, PRESETS, gateValue } from '../src/shared/gates-registry.js';
import { GatesError, GatesStore } from '../src/core/gates-settings/store.js';
import { canonicalize, makeSigner } from '../src/core/gates-settings/sign.js';
import { permissionRows, qaRows, railRows } from '../ui/src/gates/presetsLogic.js';
import type { GatesView } from '../ui/src/gates/presetsLogic.js';
import { BoardStore } from '../src/core/projects/board/store.js';
import type { ProjectRef } from '../src/core/projects/board/store.js';
import { Store } from '../src/core/store.js';
import { Marshal, stallKeptText } from '../src/core/marshal/orchestrator.js';
import type { MarshalPorts, RunState } from '../src/core/marshal/orchestrator.js';
import { MarshalDriver } from '../src/core/marshal/driver.js';
import type { ProseMatcher } from '../src/core/marshal/match.js';
import { setup } from './away-rig.js';
import { tempDir } from './tmp-cleanup.js';

const view = (over: Partial<GatesView> = {}): GatesView => ({ app: { version: 1 }, projects: {}, unreadable: [], changedOutside: [], canSign: true, ...over });
const GOAL_AND_QA = ['goal-caps', 'qa-harness-check', 'qa-fail-first', 'qa-freeze-checks', 'qa-evidence', 'qa-regression', 'qa-fresh-reviewer', 'qa-goal-checks'];

// ---- the registry and the page rows ----

test('ask-timeout-deny is a rail: always on, no switch, with its plain sentence', () => {
  const g = GATES.find((x) => x.id === 'ask-timeout-deny')!;
  assert.equal(g.family, 'rail');
  assert.equal(g.defaults, 'always');
  assert.match(g.protects, /refused after 10 minutes/);
  assert.ok(!PERMISSION_GATE_IDS.includes('ask-timeout-deny'), 'the window cannot name it');
  for (const p of PRESETS) assert.equal(gateValue('ask-timeout-deny', { app: { version: 1, preset: p }, project: { version: 1, overrides: { 'ask-timeout-deny': false } as never } }), true, `an override is ignored in ${p}`);
  assert.ok(railRows().some((r) => r.id === 'ask-timeout-deny' && /refused after 10 minutes/.test(r.protects)), 'the rails list shows it');
});

test('the goal and QA rows wait for goals behind one flag; nothing else carries it', () => {
  for (const id of GOAL_AND_QA) assert.equal((GATES.find((g) => g.id === id) as { ships?: string }).ships, 'goals', id);
  assert.deepEqual(GATES.filter((g) => 'ships' in g).map((g) => g.id).sort(), [...GOAL_AND_QA].sort());
  for (const id of GOAL_AND_QA) assert.ok(!PERMISSION_GATE_IDS.includes(id), `${id} is not a gate the window may name`);
  assert.deepEqual([...LIMIT_GATE_IDS], ['attempt-caps']);
});

test('Fine tuning lists the 14 gates that act; the QA card has no rows; both scopes agree', () => {
  const ids = permissionRows(view()).map((r) => r.id);
  assert.equal(ids.length, 14);
  for (const id of [...GOAL_AND_QA, 'ask-timeout-deny']) assert.ok(!ids.includes(id), `${id} is not listed`);
  for (const id of ['digest-hold', 'stall-ladder', 'budget-stop']) assert.ok(ids.includes(id), `${id} is listed`);
  assert.deepEqual(permissionRows(view({ projects: { p1: { version: 1, preset: 'smart' } } }), 'p1').map((r) => r.id), ids);
  assert.deepEqual(qaRows(), []);
});

// ---- the store ----

const P = 'proj_aaaaaaaaaaaa';
const mkStore = () => {
  const dir = join(tempDir('legion-dead-rows-'), 'gates');
  mkdirSync(dir, { recursive: true });
  const signer = makeSigner(Buffer.alloc(32, 7))!;
  return { dir, signer, open: () => new GatesStore(dir, { allowed: PRESETS, signer }) };
};

test('a change that names a hidden gate or the old ask-timeout-deny switch is refused', () => {
  const { open } = mkStore(); const s = open();
  for (const id of ['ask-timeout-deny', ...GOAL_AND_QA]) {
    assert.throws(() => s.patchProject(P, { overrides: { [id]: false } }), (e: unknown) => e instanceof GatesError && e.status === 400 && /not a gate you can change/.test(e.message), id);
  }
});

test('a stored override for ask-timeout-deny (or a goal gate) is ignored and harmless: the file still verifies and loads', async () => {
  const { dir, open, signer } = mkStore(); const s = open();
  s.patchApp({ preset: 'ask' });
  s.patchProject(P, { overrides: { 'github-write-card': false } });
  await s.flush();
  const f = join(dir, `${P}.json`);
  const { sig: _sig, ...disk } = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown> & { overrides: Record<string, unknown> };
  const old = { ...disk, overrides: { ...disk.overrides, 'ask-timeout-deny': false, 'goal-caps': { on: true, limit: 50 } } };
  writeFileSync(f, JSON.stringify({ ...old, sig: signer.sign(P, canonicalize(old as never)) }));
  const t = open();
  assert.deepEqual(t.changedOutside(), [], 'a signed file from an older Legion still verifies');
  assert.deepEqual(t.view([P]).unreadable, []);
  assert.deepEqual(t.project(P).overrides, { 'github-write-card': false }, 'the known override applies, the others are dropped');
  assert.equal(gateValue('ask-timeout-deny', { app: t.app(), project: t.project(P) }), true);
});

test('the confirm lines for a looser preset name only gates that act: no goal limit, no QA', () => {
  const { open } = mkStore(); const s = open();
  const pv = s.preview(P, { preset: 'bypass' });
  const text = pv.lines.join('\n');
  assert.ok(pv.loosening.some((l) => l.startsWith('Ask before tools run: off')), 'tool cards are named');
  assert.doesNotMatch(text, /Limit the size of a goal/);
  assert.match(text, /Limit retries on one item: the limit goes from 4 to 8/, 'the retry limit is still named');
});

// ---- budget stop (engine) ----

const budgetRig = () => {
  const s = setup({ maxConcurrent: 4, gatesCore: true });
  s.away.budget.add(s.project.id);
  const reason = (taskId: string) => s.engine.queueSnapshot().items.find((i) => i.taskId === taskId)?.reason;
  return { s, reason };
};

test('budget stop on (the default): a start past the budget waits with the reason budget', async () => {
  const { s, reason } = budgetRig();
  const t = s.start('a1', 'budget job');
  await s.tick();
  assert.equal(reason(t.id), 'budget');
  assert.equal(s.started.length, 0);
  s.away.budget.clear(); s.bus.emit({ type: 'away.updated' });
  await s.tick();
  s.release('budget job'); await s.tick(60);
});

test('budget stop off for the project: the run starts past the budget, and the queue shows no budget hold', async () => {
  const { s, reason } = budgetRig();
  s.core!.store.patchProject(s.project.id, { overrides: { 'budget-stop': false } });
  const t = s.start('a1', 'free job');
  await s.tick();
  assert.equal(s.started.length, 1, 'it started');
  assert.equal(reason(t.id), undefined);
  assert.equal(s.away.budget.has(s.project.id), true, 'the budget itself is untouched');
  s.release('free job'); await s.tick(60);
});

test('budget stop switched off while a run waits: it starts when the settings change', async () => {
  const { s, reason } = budgetRig();
  const t = s.start('a1', 'waiting job');
  await s.tick();
  assert.equal(reason(t.id), 'budget');
  s.core!.store.patchProject(s.project.id, { overrides: { 'budget-stop': false } });
  s.bus.emit({ type: 'gates.updated' });
  await s.tick();
  assert.equal(s.started.length, 1);
  s.release('waiting job'); await s.tick(60);
});

test('budget stop is read with the project the run started in: another project switch changes nothing here', async () => {
  const { s, reason } = budgetRig();
  const other = s.projects.setMembers(s.projects.create({ name: 'Other', instructions: '' }).id, ['a1', 'a2', 'a3']);
  s.core!.store.patchProject(other.id, { overrides: { 'budget-stop': false } });
  s.core!.store.patchApp({ preset: 'ask' });
  const t = s.start('a1', 'mine');
  await s.tick();
  assert.equal(reason(t.id), 'budget');
  assert.equal(s.started.length, 0);
  s.away.budget.clear(); s.bus.emit({ type: 'away.updated' }); await s.tick();
  s.release('mine'); await s.tick(60);
});

test('with no gates core the budget holds as before', async () => {
  const s = setup({ maxConcurrent: 4 });
  s.away.budget.add(s.project.id);
  const t = s.start('a1', 'plain');
  await s.tick();
  assert.equal(s.engine.queueSnapshot().items.find((i) => i.taskId === t.id)?.reason, 'budget');
  s.away.budget.clear(); s.bus.emit({ type: 'away.updated' }); await s.tick();
  s.release('plain'); await s.tick(60);
});

// ---- stall ladder (Marshal and its driver) ----

const PID = 'proj_aaaaaaaaaaaa';
const MEMBERS = ['zealot', 'builder', 'scout'];
const PROJ: ProjectRef = { id: PID, members: MEMBERS, status: 'active' };
const T0 = Date.parse('2026-10-12T12:00:00Z');
const MIN = 60_000;
const matchBuilder: ProseMatcher = (input) => ({ botId: 'builder', reason: 'the builder', matched: [], considered: input.catalog.map((b) => b.id), confidence: 0.9, outcome: 'assigned' });

function stallRig() {
  const dir = tempDir('legion-stall-ladder-');
  const board = new BoardStore(dir, () => T0);
  const agents = new Store(`${dir}/state`);
  agents.seedDefaults(agents.dir);
  const states = new Map<string, RunState>();
  const cancelled: string[] = [];
  let seq = 0;
  board.setRunLookup((taskId) => { const s = states.get(taskId); return { live: s?.status === 'running' || s?.status === 'queued', agentId: 'builder' }; });
  const ports: MarshalPorts = {
    board, agents: () => agents.listAgents(), visible: () => true, matcher: matchBuilder,
    startRun: () => { const taskId = `task_${++seq}`; states.set(taskId, { status: 'running', progressAt: T0 }); return { taskId }; },
    runState: (taskId) => states.get(taskId) ?? { status: 'unknown' },
    cancelRun: (taskId) => { cancelled.push(taskId); states.set(taskId, { status: 'cancelled' }); return true; },
  };
  const item = board.create(PROJ, { title: 'the rabbit hole' });
  return { board, ports, states, cancelled, item };
}

test('stall ladder on (explicitly): a stalled run is stopped, and the gate is read with this project', async () => {
  const r = stallRig();
  const asked: string[] = [];
  const m = new Marshal(r.ports, PROJ, { stallLadder: (pid) => { asked.push(pid); return true; } });
  m.writeDoneWhen(r.item.id, ['done']);
  await m.step(T0);
  const mon = m.monitor(T0 + 9 * MIN);
  assert.deepEqual(mon.stalled, [r.item.id]);
  assert.equal(r.cancelled.length, 1);
  assert.deepEqual([...new Set(asked)], [PID]);
});

test('stall ladder off: a stalled run keeps going, the board is untouched, and one line says so (once)', async () => {
  const r = stallRig();
  const kept: Array<{ itemId: string; title: string; taskId: string; botId: string; minutes: number }> = [];
  const m = new Marshal(r.ports, PROJ, { stallLadder: () => false, onStallKept: (a) => kept.push(a) });
  m.writeDoneWhen(r.item.id, ['done']);
  const dispatched = (await m.step(T0)).dispatched[0]!;
  const first = m.monitor(T0 + 9 * MIN);
  assert.deepEqual(first.stalled, [], 'not stopped');
  assert.deepEqual(first.stallsKept, [r.item.id]);
  assert.deepEqual(r.cancelled, [], 'the run was not cancelled');
  assert.equal(r.board.get(PID, r.item.id)!.status, 'doing');
  assert.equal(r.board.get(PID, r.item.id)!.activeRun, dispatched.taskId, 'its run is still the item run');
  const second = m.monitor(T0 + 20 * MIN);
  assert.deepEqual(second.stalled, []);
  assert.equal(kept.length, 1, 'the line is written once per run, not every pass');
  assert.deepEqual(kept[0], { itemId: r.item.id, title: 'the rabbit hole', taskId: dispatched.taskId, botId: 'builder', minutes: 8 });
  assert.equal(m.ledger.stalls(r.item.id), 0, 'no stall is counted: the ladder did not run');
  // the run ends by itself: it settles like any other
  r.states.set(dispatched.taskId, { status: 'done' });
  assert.deepEqual(m.monitor(T0 + 21 * MIN).finished, [r.item.id]);
});

test('stall ladder switched back on: the next pass stops the still-silent run', async () => {
  const r = stallRig();
  let on = false;
  const m = new Marshal(r.ports, PROJ, { stallLadder: () => on });
  m.writeDoneWhen(r.item.id, ['done']);
  await m.step(T0);
  assert.deepEqual(m.monitor(T0 + 9 * MIN).stalled, []);
  on = true;
  assert.deepEqual(m.monitor(T0 + 10 * MIN).stalled, [r.item.id]);
  assert.equal(r.cancelled.length, 1);
});

test('a run waiting on you or queued is not a stall, with the ladder off or on (no line written)', async () => {
  const r = stallRig();
  const kept: unknown[] = [];
  const m = new Marshal(r.ports, PROJ, { stallLadder: () => false, onStallKept: (a) => kept.push(a) });
  m.writeDoneWhen(r.item.id, ['done']);
  const d = (await m.step(T0)).dispatched[0]!;
  r.states.set(d.taskId, { status: 'running', progressAt: T0, waitingOnOwner: true });
  assert.deepEqual(m.monitor(T0 + 30 * MIN).stallsKept, []);
  assert.deepEqual(kept, []);
});

test('the driver reads the stall gate per project on every pass and passes the line on', async () => {
  const r = stallRig();
  r.board.setMarshal(PROJ, { enabled: true, waveSize: 1, stallMinutes: 8 });
  let now = T0; let on = false;
  const asked: string[] = []; const lines: Array<{ pid: string; itemId: string }> = [];
  const d = new MarshalDriver({
    board: r.board, project: () => PROJ, ports: () => r.ports, changed: () => undefined, now: () => now, schedule: () => () => undefined,
    stallLadder: (pid) => { asked.push(pid); return on; },
    stallKept: (pid, a) => lines.push({ pid, itemId: a.itemId }),
  });
  d.marshalFor(PID)!.writeDoneWhen(r.item.id, ['done']);
  await d.tick(PID);
  now = T0 + 9 * MIN;
  await d.tick(PID);
  assert.deepEqual(r.cancelled, [], 'off: the pass did not stop it');
  assert.deepEqual(lines, [{ pid: PID, itemId: r.item.id }]);
  on = true; now = T0 + 10 * MIN;
  await d.tick(PID);
  assert.equal(r.cancelled.length, 1, 'on again: stopped');
  assert.ok(asked.length >= 2 && asked.every((p) => p === PID));
});

test('the stall line is plain: it names the item and the minutes, says it was not stopped, and has no em dash', () => {
  const t = stallKeptText({ itemId: 'wi_x', title: 'the rabbit hole', taskId: 't', botId: 'builder', minutes: 8 });
  assert.match(t, /the rabbit hole/);
  assert.match(t, /8 minutes/);
  assert.match(t, /not stopped/);
  assert.match(t, /Stop runs that stall is off/);
  assert.ok(!t.includes(String.fromCharCode(8212)));
});

test('the composition root hands the core gates to the board module', () => {
  const src = readFileSync(`${process.cwd()}/src/bin/legion-core.ts`, 'utf8');
  assert.match(src, /gatesCore\.gate\('stall-ladder', pid\) !== false/);
  assert.match(src, /activity/);
});
