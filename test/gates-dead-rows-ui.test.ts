/** Gates PR 2, dead rows (window half): the digest hold follows the project's digest-hold gate. Off: an Allow is sent at once, with no Undo window. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { armAnnouncement } from '../ui/src/projects/page/askLogic.js';
import { gateOffFor } from '../ui/src/gates/presetsLogic.js';
import type { GatesView } from '../ui/src/gates/presetsLogic.js';
import { tempDir } from './tmp-cleanup.js';

const view = (over: Partial<GatesView> = {}): GatesView => ({ app: { version: 1 }, projects: {}, unreadable: [], changedOutside: [], canSign: true, ...over });

test('gateOffFor reads the project value: preset, override, app default; a view not loaded yet keeps the gate on', () => {
  assert.equal(gateOffFor(null, 'digest-hold', 'p1'), false, 'still loading: the hold stays');
  assert.equal(gateOffFor(view(), 'digest-hold', 'p1'), false, 'Ask: held');
  assert.equal(gateOffFor(view({ projects: { p1: { version: 1, preset: 'bypass' } } }), 'digest-hold', 'p1'), true, 'a Bypass project: off by the preset');
  assert.equal(gateOffFor(view({ app: { version: 1, preset: 'bypass' } }), 'digest-hold', 'p1'), true, 'a project with no settings follows the app default');
  assert.equal(gateOffFor(view({ app: { version: 1, preset: 'bypass' }, projects: { p1: { version: 1, preset: 'ask' } } }), 'digest-hold', 'p1'), false, 'the project preset beats the app preset');
  assert.equal(gateOffFor(view({ projects: { p1: { version: 1, preset: 'ask', overrides: { 'digest-hold': false } } } }), 'digest-hold', 'p1'), true, 'an override');
  assert.equal(gateOffFor(view({ projects: { p2: { version: 1, preset: 'ask', overrides: { 'digest-hold': false } } } }), 'digest-hold', 'p1'), false, 'another project override does not count');
});

const calls: string[] = [];
const g = globalThis as unknown as Record<string, unknown>;
g.window = { location: { search: '' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, setInterval: (f: () => void, n: number) => setInterval(f, n), clearInterval: (i: number) => clearInterval(i), setTimeout: (f: () => void, n: number) => setTimeout(f, n), clearTimeout: (i: number) => clearTimeout(i) };
g.document = { hidden: false };
g.fetch = async (url: string, init?: { method?: string; body?: string }) => { calls.push(`${init?.method ?? 'GET'} ${String(url).replace(/^https?:\/\/[^/]+/, '')} ${init?.body ?? ''}`.trim()); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };

const dir = tempDir('legion-holdoff-');
const entry = join(dir, 'entry.ts');
writeFileSync(entry, `export * from '${join(process.cwd(), 'ui/src/projects/page/answerStore.ts').replace(/\\/g, '/')}';\n`);
const out = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
writeFileSync(join(dir, 'store.mjs'), out.outputFiles[0]!.text);
const S = await import(pathToFileURL(join(dir, 'store.mjs')).href) as {
  startAnswer(o: unknown): void; undoAnswer(k: string): void; sendNowAnswer(k: string): void; setVisibleRows(keys: string[]): void;
  getAnswers(): ReadonlyMap<string, { kind: string }>; dismissAnswer(k: string): void;
};

const row = (key: string) => ({ key, kind: 'command', ids: [key], agentId: 'forgemaster', agentName: 'Forgemaster', level: 3, certain: true, what: 'wants to run a command', chip: '', quiet: false, wait: '', untrusted: false, at: '', hold: 10_000, ing: 'Publishing', buttons: [] });
const allow = { act: 'allow', label: 'Allow', aria: 'Allow: Forgemaster', held: true };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const decides = (key: string) => calls.filter((c) => c === `POST /api/approvals/${key} {"allow":true}`).length;

test('digest-hold on: an Allow is held (nothing sent, the core is asked to wait); Undo sends nothing', async () => {
  calls.length = 0;
  S.setVisibleRows(['h1']);
  S.startAnswer({ row: row('h1'), b: allow, projectId: 'p', height: 0, holdOff: false });
  await sleep(60);
  assert.equal(decides('h1'), 0, 'held');
  assert.equal(S.getAnswers().get('h1')!.kind, 'holding');
  assert.ok(calls.some((c) => c.startsWith('POST /api/approvals/h1/hold')), 'the core is asked to hold its own deny');
  S.undoAnswer('h1');
  await sleep(40);
  assert.equal(decides('h1'), 0);
  S.setVisibleRows([]);
});

test('digest-hold off: the Allow goes out at once, once, with no hold request to the core', async () => {
  calls.length = 0;
  S.setVisibleRows(['h2']);
  S.startAnswer({ row: row('h2'), b: allow, projectId: 'p', height: 0, holdOff: true });
  await sleep(60);
  assert.equal(decides('h2'), 1, 'sent');
  assert.equal(S.getAnswers().get('h2')!.kind, 'sent');
  assert.ok(!calls.some((c) => c.includes('/hold')), 'no wait was asked of the core');
  await sleep(60);
  assert.equal(decides('h2'), 1, 'still once');
  S.dismissAnswer('h2');
  S.setVisibleRows([]);
});

test('every place that starts an answer passes the project digest-hold value', () => {
  for (const f of ['Digest.tsx', 'Sheet.tsx']) {
    const src = readFileSync(`${process.cwd()}/ui/src/projects/page/${f}`, 'utf8');
    const starts = src.match(/startAnswer\(\{[^}]*\}\)/g) ?? [];
    assert.ok(starts.length > 0, `${f} starts answers`);
    for (const s of starts) assert.match(s, /holdOff/, `${f}: ${s}`);
    assert.match(src, /useHoldOff\(/, `${f} reads the gate`);
  }
});

test('the spoken line after the first A on an irreversible ask promises a hold only when there is one', () => {
  assert.match(armAnnouncement(10_000, false), /start a 10 second hold/);
  const off = armAnnouncement(10_000, true);
  assert.doesNotMatch(off, /hold/);
  assert.match(off, /Press A again within 2 seconds to allow/);
  assert.ok(!off.includes(String.fromCharCode(8212)));
});
