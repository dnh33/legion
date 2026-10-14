/** The app's store takes the new queue, parked and caps fields from the snapshot and keeps the queue current from events (no new screens). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { tempDir } from './tmp-cleanup.js';
import type { StateSnapshot, QueueSnapshot } from '../src/shared/types.js';

// api.ts reads `window` when it loads, so the stub goes in before the import.
(globalThis as unknown as { window: unknown }).window = { location: { search: '' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };

const dir = tempDir('legion-away-ui-');
const entry = join(dir, 'entry.ts');
writeFileSync(entry, `export * from '${join(process.cwd(), 'ui/src/store.ts').replace(/\\/g, '/')}';\n`);
const out = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
writeFileSync(join(dir, 'store.mjs'), out.outputFiles[0]!.text);
const store = await import(pathToFileURL(join(dir, 'store.mjs')).href) as { handleEvent(e: unknown): void; getState(): { queue: QueueSnapshot | null; parked: unknown[]; caps: Record<string, unknown> }; refresh(): Promise<void> };

const snap = (extra: Partial<StateSnapshot>): StateSnapshot => ({ version: 't', agents: [], tasks: [], vms: [], approvals: [], boatConfigured: false, auth: 'claude-login', ...extra } as StateSnapshot);
const serve = (s: StateSnapshot): void => { (globalThis as unknown as { fetch: unknown }).fetch = async () => new Response(JSON.stringify(s), { status: 200, headers: { 'Content-Type': 'application/json' } }); };

test('queue.updated replaces the queue in the store', () => {
  assert.equal(store.getState().queue, null);
  const q: QueueSnapshot = { cap: 4, running: 4, items: [{ taskId: 't1', reason: 'slot', position: 1 }] };
  store.handleEvent({ type: 'queue.updated', queue: q });
  assert.deepEqual(store.getState().queue, q);
  store.handleEvent({ type: 'queue.updated', queue: { cap: 4, running: 3, items: [] } });
  assert.deepEqual(store.getState().queue, { cap: 4, running: 3, items: [] });
});

test('the snapshot brings queue, parked asks and caps', async () => {
  const q: QueueSnapshot = { cap: 2, running: 2, items: [{ taskId: 'x', reason: 'paused', position: 1 }] };
  serve(snap({ queue: q, parked: [], caps: { keepAwake: true } }));
  await store.refresh();
  assert.deepEqual(store.getState().queue, q);
  assert.deepEqual(store.getState().parked, []);
  assert.deepEqual(store.getState().caps, { keepAwake: true });
});

test('a core that sends none of them leaves the store empty, not broken', async () => {
  serve(snap({}));
  await store.refresh();
  assert.equal(store.getState().queue, null);
  assert.deepEqual(store.getState().parked, []);
  assert.deepEqual(store.getState().caps, {});
});

test('events the app does not use yet are ignored', () => {
  assert.doesNotThrow(() => {
    store.handleEvent({ type: 'attention.updated', attention: { total: 1, working: 0, byProject: {} } });
    store.handleEvent({ type: 'away.updated' });
    store.handleEvent({ type: 'budget.reached', projectId: 'p', period: 'week' });
  });
});
