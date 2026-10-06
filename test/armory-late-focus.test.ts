/**
 * Focus after a slow action (Remove): it is moved only while it is still wanted. A late move must never hand the owner's next
 * keypress to a button, and must never pull focus away from where the owner went.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { tempDir } from './tmp-cleanup.js';

type Listener = (e: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
const body = { id: 'body' };
const doc = { activeElement: body as unknown, body };
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (t: string, l: Listener) => { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(l); },
  removeEventListener: (t: string, l: Listener) => { listeners.get(t)?.delete(l); },
};
(globalThis as unknown as { document: unknown }).document = doc;
const press = (): void => listeners.get('keydown')?.forEach((l) => l({ key: 'x' }));

const dir = tempDir('legion-late-focus-');
const out = await build({ entryPoints: [join(process.cwd(), 'ui/src/armory/lateFocus.ts')], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
writeFileSync(join(dir, 'lateFocus.mjs'), out.outputFiles[0]!.text);
const { focusIntent, focusWhenReady } = await import(pathToFileURL(join(dir, 'lateFocus.mjs')).href) as {
  focusIntent(scope: unknown): { still(): boolean; done(): void };
  focusWhenReady(o: { find: () => unknown; fallback?: () => unknown; wanted?: () => boolean; tries?: number; schedule?: (run: () => void) => void; done?: (how: string) => void }): () => void;
};

const inside = { id: 'menu-button' };
const outside = { id: 'search-box' };
const scope = { contains: (x: unknown) => x === inside };

test('focus still on the row, or fallen to the page because the row went, is still wanted', () => {
  const f = focusIntent(scope);
  doc.activeElement = inside;
  assert.equal(f.still(), true);
  doc.activeElement = body;
  assert.equal(f.still(), true, 'the row was removed, so focus fell to the page');
  f.done();
});

test('focus that went somewhere else is not taken back', () => {
  const f = focusIntent(scope);
  doc.activeElement = outside;
  assert.equal(f.still(), false);
  f.done();
});

test('a key pressed meanwhile cancels the move: the next keypress is not captured by a button', () => {
  const f = focusIntent(scope);
  doc.activeElement = inside;
  press();
  assert.equal(f.still(), false);
  f.done();
});

test('done() stops listening, so no listener is left behind', () => {
  const before = listeners.get('keydown')?.size ?? 0;
  const f = focusIntent(scope);
  assert.equal(listeners.get('keydown')!.size, before + 1);
  f.done();
  assert.equal(listeners.get('keydown')!.size, before);
  doc.activeElement = inside;
  press();
  assert.equal(f.still(), true, 'a finished intent no longer hears keys');
});

test('no scope (focus was on the page already) still works', () => {
  const f = focusIntent(null);
  doc.activeElement = body;
  assert.equal(f.still(), true);
  doc.activeElement = inside;
  assert.equal(f.still(), false);
  f.done();
});

/** A frame at a time, by hand. */
const frames = (): { schedule: (run: () => void) => void; tick: () => void; pending: () => number } => {
  const q: (() => void)[] = [];
  return { schedule: (r) => { q.push(r); }, tick: () => { q.shift()?.(); }, pending: () => q.length };
};
const el = (id: string, canFocus: () => boolean) => ({ id, focus() { if (canFocus()) doc.activeElement = this; } });

test('focusWhenReady: an element that is not there yet gets focus on the frame it appears, and the loop stops', () => {
  doc.activeElement = body;
  let there: unknown = null;
  const row = el('row', () => true);
  const f = frames();
  const how: string[] = [];
  focusWhenReady({ find: () => there, fallback: () => el('heading', () => true), schedule: f.schedule, done: (h) => how.push(h) });
  assert.equal(doc.activeElement, body, 'nothing to focus yet');
  f.tick(); f.tick();
  there = row;
  f.tick();
  assert.equal(doc.activeElement, row);
  assert.deepEqual(how, ['element']);
  assert.equal(f.pending(), 0, 'no more tries once it holds focus');
});

test('focusWhenReady: a focus() that does nothing (a hidden row) is not success: it tries again until it takes', () => {
  doc.activeElement = body;
  let visible = false;
  const row = el('row', () => visible);
  const f = frames();
  const how: string[] = [];
  focusWhenReady({ find: () => row, schedule: f.schedule, done: (h) => how.push(h) });
  f.tick(); f.tick();
  assert.equal(doc.activeElement, body);
  assert.deepEqual(how, []);
  visible = true;
  f.tick();
  assert.equal(doc.activeElement, row);
  assert.deepEqual(how, ['element']);
});

test('focusWhenReady: an element that never comes sends focus to the fallback, never leaves it on the page', () => {
  doc.activeElement = body;
  const heading = el('heading', () => true);
  const f = frames();
  const how: string[] = [];
  focusWhenReady({ find: () => null, fallback: () => heading, tries: 3, schedule: f.schedule, done: (h) => how.push(h) });
  while (f.pending()) f.tick();
  assert.equal(doc.activeElement, heading);
  assert.deepEqual(how, ['fallback']);
});

test('focusWhenReady: when the owner has gone elsewhere (wanted() is false) focus is left alone, and cancel stops it', () => {
  doc.activeElement = outside;
  const row = el('row', () => true);
  const f = frames();
  const how: string[] = [];
  focusWhenReady({ find: () => row, wanted: () => false, fallback: () => el('h', () => true), schedule: f.schedule, done: (h) => how.push(h) });
  assert.equal(doc.activeElement, outside);
  assert.deepEqual(how, ['gone']);
  doc.activeElement = body;
  const f2 = frames();
  const cancel = focusWhenReady({ find: () => null, tries: 5, schedule: f2.schedule });
  cancel();
  f2.tick();
  assert.equal(f2.pending(), 0, 'a cancelled search does not schedule again');
});
