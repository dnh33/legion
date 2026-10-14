/** A hold outlives its row (another tab, view or project) and stays visible: the app-level chip lists it, Undo cancels it, the send happens once. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { tempDir } from './tmp-cleanup.js';

const calls: string[] = [];
const g = globalThis as unknown as Record<string, unknown>;
g.window = { location: { search: '' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, setInterval: (f: () => void, n: number) => setInterval(f, n), clearInterval: (i: number) => clearInterval(i), setTimeout: (f: () => void, n: number) => setTimeout(f, n), clearTimeout: (i: number) => clearTimeout(i) };
g.document = { hidden: false };
g.fetch = async (url: string, init?: { method?: string; body?: string }) => { calls.push(`${init?.method ?? 'GET'} ${String(url).replace(/^https?:\/\/[^/]+/, '')} ${init?.body ?? ''}`.trim()); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };

const dir = tempDir('legion-holdchip-');
const entry = join(dir, 'entry.ts');
writeFileSync(entry, `export * from '${join(process.cwd(), 'ui/src/projects/page/answerStore.ts').replace(/\\/g, '/')}';\n`);
const out = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
writeFileSync(join(dir, 'store.mjs'), out.outputFiles[0]!.text);
const S = await import(pathToFileURL(join(dir, 'store.mjs')).href) as {
  startAnswer(o: unknown): void; undoAnswer(k: string): void; sendNowAnswer(k: string): void; setVisibleRows(keys: string[]): void;
  getOffscreen(): Array<{ key: string; kind: string }>; getAnswers(): ReadonlyMap<string, { kind: string }>; dismissAnswer(k: string): void;
};

const row = (key: string, hold = 300) => ({ key, kind: 'command', ids: [key], agentId: 'forgemaster', agentName: 'Forgemaster', level: 3, certain: true, what: 'wants to run a command', chip: '', quiet: false, wait: '', untrusted: false, at: '', hold, ing: 'Publishing', buttons: [] });
const allow = { act: 'allow', label: 'Allow', aria: 'Allow: Forgemaster', held: true };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const decides = (key: string) => calls.filter((c) => c === `POST /api/approvals/${key} {"allow":true}`).length;

test('the row is on screen: no chip. The row is gone (other tab, view, project): the chip lists the hold', () => {
  S.setVisibleRows(['c1']);
  S.startAnswer({ row: row('c1', 60_000), b: allow, projectId: 'p', height: 0 });
  assert.deepEqual(S.getOffscreen(), [], 'its row is showing');
  S.setVisibleRows([]);
  assert.deepEqual(S.getOffscreen().map((a) => [a.key, a.kind]), [['c1', 'holding']]);
  S.undoAnswer('c1');
  assert.deepEqual(S.getOffscreen(), [], 'undone: nothing left to show');
});

test('leaving the page does not cancel or double the send: it happens once, after the countdown', async () => {
  calls.length = 0;
  S.setVisibleRows(['c2']);
  S.startAnswer({ row: row('c2', 400), b: allow, projectId: 'p', height: 0 });
  S.setVisibleRows([]); // the page was left
  await sleep(250);
  assert.equal(decides('c2'), 0, 'still counting: nothing sent');
  await sleep(700);
  assert.equal(decides('c2'), 1, 'sent exactly once');
  assert.equal(S.getAnswers().get('c2')!.kind, 'sent');
  assert.deepEqual(S.getOffscreen().map((a) => a.kind), ['sent'], 'the chip says what happened until it is dismissed');
  S.dismissAnswer('c2');
  assert.deepEqual(S.getOffscreen(), []);
});

test('Undo from the chip cancels: nothing is ever sent', async () => {
  calls.length = 0;
  S.setVisibleRows([]);
  S.startAnswer({ row: row('c3', 400), b: allow, projectId: 'p', height: 0 });
  await sleep(100);
  S.undoAnswer('c3');
  await sleep(700);
  assert.equal(decides('c3'), 0);
});

test('Send now from the chip sends at once, once', async () => {
  calls.length = 0;
  S.setVisibleRows([]);
  S.startAnswer({ row: row('c4', 60_000), b: allow, projectId: 'p', height: 0 });
  S.sendNowAnswer('c4'); S.sendNowAnswer('c4');
  await sleep(200);
  assert.equal(decides('c4'), 1);
  S.dismissAnswer('c4');
});
