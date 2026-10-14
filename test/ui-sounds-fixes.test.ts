/** Sounds follow what really happened: Allow/Deny sounds wait for the send, only real switches click, Play previews are rate limited. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { tempDir } from './tmp-cleanup.js';
import { switchEvent, previewAllowed, PREVIEW_MIN_MS } from '../ui/src/sound/soundLogic.js';

(globalThis as unknown as { window: unknown }).window = { location: { search: '' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, setTimeout, clearTimeout };
const dir = tempDir('legion-sounds-fix-');
const entry = join(dir, 'entry.ts');
writeFileSync(entry, `export * from '${join(process.cwd(), 'ui/src/store.ts').replace(/\\/g, '/')}';\n`);
const out = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
writeFileSync(join(dir, 'store.mjs'), out.outputFiles[0]!.text);
const store = await import(pathToFileURL(join(dir, 'store.mjs')).href) as { decide(id: string, allow: boolean): Promise<void>; tapDecisions(fn: (allow: boolean) => void): () => void };
const setFetch = (f: unknown): void => { (globalThis as unknown as { fetch: unknown }).fetch = f; };

test('chat Allow: no sound while the send is in flight or after it fails', async () => {
  const heard: boolean[] = [];
  const off = store.tapDecisions((a) => heard.push(a));
  setFetch(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
  await store.decide('a1', true);
  assert.deepEqual(heard, []);
  off();
});

test('chat Allow: the sound plays once, after the send succeeded', async () => {
  const heard: boolean[] = [];
  const off = store.tapDecisions((a) => heard.push(a));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  setFetch(async () => { await gate; return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }); });
  const p = store.decide('a2', false);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(heard, [], 'nothing before the POST returns');
  release();
  await p;
  assert.deepEqual(heard, [false]);
  off();
});

test('switch sound: a real on/off flip clicks; a question-opening or silent switch does not', () => {
  assert.deepEqual(switchEvent(true, { trusted: true }), { type: 'switch', on: true });
  assert.deepEqual(switchEvent(false, { trusted: true }), { type: 'switch', on: false });
  assert.equal(switchEvent(true, { trusted: true, expanded: true }), null);
  assert.equal(switchEvent(true, { trusted: true, silent: true }), null);
  assert.equal(switchEvent(true, { trusted: false }), null);
});

test('Play previews: no more than one start per 100 ms', () => {
  assert.equal(PREVIEW_MIN_MS, 100);
  assert.equal(previewAllowed(0, 1000), true);
  assert.equal(previewAllowed(1000, 1050), false);
  assert.equal(previewAllowed(1000, 1100), true);
});
