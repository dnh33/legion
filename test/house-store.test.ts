/**
 * Settings -> Doctrine: the store's behaviour against a fake core (no network, no DOM beyond a stub `window`).
 *
 * What these pin down, from the second review: a dead core must say so (not spin forever), a failed refresh keeps the
 * list and says it may be stale, an old error must not outlive a later success, and every bulk change runs at once
 * and can be undone to exactly the previous switches.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { tempDir } from './tmp-cleanup.js';

// api.ts reads `window` when it loads, so the stub goes in before the import.
(globalThis as unknown as { window: unknown }).window = { location: { search: '' } };

interface F { path: string; bytes: number; trust: 'shipped' | 'adopted' | 'untrusted'; category: string; title: string; on: boolean; locked: boolean; group?: string | null; skill?: string | null; description?: string }
const skill = (g: string, n: string, on = false): F[] => {
  const p = `skills/${g}/${n}/SKILL.md`;
  return [
    { path: p, bytes: 10, trust: 'shipped', category: 'skills', title: n, on, locked: false, group: g, skill: p, description: 'd' },
    { path: `skills/${g}/${n}/references/a.md`, bytes: 10, trust: 'shipped', category: 'skills', title: 'a', on, locked: false, group: g, skill: p },
  ];
};
const world = {
  files: [] as F[],
  down: false,
  failSwitch: new Set<string>(),
  failTrust: false,
  calls: [] as string[],
  files404: false,
  licenceText: {} as Record<string, string>,
};
const reset = (): void => {
  world.files = [
    { path: 'AGENTS.md', bytes: 1, trust: 'shipped', category: 'core', title: 'Agents', on: true, locked: true },
    { path: 'docs/TESTING.md', bytes: 1, trust: 'shipped', category: 'built', title: 'Testing', on: false, locked: false },
    { path: 'docs/ARCHITECTURE.md', bytes: 1, trust: 'shipped', category: 'built', title: 'Architecture', on: false, locked: false },
    { path: 'mine.md', bytes: 1, trust: 'untrusted', category: 'yours', title: 'Mine', on: true, locked: false },
    ...skill('verify-debug', 'a', true), ...skill('verify-debug', 'b', false), ...skill('review', 'c', true),
  ];
  world.down = false; world.failSwitch = new Set(); world.failTrust = false; world.calls = []; world.files404 = false; world.licenceText = {};
};
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }): Promise<Response> => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {};
  world.calls.push(`${init?.method ?? 'GET'} ${path}`);
  if (world.down) throw new TypeError('fetch failed');
  if (path.startsWith('/api/house/file?path=')) {
    const p = decodeURIComponent(path.split('=')[1]!);
    return p in world.licenceText ? json(200, { path: p, text: world.licenceText[p], clipped: false, trust: 'shipped' }) : json(404, { error: 'No such file in the Doctrine folder.' });
  }
  if (path === '/api/house') return json(200, { root: '/x', files: world.files, missing: [], synced: null });
  if (path === '/api/house/switch') {
    const p = String(body.path);
    if (world.failSwitch.has(p)) return json(500, { error: 'disk is full' });
    for (const f of world.files) if (f.path === p || f.skill === p) f.on = body.on === true;
    return json(200, { path: p, on: body.on === true });
  }
  if (path === '/api/house/switch/reset') {
    for (const f of world.files) {
      if ('group' in body ? f.group === body.group : f.category === body.category) {
        if (f.category === 'skills') f.on = false; else f.on = true;
      }
    }
    return json(200, { reset: 1 });
  }
  if (path === '/api/house/adopt' || path === '/api/house/unadopt') return world.failTrust ? json(500, { error: 'cannot write the approval' }) : json(200, {});
  return json(404, { error: 'no route' });
};

// Typed by hand: importing the UI file's types would make the Node build compile bundler-style imports it cannot resolve.
interface Store {
  getHouse(): { status: { files: F[] } | null; loaded: boolean; loadError: string | null; loading: boolean; switchErrors: Record<string, string>; trustErrors: Record<string, string>; undo: { message: string; total: number; error?: string; items: { path: string; on: boolean }[] } | null; notice: string; licenceNames: Record<string, string> };
  loadHouse(opts?: { minBusyMs?: number }): Promise<void>;
  retryLoad(): Promise<boolean>;
  holdUndo(who: string): void;
  releaseUndo(who: string): void;
  loadLicenceNames(paths: string[]): Promise<void>;
  RETRY_MIN_MS: number;
  setHouseSwitch(path: string, on: boolean): Promise<void>;
  setHouseTrust(path: string, adopt: boolean): Promise<void>;
  resetHouse(scope: { category: string } | { group: string }): Promise<void>;
  undoBulk(): Promise<void>;
  clearUndo(): void;
  UNDO_MS: number;
}
// The store is UI code (bundler-style imports), so it is bundled with esbuild the way the app bundles it, then imported.
const out = await build({
  entryPoints: [join(process.cwd(), 'ui/src/house/houseStore.ts')], bundle: true, format: 'esm', platform: 'node', write: false,
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
});
const dir = tempDir('legion-house-store-');
writeFileSync(join(dir, 'store.mjs'), out.outputFiles[0]!.text);
const store = await import(pathToFileURL(join(dir, 'store.mjs')).href) as Store;
const { getHouse } = store;
const onSkills = (): string[] => getHouse().status!.files.filter((f) => /SKILL\.md$/.test(f.path) && f.on).map((f) => f.path);

test('a dead core is an error with a reason, not a spinner: nothing loaded, loadError set', async () => {
  reset(); world.down = true;
  await store.loadHouse();
  assert.equal(getHouse().loaded, false);
  assert.equal(getHouse().loadError, 'Cannot reach Legion core');
  assert.equal(getHouse().loading, false, 'the Try again button must be usable');
});

test('a failed refresh keeps the list and records why; the next good read clears it', async () => {
  reset(); world.down = false;
  await store.loadHouse();
  assert.equal(getHouse().loaded, true);
  assert.equal(getHouse().loadError, null);
  const before = getHouse().status!.files.length;
  world.down = true;
  await store.loadHouse();
  assert.equal(getHouse().status!.files.length, before, 'the old list is still there');
  assert.equal(getHouse().loadError, 'Cannot reach Legion core');
  world.down = false;
  await store.loadHouse();
  assert.equal(getHouse().loadError, null);
});

test('errors do not outlive later successes: a good switch, a good reset and a good read each clear theirs', async () => {
  reset(); await store.loadHouse();
  const p = 'docs/TESTING.md';
  world.failSwitch.add(p);
  await store.setHouseSwitch(p, true);
  assert.equal(getHouse().switchErrors[p], 'disk is full');
  assert.equal(getHouse().status!.files.find((f) => f.path === p)!.on, false, 'rolled back');
  world.failSwitch.clear();
  await store.setHouseSwitch(p, true);
  assert.equal(getHouse().switchErrors[p], undefined, 'a successful switch clears the row error');

  world.failSwitch.add('docs/ARCHITECTURE.md');
  await store.setHouseSwitch('docs/ARCHITECTURE.md', true);
  assert.ok(getHouse().switchErrors['docs/ARCHITECTURE.md']);
  world.failSwitch.clear();
  await store.resetHouse({ category: 'built' });
  assert.equal(getHouse().switchErrors['docs/ARCHITECTURE.md'], undefined, 'a reset that covers the file clears its error');

  world.failSwitch.add('mine.md');
  await store.setHouseSwitch('mine.md', false);
  assert.ok(getHouse().switchErrors['mine.md']);
  await store.loadHouse();
  assert.deepEqual(getHouse().switchErrors, {}, 'a good read clears every stale row error');
});

test('approve and withdraw errors belong to their row, not the whole screen', async () => {
  reset(); await store.loadHouse();
  world.failTrust = true;
  await store.setHouseTrust('mine.md', true);
  assert.equal(getHouse().trustErrors['mine.md'], 'cannot write the approval');
  assert.equal(getHouse().loadError, null, 'the screen-wide error stays empty');
  world.failTrust = false;
  await store.setHouseTrust('mine.md', true);
  assert.equal(getHouse().trustErrors['mine.md'], undefined);
});

test('turn all off runs at once, says what it did, and Undo restores exactly the skills that were on', async () => {
  reset(); await store.loadHouse();
  store.clearUndo();
  const wasOn = onSkills().sort();
  assert.deepEqual(wasOn, ['skills/review/c/SKILL.md', 'skills/verify-debug/a/SKILL.md']);
  await store.resetHouse({ category: 'skills' });
  assert.deepEqual(onSkills(), [], 'it ran without asking');
  assert.equal(getHouse().undo?.message, 'Turned off 2 drills.');
  assert.match(getHouse().notice, /^Turned off 2 drills\./, 'and announced it');
  await store.undoBulk();
  assert.deepEqual(onSkills().sort(), wasOn, 'exactly the previous on-set, not every skill');
  assert.equal(getHouse().undo, null);
  assert.match(getHouse().notice, /^Turned 2 drills back on\./);
  assert.equal(world.files.find((f) => f.path === 'skills/verify-debug/b/SKILL.md')!.on, false, 'a skill that was off stays off');
});

test('a sub-group and a plain group use the same pattern, with their own words', async () => {
  reset(); await store.loadHouse();
  await store.resetHouse({ group: 'verify-debug' });
  assert.equal(getHouse().undo?.message, 'Turned off 1 drill.');
  assert.deepEqual(onSkills(), ['skills/review/c/SKILL.md'], 'only that group');
  await store.resetHouse({ category: 'built' });
  assert.equal(getHouse().undo?.message, 'Turned 2 files back on.');
  assert.deepEqual(getHouse().undo?.items.map((i) => i.on), [false, false], 'Undo knows they were off');
  await store.undoBulk();
  assert.deepEqual(getHouse().status!.files.filter((f) => f.category === 'built').map((f) => f.on), [false, false]);
});

test('nothing to change means no request and no Undo offer', async () => {
  reset(); await store.loadHouse();
  store.clearUndo();
  world.calls.length = 0;
  await store.resetHouse({ group: 'nope' });
  await store.resetHouse({ category: 'core' });
  assert.deepEqual(world.calls, []);
  assert.equal(getHouse().undo, null);
});

test('the Undo offer goes away at the next change and after about ten seconds', async () => {
  reset(); await store.loadHouse();
  await store.resetHouse({ category: 'skills' });
  assert.ok(getHouse().undo);
  await store.setHouseSwitch('mine.md', false);
  assert.equal(getHouse().undo, null, 'the next change drops it');

  reset(); await store.loadHouse();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await store.resetHouse({ category: 'skills' });
    assert.ok(getHouse().undo);
    mock.timers.tick(store.UNDO_MS - 1);
    assert.ok(getHouse().undo, 'still there just before the time is up');
    mock.timers.tick(1);
    assert.equal(getHouse().undo, null);
    assert.equal(store.UNDO_MS, 10_000);
  } finally { mock.timers.reset(); }
});

test('a failed Undo keeps the offer, names the reason, and a second try finishes the job', async () => {
  reset(); await store.loadHouse();
  store.clearUndo();
  await store.resetHouse({ category: 'skills' });
  world.failSwitch.add('skills/review/c/SKILL.md');
  await store.undoBulk();
  const u = getHouse().undo;
  assert.ok(u, 'the offer is still there: dropping it would leave no way back');
  assert.equal(u.error, 'Undo failed: disk is full. Try again.');
  assert.deepEqual(u.items.map((i) => i.path), ['skills/review/c/SKILL.md'], 'only what is still to put back');
  assert.equal(u.total, 2);
  assert.equal(getHouse().notice.trim(), 'Undo failed: disk is full. Try again.', 'announced too');
  assert.ok(getHouse().switchErrors['skills/review/c/SKILL.md'], 'the row still says which switch failed');
  assert.deepEqual(onSkills(), ['skills/verify-debug/a/SKILL.md'], 'the one that worked is back');

  world.failSwitch.clear();
  await store.undoBulk();
  assert.equal(getHouse().undo, null, 'gone only when it fully worked');
  assert.deepEqual(onSkills().sort(), ['skills/review/c/SKILL.md', 'skills/verify-debug/a/SKILL.md']);
  assert.match(getHouse().notice, /^Turned 2 drills back on\./, 'counted over the whole change, not the retry');
});

test('the Undo clock waits while the pointer or focus is on the offer, and says so when it runs out', async () => {
  reset(); await store.loadHouse();
  store.clearUndo();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await store.resetHouse({ category: 'skills' });
    store.holdUndo('focus');
    store.holdUndo('hover');
    mock.timers.tick(store.UNDO_MS * 5);
    assert.ok(getHouse().undo, 'held: still there after five times the time');
    store.releaseUndo('hover');
    mock.timers.tick(store.UNDO_MS * 5);
    assert.ok(getHouse().undo, 'one holder left: still held');
    store.releaseUndo('focus');
    mock.timers.tick(store.UNDO_MS - 1);
    assert.ok(getHouse().undo, 'the full time starts again when the last one lets go');
    mock.timers.tick(1);
    assert.equal(getHouse().undo, null);
    assert.equal(getHouse().notice.trim(), 'Undo is no longer available.', 'a screen reader hears that it went');
  } finally { mock.timers.reset(); }
  // using it, or making the next change, is not "no longer available": nothing is announced
  reset(); await store.loadHouse();
  await store.resetHouse({ category: 'skills' });
  const before = getHouse().notice;
  await store.setHouseSwitch('mine.md', false);
  assert.equal(getHouse().notice, before);
  store.clearUndo();
});

test('a holder that vanished with the offer does not freeze the next one', async () => {
  reset(); await store.loadHouse();
  store.clearUndo();
  await store.resetHouse({ category: 'skills' });
  store.holdUndo('focus');
  store.clearUndo();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await store.resetHouse({ category: 'built' });
    assert.ok(getHouse().undo);
    mock.timers.tick(store.UNDO_MS);
    assert.equal(getHouse().undo, null, 'the old hold is gone with the old offer');
  } finally { mock.timers.reset(); }
});

test('Try again keeps "Trying" up for at least a moment even when the core answers at once; the plain load does not wait', async () => {
  reset(); world.down = true;
  const t0 = Date.now();
  await store.loadHouse();
  assert.ok(Date.now() - t0 < store.RETRY_MIN_MS / 2, 'the load on entry is not slowed');
  const t1 = Date.now();
  const ok = await store.retryLoad();
  const took = Date.now() - t1;
  assert.equal(ok, false);
  assert.ok(took >= store.RETRY_MIN_MS - 25, `a failed retry shows its busy state for the minimum (${took} ms)`);
  assert.equal(getHouse().loading, false);
  assert.equal(getHouse().notice.trim(), 'Still could not read your doctrine files.', 'and says it did not work');
  world.down = false;
  assert.equal(await store.retryLoad(), true);
  assert.equal(getHouse().notice.trim(), 'Doctrine files reloaded.');
  assert.equal(getHouse().loadError, null);
});

test('licence names are read once from the licence text; an unreadable file is skipped, not retried in a loop', async () => {
  reset(); await store.loadHouse();
  world.licenceText = { 'skills/review/c/LICENSE.md': 'MIT License\n\nCopyright (c) x', 'skills/review/d/LICENSE.md': 'Apache License\nVersion 2.0' };
  world.calls.length = 0;
  await store.loadLicenceNames(['skills/review/c/LICENSE.md', 'skills/review/d/LICENSE.md', 'skills/review/e/LICENSE.md']);
  assert.deepEqual(getHouse().licenceNames, { 'skills/review/c/LICENSE.md': 'MIT', 'skills/review/d/LICENSE.md': 'Apache-2.0' });
  assert.equal(world.calls.length, 3);
  await store.loadLicenceNames(['skills/review/c/LICENSE.md', 'skills/review/e/LICENSE.md']);
  assert.equal(world.calls.length, 3, 'asked once per file, the failed one included');
});
