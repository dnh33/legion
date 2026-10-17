// test/activity-log.test.ts: the activity log (append, cap, scrub, prune, read), its module (bus lines, protected folder, GET /api/activity)
// and the would-have-asked lines the engine writes at decision points (rig: test/gates-rig.ts)
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isClientRoute } from '../src/core/admin.js';
import { createActivityLog, createActivityModule } from '../src/core/activity/index.js';
import { createGatesCore, createGatesModule } from '../src/core/gates-settings/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { tempDir } from './tmp-cleanup.js';
import { gatesRig } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import { AUTH, asClient, makeFakes, start } from './helpers-c.js';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const fresh = (now = NOW) => { const dataDir = join(tempDir('legion-activity-'), 'data'); return { dataDir, log: createActivityLog({ dataDir, now: () => now }) }; };
const using = async (o: Parameters<typeof gatesRig>[0], body: (r: GatesRig) => Promise<void>) => {
  const r = await gatesRig(o);
  try { await body(r); } finally { r.stop(); }
};

test('append writes one JSON line to today\'s file and read returns it newest first', () => {
  const { log } = fresh();
  log.append({ kind: 'note', text: 'first' });
  log.append({ kind: 'note', text: 'second', taskId: 't1', projectId: 'p1', agentId: 'a1', data: { n: 2, ok: true } });
  const file = join(log.folder, '2026-10-17.jsonl');
  const raw = readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.equal(raw.length, 2, 'one JSON per line');
  assert.deepEqual(Object.keys(JSON.parse(raw[0]!)).sort(), ['at', 'kind', 'text']);
  const got = log.read();
  assert.deepEqual(got.map((l) => l.text), ['second', 'first'], 'newest first');
  assert.equal(got[0]!.at, '2026-10-17T12:00:00.000Z');
  assert.deepEqual(got[0]!.data, { n: 2, ok: true });
  assert.deepEqual(log.read({ taskId: 't1' }).map((l) => l.text), ['second']);
  assert.deepEqual(log.read({ projectId: 'p1' }).map((l) => l.text), ['second']);
  assert.deepEqual(log.read({ kinds: ['goal-state'] }), []);
  assert.deepEqual(log.read({ day: '2026-10-16' }), []);
  assert.equal(log.read({ limit: 1 }).length, 1);
  assert.equal(log.read({ day: '../../x' }).length, 0, 'a day that is not a date reads nothing');
});

test('the per-run cap: 2000 lines then one summary line, and nothing after', () => {
  const { log, dataDir } = fresh();
  for (let i = 0; i < 2105; i++) log.append({ kind: 'note', text: `line ${i}`, taskId: 'busy' });
  log.append({ kind: 'note', text: 'other task', taskId: 'calm' });
  log.append({ kind: 'note', text: 'no task' });
  assert.equal(log.read({ taskId: 'busy', limit: 5000 }).length, 1000, 'read is capped at 1000');
  const fileOf = () => readFileSync(join(dataDir, 'activity', '2026-10-17.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as { taskId?: string; text: string });
  const all = fileOf();
  const mine = all.filter((l) => l.taskId === 'busy');
  assert.equal(mine.length, 2001, '2000 lines and one summary');
  assert.equal(mine[2000]!.text, 'Activity for this run was cut at 2,000 lines.');
  assert.equal(mine.filter((l) => l.text.startsWith('Activity for this run')).length, 1, 'exactly one summary');
  assert.equal(all.filter((l) => l.taskId === 'calm').length, 1, 'another task is not cut');
  assert.equal(all.filter((l) => l.taskId === undefined).length, 1, 'a line with no task has no cap');
  // a core restart does not give the run a fresh 2,000
  const again = createActivityLog({ dataDir, now: () => NOW });
  again.append({ kind: 'note', text: 'after restart', taskId: 'busy' });
  assert.equal(fileOf().filter((l) => l.taskId === 'busy').length, 2001, 'still nothing after the summary');
});

test('lines are scrubbed and clipped; a secret-looking token never reaches the file', () => {
  const { log } = fresh();
  const key = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv';
  log.append({ kind: 'card-asked', text: `Asked: curl -H "Authorization: Bearer ${key}" https://x.test/a?token=abc12345secret`, data: { cmd: `API_KEY=${key}${'z'.repeat(500)}` } });
  log.append({ kind: 'note', text: 'x'.repeat(900) });
  const file = readFileSync(join(log.folder, '2026-10-17.jsonl'), 'utf8');
  assert.ok(!file.includes(key), 'the key is not in the file');
  assert.ok(!file.includes('abc12345secret'), 'the query token is not in the file');
  const [clipped, scrubbed] = log.read();
  assert.ok(clipped!.text.length <= 400, 'text is cut at 400');
  assert.ok(String(scrubbed!.data!.cmd).length <= 400);
  assert.match(scrubbed!.text, /<omitted>|redacted/, 'the curl header is dropped (scrubShell) or redacted');
});

test('prune deletes day files older than 30 days and keeps the rest', () => {
  const { log, dataDir } = fresh();
  mkdirSync(join(dataDir, 'activity'), { recursive: true });
  const put = (n: string) => writeFileSync(join(dataDir, 'activity', n), '{"at":"x","kind":"note","text":"t"}\n');
  for (const d of ['2026-08-01', '2026-09-10', '2026-09-16', '2026-09-17', '2026-10-01', '2026-10-17']) put(`${d}.jsonl`);
  put('notes.txt');
  log.prune(NOW);
  assert.deepEqual(readdirSync(join(dataDir, 'activity')).sort(), ['2026-09-17.jsonl', '2026-10-01.jsonl', '2026-10-17.jsonl', 'notes.txt']);
});

test('append never throws on a read-only folder', () => {
  const root = tempDir('legion-activity-ro-');
  const blocker = join(root, 'data');
  writeFileSync(blocker, 'a file where the data folder should be');
  const log = createActivityLog({ dataDir: blocker, now: () => NOW });
  assert.doesNotThrow(() => log.append({ kind: 'note', text: 'cannot be written' }));
  assert.doesNotThrow(() => log.wouldHaveAsked({ gateId: 'tool-cards', label: 'Ask before tools run', action: 'Bash ls', taskId: 't' }));
  assert.deepEqual(log.read(), []);
  assert.doesNotThrow(() => log.prune(NOW));
  assert.equal(existsSync(join(blocker, 'activity')), false);
});

test('the folder is a protected path of the module', () => {
  const { log } = fresh();
  const mod = createActivityModule({ bus: { on: () => () => undefined } } as never, log);
  assert.deepEqual(mod.protectedPaths?.(), [log.folder]);
  assert.equal(mod.id, 'activity');
});

test('would-have-asked: Bypass lets Bash through, the log gets "Would have asked: <action>, because Ask before tools run is off"', async () => {
  await using({ preset: 'bypass', follow: true }, async (r) => {
    const d = await r.run('Bash', { command: 'rm -rf build' });
    assert.deepEqual([d.card, d.allow], [false, true]);
    const lines = r.activityRead({ kinds: ['would-have-asked'] });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.text, 'Would have asked: Bash rm -rf build, because Ask before tools run is off');
    assert.equal(lines[0]!.taskId, r.task.id);
    assert.equal(lines[0]!.projectId, r.project.id);
    assert.equal(lines[0]!.agentId, 'a1');
    assert.equal(lines[0]!.data?.gateId, 'tool-cards');
    // the Claude path in a run that started in Bypass: the PreToolUse hook writes the same kind of line
    const h = await r.hook('Bash', { command: 'git push origin main' });
    assert.equal(h.card, false);
    assert.deepEqual(r.activityRead({ kinds: ['would-have-asked'] }).map((l) => l.text).sort(), ['Would have asked: Bash git push origin main, because Ask before tools run is off', 'Would have asked: Bash rm -rf build, because Ask before tools run is off']);
  });
});

test('would-have-asked is computed only at decision points: a plain Read produces none', async () => {
  await using({ preset: 'bypass', follow: true }, async (r) => {
    await r.run('Read', { file_path: 'notes.txt' });
    await r.hook('Read', { file_path: 'notes.txt' });
    assert.deepEqual(r.activityRead({ kinds: ['would-have-asked'] }), []);
  });
  // an agent that is Full on its own would not have asked either
  await using({ preset: 'bypass', own: 'full' }, async (r) => {
    await r.run('Bash', { command: 'echo hi' });
    assert.deepEqual(r.activityRead({ kinds: ['would-have-asked'] }), []);
  });
});

test('Ask produces no would-have-asked lines (no gate is off)', async () => {
  await using({ preset: 'ask', follow: true }, async (r) => {
    const d = await r.run('Bash', { command: 'echo hi' });
    assert.equal(d.card, true);
    assert.deepEqual(r.activityRead({ kinds: ['would-have-asked'] }), []);
  });
});

test('a card asked and answered produce two lines each with the task id', async () => {
  await using({ preset: 'ask', follow: true }, async (r) => {
    await r.run('Bash', { command: 'echo hi' });
    const lines = r.activityRead({ kinds: ['card-asked', 'card-answered'] });
    assert.deepEqual(lines.map((l) => l.kind).sort(), ['card-answered', 'card-asked']);
    for (const l of lines) assert.equal(l.taskId, r.task.id);
    assert.match(lines.find((l) => l.kind === 'card-asked')!.text, /^Asked: echo hi/);
    assert.equal(lines.find((l) => l.kind === 'card-answered')!.data?.allowed, false);
    assert.ok(r.activityRead({ kinds: ['run-start'] }).some((l) => l.taskId === r.task.id), 'the run start is there too');
  });
});

test('GET /api/activity is admin only and filters by project', async () => {
  const { log, dataDir } = fresh();
  const f = makeFakes({ holdRuns: true });
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir, bsvEnabled: () => false };
  const mod = createActivityModule(deps as never, log);
  (f.ctx as { modules?: unknown }).modules = [mod];
  const s = await start(f.ctx);
  try {
    log.append({ kind: 'note', text: 'in p1', projectId: 'p1' });
    log.append({ kind: 'note', text: 'in p2', projectId: 'p2' });
    log.append({ kind: 'goal-state', text: 'goal', projectId: 'p1', taskId: 'goal:g1' });
    assert.equal(isClientRoute('GET', '/api/activity'), false);
    assert.equal((await fetch(`${s.base}/api/activity`, { headers: asClient })).status, 403);
    assert.equal((await fetch(`${s.base}/api/activity`)).status, 401);
    const all = (await (await fetch(`${s.base}/api/activity`, { headers: AUTH })).json()) as Array<{ text: string }>;
    assert.equal(all.length, 3);
    const p1 = (await (await fetch(`${s.base}/api/activity?projectId=p1`, { headers: AUTH })).json()) as Array<{ text: string }>;
    assert.deepEqual(p1.map((l) => l.text), ['goal', 'in p1']);
    const kinds = (await (await fetch(`${s.base}/api/activity?projectId=p1&kinds=goal-state,bogus&limit=5`, { headers: AUTH })).json()) as Array<{ text: string }>;
    assert.deepEqual(kinds.map((l) => l.text), ['goal']);
    const t = (await (await fetch(`${s.base}/api/activity?taskId=${encodeURIComponent('goal:g1')}`, { headers: AUTH })).json()) as Array<{ text: string }>;
    assert.equal(t.length, 1);
  } finally { await mod.dispose?.(); await s.close(); }
});

test('a successful gates change writes gate-changed lines; a refused one writes none', async () => {
  const { log, dataDir } = fresh();
  const projects = new ProjectStore(dataDir, join(dataDir, 'ws'));
  const p = projects.create({ name: 'Shop' });
  const f = makeFakes({ holdRuns: true });
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir, bsvEnabled: () => false };
  const core = createGatesCore({ dataDir, projects, keyring: { get: () => Buffer.alloc(32, 9) } as never });
  const mod = createGatesModule(deps as never, { projects, core, activity: log });
  (f.ctx as { modules?: unknown }).modules = [mod];
  const s = await start(f.ctx);
  const J = { 'Content-Type': 'application/json' };
  try {
    const ok = await fetch(`${s.base}/api/gates/projects/${p.id}`, { method: 'PATCH', headers: { ...AUTH, ...J }, body: JSON.stringify({ preset: 'smart' }) });
    assert.equal(ok.status, 403, 'Smart loosens: it needs the app confirm, so nothing is written');
    assert.deepEqual(log.read({ kinds: ['gate-changed'] }), []);
    const ask = await fetch(`${s.base}/api/gates/projects/${p.id}`, { method: 'PATCH', headers: { ...AUTH, ...J }, body: JSON.stringify({ preset: 'ask' }) });
    assert.equal(ask.status, 200);
    const lines = log.read({ kinds: ['gate-changed'] });
    assert.equal(lines[0]!.text, 'Preset set to Ask for project Shop');
    assert.equal(lines[0]!.projectId, p.id);
  } finally { await mod.dispose?.(); await s.close(); }
});

test('run-end is written once: a rename or archive of a finished task adds nothing', () => {
  const { log } = fresh();
  let emit: (ev: unknown) => void = () => undefined;
  createActivityModule({ bus: { on: (fn: (ev: unknown) => void) => { emit = fn; return () => undefined; } } } as never, log);
  const task = (status: string, title = 'x') => ({ type: 'task.updated', task: { id: 't9', agentId: 'a1', status, title } });
  emit(task('done', 'old run seen first after a restart'));
  emit(task('running')); emit(task('done')); emit(task('done', 'renamed')); emit(task('done', 'archived'));
  const lines = log.read({ taskId: 't9' });
  assert.deepEqual(lines.map((l) => l.kind).reverse(), ['run-start', 'run-end']);
});

test('a token cut by the action length never leaves a prefix in the file', () => {
  const { log } = fresh();
  const token = 'sk-ant-api03-' + 'A1b2C3d4E5'.repeat(8);
  log.wouldHaveAsked({ gateId: 'tool-cards', label: 'Ask before tools run', action: 'Bash ' + 'x'.repeat(290) + ' ' + token, taskId: 't1' });
  const raw = readFileSync(join(log.folder, '2026-10-17.jsonl'), 'utf8');
  assert.equal(raw.includes('sk-ant'), false);
});
