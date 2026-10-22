/**
 * Stop asks first (the in-app dialog does not freeze the page), so the page can move on while the question is open: a keyboard shortcut
 * or an event changes the selection, or the run ends and the queue starts another. The task asked about is the task cancelled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { tempDir } from './tmp-cleanup.js';
import type { Task } from '../src/shared/types.js';

// api.ts reads `window` when it loads, so the stub goes in before the import.
(globalThis as unknown as { window: unknown }).window = { location: { search: '' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };

const posix = (f: string): string => join(process.cwd(), f).replace(/\\/g, '/');
const dir = tempDir('legion-stop-asked-');
const entry = join(dir, 'entry.ts');
writeFileSync(entry, `export * from '${posix('ui/src/store.ts')}';\nexport { answerAsk, currentAsk, resetAskForTests } from '${posix('ui/src/components/askStore.ts')}';\n`);
const out = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
writeFileSync(join(dir, 'store.mjs'), out.outputFiles[0]!.text);
const store = await import(pathToFileURL(join(dir, 'store.mjs')).href) as {
  getState(): { tasks: Task[]; selectedTaskId: string | null };
  setState(p: Record<string, unknown>): void;
  stopAskedRun(taskId: string | null, onStop?: () => void): Promise<boolean>;
  cancelSelected(): Promise<void>;
  answerAsk(id: number, yes: boolean): void;
  currentAsk(): { id: number; title: string } | null;
  resetAskForTests(): void;
};

const task = (id: string, status: Task['status']): Task => ({ id, agentId: 'zealot', title: id, status, source: 'ui', requestedModel: 'auto', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as Task);
const run = (startedAt: string, background = 2) => ({ startedAt, turn: 1, maxTurns: 10, tool: null, background });

/** The cancel requests the page sent, as task ids. */
const cancelled: string[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
  const m = /\/api\/tasks\/([^/]+)\/cancel$/.exec(String(url));
  if (m) cancelled.push(decodeURIComponent(m[1]!));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

function setup(): void {
  store.resetAskForTests();
  cancelled.length = 0;
  store.setState({ tasks: [task('A', 'running'), task('B', 'running')], selectedTaskId: 'A', progress: { A: run('t1'), B: run('t1') } });
}
/** Lets the page's pending promises settle, then answers the open question. */
const answer = async (yes: boolean): Promise<void> => {
  for (let i = 0; i < 5 && !store.currentAsk(); i++) await Promise.resolve();
  const q = store.currentAsk();
  assert.ok(q, 'the question is open');
  store.answerAsk(q.id, yes);
};

test('the selection moves to another task while the question is open: the task asked about is the one stopped', async () => {
  setup();
  const stopping = store.stopAskedRun('A');
  await Promise.resolve();
  assert.ok(store.currentAsk(), 'asked, because A has background agents');
  store.setState({ selectedTaskId: 'B' }); // Alt+digit, Ctrl+N or an incoming event
  await answer(true);
  assert.equal(await stopping, true);
  assert.deepEqual(cancelled, ['A']);
});

test('the Stop command on the selected task asks about that task and stops that one, even if the selection moves', async () => {
  setup();
  const stopping = store.cancelSelected();
  await Promise.resolve();
  store.setState({ selectedTaskId: 'B' });
  await answer(true);
  await stopping;
  assert.deepEqual(cancelled, ['A']);
});

test('the run starts again in the same task while the question is open (the queue sent the next message): the new run is not stopped', async () => {
  setup();
  let paused = 0;
  const stopping = store.stopAskedRun('A', () => { paused++; });
  await Promise.resolve();
  store.setState({ tasks: [task('A', 'running'), task('B', 'running')], progress: { A: run('t2'), B: run('t1') } });
  await answer(true);
  assert.equal(await stopping, false);
  assert.deepEqual(cancelled, []);
  assert.equal(paused, 0, 'nothing was stopped, so the queue is not paused either');
});

test('the run ended while the question was open: nothing is cancelled', async () => {
  setup();
  let paused = 0;
  const stopping = store.stopAskedRun('A', () => { paused++; });
  await Promise.resolve();
  store.setState({ tasks: [task('A', 'done'), task('B', 'running')], progress: { B: run('t1') } });
  await answer(true);
  assert.equal(await stopping, false);
  assert.deepEqual(cancelled, []);
  assert.equal(paused, 0);
});

test('No keeps the run going; a run with no background agents is stopped without a question; the queue is paused only when the stop goes ahead', async () => {
  setup();
  let paused = 0;
  const kept = store.stopAskedRun('A', () => { paused++; });
  await Promise.resolve();
  await answer(false);
  assert.equal(await kept, false);
  assert.deepEqual(cancelled, []);
  assert.equal(paused, 0);

  store.setState({ progress: { A: run('t1', 0), B: run('t1') } });
  assert.equal(await store.stopAskedRun('A', () => { paused++; }), true);
  assert.equal(store.currentAsk(), null, 'no question for a run with no background agents');
  assert.deepEqual(cancelled, ['A']);
  assert.equal(paused, 1);
});

test('a task that already shows as ended when Stop is pressed is still sent the cancel, as before (the core has the last word)', async () => {
  setup();
  store.setState({ tasks: [task('A', 'done'), task('B', 'running')], progress: { A: run('t1', 0) } });
  assert.equal(await store.stopAskedRun('A'), true);
  assert.deepEqual(cancelled, ['A']);
});

test('the composer, the command palette and the task menu stop the task they asked about', () => {
  const read = (f: string): string => readFileSync(join(process.cwd(), f), 'utf8');
  assert.doesNotMatch(read('ui/src/components/Composer.tsx'), /cancelSelected\(true\)/, 'the composer no longer reads the selection after the question');
  assert.match(read('ui/src/components/Composer.tsx'), /stopAskedRun\(taskId, \(\) => pauseQueue\(qkey\)\)/);
  assert.match(read('ui/src/store.ts'), /export async function stopTask\(id: string\) \{\s*await stopAskedRun\(id\);/);
});
