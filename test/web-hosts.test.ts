import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWebLastUsed } from '../src/core/web-hosts.js';
import { createGatesCore, createGatesModule } from '../src/core/gates-settings/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { AUTH, asClient, makeFakes, start } from './helpers-c.js';
import { DOCS_HOSTS } from '../src/shared/docs-hosts.js';

const folder = () => join(cleanupTemp('legion-webhosts-'), 'gates');

test('touch and approved round-trip through a new instance', () => {
  const dir = folder();
  const a = createWebLastUsed(dir);
  assert.deepEqual(a.get(), {});
  a.approved('docs.example.com', new Date('2026-10-01T10:00:00Z'));
  a.touch('docs.example.com', new Date('2026-10-05T10:00:00Z'));
  a.touch('other.com', new Date('2026-10-06T10:00:00Z'));
  const b = createWebLastUsed(dir);
  assert.deepEqual(b.get(), {
    'docs.example.com': { approvedAt: '2026-10-01T10:00:00.000Z', lastUsed: '2026-10-05T10:00:00.000Z' },
    'other.com': { lastUsed: '2026-10-06T10:00:00.000Z' },
  });
  assert.ok(existsSync(join(dir, 'web-last-used.json')));
  assert.equal(existsSync(join(dir, 'web-last-used.json.tmp')), false, 'the temp file is renamed away');
});

test('a corrupt or wrongly shaped file reads as {} and the next write replaces it', () => {
  const dir = folder(); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'web-last-used.json');
  for (const bad of ['{not json', '[]', '"x"', 'null']) {
    writeFileSync(file, bad);
    assert.deepEqual(createWebLastUsed(dir).get(), {}, bad);
  }
  writeFileSync(file, '{bad');
  const w = createWebLastUsed(dir); w.touch('a.com', new Date('2026-10-01T00:00:00Z'));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 1, hosts: { 'a.com': { lastUsed: '2026-10-01T00:00:00.000Z' } } });
});

test('entries of the wrong shape are skipped, the rest is kept; hosts are stored in canonical form', () => {
  const dir = folder(); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'web-last-used.json'), JSON.stringify({ v: 1, hosts: { 'a.com': { lastUsed: '2026-10-01T00:00:00.000Z' }, 'b.com': 5, 'c.com': { lastUsed: 7 } } }));
  const w = createWebLastUsed(dir);
  assert.deepEqual(w.get(), { 'a.com': { lastUsed: '2026-10-01T00:00:00.000Z' } });
  w.touch('Docs.Example.COM.', new Date('2026-10-02T00:00:00Z'));
  assert.ok(w.get()['docs.example.com']);
});

test('an entry is never pruned', () => {
  const dir = folder(); const w = createWebLastUsed(dir);
  for (let i = 0; i < 300; i++) w.touch(`h${i}.example.com`, new Date(2026, 0, 1));
  assert.equal(Object.keys(createWebLastUsed(dir).get()).length, 300);
});

const NATIVE = 'native-secret';
const KEYRING = { get: () => Buffer.alloc(32, 9) };
const J = { 'Content-Type': 'application/json' };
async function boot() {
  const root = cleanupTemp('legion-webhosts-routes-');
  const data = join(root, 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const f = makeFakes({ holdRuns: true });
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false };
  const core = createGatesCore({ dataDir: data, projects, keyring: KEYRING });
  const mod = createGatesModule(deps, { projects, core, nativeSecret: NATIVE });
  (f.ctx as { modules?: unknown }).modules = [mod];
  const s = await start(f.ctx);
  return { core, base: s.base, get: (h: Record<string, string> = AUTH) => fetch(s.base + '/api/gates/web-hosts', { headers: h }), close: async () => { await mod.dispose?.(); await s.close(); } };
}

test('GET /api/gates/web-hosts returns the approved sites with their dates and the built-in list; admin only', async () => {
  const r = await boot();
  try {
    const empty = await r.get();
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { allowed: [], builtIn: [...DOCS_HOSTS] });
    r.core.store.patchApp({ allowedHosts: ['docs.example.com', 'b.example.com'] });
    r.core.webLastUsed.approved('docs.example.com', new Date('2026-10-01T00:00:00Z'));
    r.core.webLastUsed.touch('docs.example.com', new Date('2026-10-02T00:00:00Z'));
    const j = (await (await r.get()).json()) as { allowed: Array<{ host: string; lastUsed?: string; approvedAt?: string }>; builtIn: string[] };
    assert.deepEqual(j.allowed, [{ host: 'docs.example.com', approvedAt: '2026-10-01T00:00:00.000Z', lastUsed: '2026-10-02T00:00:00.000Z' }, { host: 'b.example.com' }]);
    assert.equal(j.builtIn.length, DOCS_HOSTS.length);
    assert.equal((await r.get({})).status, 401);
    assert.equal((await r.get(asClient)).status, 403);
  } finally { await r.close(); }
});

test('hosts added to allowedHosts through the app route are stamped approved; ones already there are not re-stamped', async () => {
  const r = await boot();
  try {
    const send = async (hosts: string[]) => {
      const pv = await fetch(r.base + '/api/gates/preview', { method: 'POST', headers: { ...AUTH, ...J }, body: JSON.stringify({ name: 'app', patch: { allowedHosts: hosts } }) });
      const digest = ((await pv.json()) as { digest: string }).digest;
      return fetch(r.base + '/api/gates/app', { method: 'PATCH', headers: { ...AUTH, ...J, 'X-Legion-Native': NATIVE, 'x-legion-gates-digest': digest }, body: JSON.stringify({ allowedHosts: hosts }) });
    };
    assert.equal((await send(['a.example.com'])).status, 200);
    const first = r.core.webLastUsed.get()['a.example.com']?.approvedAt;
    assert.ok(first);
    await new Promise((res) => setTimeout(res, 15));
    assert.equal((await send(['a.example.com', 'b.example.com'])).status, 200);
    const got = r.core.webLastUsed.get();
    assert.equal(got['a.example.com']?.approvedAt, first, 'unchanged');
    assert.ok(got['b.example.com']?.approvedAt);
  } finally { await r.close(); }
});
