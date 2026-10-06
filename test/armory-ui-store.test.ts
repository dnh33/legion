/**
 * Settings -> Armory: the UI store's behaviour against a fake core (no network, no DOM beyond a stub `window`), and its Undo for a
 * removed skill against the REAL Armory routes.
 *
 * Named armory-ui-store because test/armory-store.test.ts is the core's store test. What these pin down, from the Doctrine reviews: a
 * dead core says so, a failed change puts the row back and says why on that row, every bulk change runs at once and can be undone to
 * exactly the previous three-state values, a partly failed Undo stays on offer, and nothing here can reach an agent route.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { armoryFilePath } from '../src/core/armory/store.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { tempDir } from './tmp-cleanup.js';
import { armoryRig } from './armory-rig.js';
import type { ArmoryRig } from './armory-rig.js';

// api.ts reads `window` when it loads, so the stub goes in before the import.
(globalThis as unknown as { window: unknown }).window = { location: { search: '' } };

type St = 'on' | 'manual' | 'off';
interface S { id: string; name: string; description: string; source: string; plugin: string | null; state: St; stateIsDefault: boolean; agents: 'all' | string[]; path: string | null; manualOnlyInFrontmatter: boolean; fit?: string; offReason?: string; runsCommandsOnLoad?: boolean }
const mk = (id: string, source: string, over: Partial<S> = {}): S => ({
  id, name: id.includes(':') ? id.split(':')[1]! : id, description: `Does ${id}.`, source, plugin: source === 'claude-plugin' ? id.split(':')[0]! : null,
  state: 'off', stateIsDefault: true, agents: 'all', path: `/x/${id}`, manualOnlyInFrontmatter: false, ...over,
});
const world = {
  skills: [] as S[],
  ccNoticeSeen: false,
  allowSkillShell: false,
  down: false,
  failState: new Set<string>(),
  failNotice: false,
  noShell: false,
  failPromote: false,
  failSave: '',
  failImport: '',
  failBulk: '',
  failRefresh: '',
  failEffAll: false,
  discovery: 'sdk' as 'sdk' | 'disk-fallback',
  discoveryReason: null as string | null,
  discoveredAt: '2026-10-06T10:00:00.000Z',
  dryRun: null as null | Record<string, unknown>,
  failDelete: false,
  failRestore: false,
  slow: 0,
  drillText: '',
  texts: {} as Record<string, string>,
  eff: {} as Record<string, { delay: number; counts: number }>,
  calls: [] as { method: string; path: string; body?: Record<string, unknown> }[],
  real: null as ArmoryRig | null,
  house: [] as unknown[],
  old: false,
};
const reset = (): void => {
  world.skills = [
    mk('legion-armory:mine', 'yours', { state: 'on', path: '/d/mine/SKILL.md' }),
    mk('legion-armory:got', 'imported', { path: '/d/got/SKILL.md' }),
    mk('mine-cc', 'claude-personal'),
    mk('playwright:click', 'claude-plugin'),
    mk('playwright:snap', 'claude-plugin', { state: 'manual' }),
    mk('context7:docs', 'claude-plugin', { state: 'on' }),
    mk('verify', 'claude-builtin', { path: null, fit: 'fit' }),
    mk('update-config', 'claude-builtin', { path: null, fit: 'self', offReason: 'It edits Claude Code settings.' }),
  ];
  world.ccNoticeSeen = false; world.allowSkillShell = false; world.down = false; world.failState = new Set(); world.failNotice = false; world.noShell = false;
  world.failPromote = false; world.failSave = ''; world.failImport = ''; world.failBulk = ''; world.failRefresh = ''; world.discovery = 'sdk'; world.discoveryReason = null; world.discoveredAt = '2026-10-06T10:00:00.000Z'; world.dryRun = null; world.failDelete = false; world.failRestore = false; world.slow = 0; world.drillText = ''; world.texts = {}; world.eff = {}; world.calls = [];
  world.real = null; world.house = []; world.old = false;
};
const NL = String.fromCharCode(10);
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }): Promise<Response> => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : undefined;
  world.calls.push({ method, path, ...(body ? { body } : {}) });
  if (world.down) throw new TypeError('fetch failed');
  if (world.real) {
    try { return json(200, await world.real.call(method, path, body)); } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      return json(status, { error: (e as Error).message });
    }
  }
  const u = new URL(`http://x${path}`);
  const q = (k: string): string => u.searchParams.get(k) ?? '';
  const find = (id: string): S | undefined => world.skills.find((s) => s.id === id);
  const overview = (): Record<string, unknown> => ({
    inherit: true, ccNoticeSeen: world.ccNoticeSeen, pluginRoot: '/p', allowSkillShell: world.allowSkillShell, skills: world.skills.map((s) => ({ ...s })),
    discoveredAt: world.discoveredAt, discovery: world.discovery, discoveryReason: world.discoveryReason, discoveryPlugins: 2,
  });
  switch (`${method} ${u.pathname}`) {
    case 'GET /api/armory':
      if (world.old) return json(404, { error: 'no route' });
      return json(200, overview());
    case 'POST /api/armory/refresh':
      if (world.failRefresh) return json(500, { error: world.failRefresh });
      world.discoveredAt = '2026-10-06T11:00:00.000Z';
      return json(200, overview());
    case 'POST /api/armory/state': {
      const s = find(String(body!.id));
      if (!s) return json(404, { error: 'No skill with that id.' });
      if (world.failState.has(s.id)) return json(500, { error: 'disk is full' });
      if (s.offReason && body!.state !== 'off') return json(400, { error: `${s.id} acts on Claude Code itself, so Legion keeps it off. ${s.offReason}` });
      s.state = body!.state as St; s.stateIsDefault = false;
      return json(200, { ...s });
    }
    case 'POST /api/armory/state-bulk': {
      // the same per-id rules as the single route; a skill in failState is refused, failBulk fails the whole request
      if (world.failBulk) return json(500, { error: world.failBulk });
      const skills: S[] = [];
      const refused: { id: string; reason: string }[] = [];
      for (const id of body!.ids as string[]) {
        const s = find(id);
        if (!s) refused.push({ id, reason: 'No skill with that id.' });
        else if (world.failState.has(id)) refused.push({ id, reason: 'disk is full' });
        else if (s.offReason && body!.state !== 'off') refused.push({ id, reason: `${id} acts on Claude Code itself, so Legion keeps it off. ${s.offReason}` });
        else { s.state = body!.state as St; s.stateIsDefault = false; skills.push({ ...s }); }
      }
      return json(200, { skills, refused });
    }
    case 'POST /api/armory/agents': {
      const s = find(String(body!.id))!;
      if (world.failState.has(`agents:${s.id}`)) return json(500, { error: 'cannot write the list' });
      s.agents = body!.agents as 'all' | string[];
      return json(200, { ...s });
    }
    case 'POST /api/armory/notice-seen':
      if (world.failNotice) return json(500, { error: 'cannot write the notice' });
      world.ccNoticeSeen = body?.seen !== false;
      return json(200, { ccNoticeSeen: world.ccNoticeSeen });
    case 'POST /api/armory/allow-shell':
      if (world.noShell) return json(404, { error: 'no route' });
      world.allowSkillShell = body!.allow === true;
      return json(200, { allowSkillShell: world.allowSkillShell });
    case 'POST /api/armory/skill': {
      if (world.failSave) return json(409, { error: world.failSave });
      if (world.failRestore) return json(500, { error: 'disk is full' });
      const id = `legion-armory:${String(body!.name)}`;
      const had = find(id);
      if (had) return json(200, { ...had, created: false });
      const s = mk(id, 'yours', { state: 'off', path: `/d/${String(body!.name)}/SKILL.md` });
      world.skills.push(s);
      return json(200, { ...s, created: true });
    }
    case 'DELETE /api/armory/skill': {
      const s = find(q('id'));
      if (!s) return json(404, { error: 'No skill with that id.' });
      if (world.slow) await sleep(world.slow);
      if (world.failDelete) return json(500, { error: 'in use' });
      world.skills = world.skills.filter((x) => x !== s);
      return json(200, { ok: true, removed: s.id, source: s.source, text: world.texts[s.id] ?? `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\nBody.\n` });
    }
    case 'POST /api/armory/import': {
      if (body!.dryRun === true) {
        if (world.failImport) return json(500, { error: world.failImport });
        const first = (body!.files as { path: string }[])[0]!.path.split('/')[0]!;
        return json(200, world.dryRun ?? { ok: true, refusal: '', name: first, id: `legion-armory:${first}`, description: 'D.', kept: ['SKILL.md'], dropped: [], stripped: ['allowed-tools'], skillText: `---${NL}name: ${first}${NL}description: D.${NL}---${NL}${NL}Body.${NL}` });
      }
      if (world.failImport) return json(409, { error: world.failImport });
      if (world.failRestore) return json(500, { error: 'disk is full' });
      const files = body!.files as { path: string }[];
      const name = files[0]!.path.split('/')[0]!;
      const s = mk(`legion-armory:${name}`, 'imported', { path: `/d/${name}/SKILL.md` });
      world.skills.push(s);
      return json(200, { id: s.id, name, source: 'imported', state: 'off', kept: ['SKILL.md'], dropped: [], stripped: ['allowed-tools'] });
    }
    case 'GET /api/armory/file': {
      const s = find(q('id'));
      if (!s) return json(404, { error: 'No skill with that id.' });
      if (!s.path) return json(404, { error: `${s.id} is built in to Claude Code, so its text is not on this computer.` });
      if (world.texts[s.id] === 'FAIL') return json(500, { error: 'cannot read' });
      return json(200, { id: s.id, source: s.source, path: s.path, text: world.texts[s.id] ?? '---\nname: x\ndescription: d\n---\n\nBody.', thirdParty: s.source === 'imported' || s.source === 'claude-plugin' });
    }
    case 'GET /api/armory/effective': {
      const a = q('agent');
      const e = world.eff[a] ?? { delay: 0, counts: 3 };
      if (e.delay) await sleep(e.delay);
      return json(200, { agent: a, setting: 'inherit', drills: [], armory: [], claudeCode: [], counts: { drills: 0, armory: 0, claudeCode: e.counts, total: e.counts }, warnAbove: 40, overBudget: e.counts > 40 });
    }
    case 'GET /api/armory/effective-all': {
      if (world.failEffAll) return json(500, { error: 'boom' });
      return json(200, { agents: Object.keys(world.eff).map((a) => ({ agent: a, setting: 'inherit', counts: { drills: 0, armory: 0, claudeCode: world.eff[a]!.counts, total: world.eff[a]!.counts }, warnAbove: 40, overBudget: world.eff[a]!.counts > 40 })) });
    }
    case 'POST /api/house/drill/promote':
      if (world.failPromote) return json(409, { error: 'You already have a drill called mine. Rename one of them.' });
      return json(200, { path: 'skills/yours/mine/SKILL.md', name: 'mine', group: 'yours', trust: 'untrusted', on: false });
    case 'DELETE /api/house/drill': {
      if (world.slow) await sleep(world.slow);
      if (!q('path').startsWith('skills/yours/')) return json(400, { error: 'That drill ships with the app, so it is not removed here.' });
      return json(200, { removed: q('path'), name: q('path').split('/')[2], text: world.drillText });
    }
    case 'POST /api/house/drill':
      if (world.failRestore) return json(500, { error: 'disk is full' });
      if (world.failSave) return json(400, { error: world.failSave });
      return json(200, { path: `skills/yours/${String(body!.name)}/SKILL.md`, name: body!.name, group: 'yours', trust: 'untrusted', on: false });
    case 'GET /api/house':
      return json(200, { root: '/x', files: world.house, missing: [], synced: null });
    default:
      return json(404, { error: 'no route' });
  }
};

interface St2 {
  data: { skills: S[]; ccNoticeSeen: boolean; allowSkillShell?: boolean; discoveredAt?: string | null; discovery?: string; discoveryReason?: string | null } | null; loaded: boolean; loading: boolean; loadError: string | null; absent: boolean;
  refreshing: boolean; refreshError: string | null;
  switching: string[]; rowErrors: Record<string, { op: string; message: string }>; resetting: string | null; resetErrors: Record<string, string>;
  undo: { key: string; message: string; total: number; error?: string; items: { id: string; state: St }[] } | null;
  removed: { id: string; name: string; source: string; state: St; agents: 'all' | string[]; text: string; message: string; error?: string } | null;
  busyIds: string[]; busyOps: Record<string, string>; undone: { key: string; message: string } | null; reveal: string | null; promoted: { id: string; name: string; path: string; from: string } | null; noticeBusy: boolean; noticeError: string | null; shellBusy: boolean; shellError: string | null;
  reading: { id: string; status: string; text: string; thirdParty: boolean; error: string | null } | null; highlight: string | null;
  effective: Record<string, { status: string; data: { counts: { total: number } } | null; error: string | null }>; notice: string; focusRow: string | null; savedOff: string | null;
}
interface Store {
  getArmory(): St2;
  loadArmory(o?: { minBusyMs?: number }): Promise<void>;
  retryLoad(): Promise<boolean>;
  refreshDiscovery(): Promise<boolean>;
  setSkillState(id: string, s: St): Promise<boolean>;
  setSkillAgents(id: string, a: 'all' | string[]): Promise<boolean>;
  bulkSet(key: string, to: 'on' | 'off'): Promise<void>;
  bulkCount(key: string, to: 'on' | 'off'): number;
  undoBulk(): Promise<void>;
  turnAllOn(): Promise<void>;
  reviewImportFiles(f: ({ path: string; text: string } | { path: string; size: number; text: null })[]): Promise<{ ok: boolean; refusal: string; name: string; id: string; kept: string[]; dropped: { path: string; reason: string }[]; stripped: string[]; skillText: string }>;
  dismissNotice(): Promise<boolean>;
  setAllowShell(a: boolean): Promise<void>;
  removeSkill(id: string): Promise<boolean>;
  undoRemove(): Promise<void>;
  promoteSkill(id: string): Promise<boolean>;
  dismissPromoted(): void;
  saveSkill(f: { name: string; description: string; whenToUse: string; body: string }): Promise<{ id: string; created: boolean }>;
  importSkill(f: ({ path: string; text: string } | { path: string; size: number; text: null })[]): Promise<{ id: string; stripped: string[] }>;
  openRead(id: string, title: string): Promise<void>;
  loadEffective(a: string): Promise<void>;
  loadEffectiveAll(ids: string[]): Promise<void>;
  clearFocusRow(): void;
  setAgentContext(a: { id: string; name: string; skills?: 'inherit' | string[] }[]): void;
  consequenceOf(key: string): { over: boolean; message: string };
  clearUndone(): void; showPromotedDrill(): void; revealSkill(id: string): void;
  drillRefsOf(f: { category?: string; skill?: string | null; path: string; group?: string | null; on: boolean; title?: string }[]): { id: string; name: string; on: boolean }[];
  clearUndo(): void; clearRemoved(): void; holdUndo(w: string): void; releaseUndo(w: string): void; holdRemoved(w: string): void; releaseRemoved(w: string): void;
  UNDO_MS: number; RETRY_MIN_MS: number;
  house: {
    loadHouse(o?: { minBusyMs?: number; maxAgeMs?: number }): Promise<void>; markHouseFresh(): void;
    saveDrill(f: { name: string; description: string; whenToUse: string; body: string }, edited: boolean): Promise<string>;
    getHouse(): { justAdded: string | null; notice: string; focusPath: string | null; removingPath: string | null; drillError: string | null; removedDrill: { message: string; error?: string } | null };
    removeDrill(path: string, name: string): Promise<boolean>; undoRemoveDrill(): Promise<void>; dismissRemovedDrill(): void; revealDrill(path: string): void; clearFocusPath(): void;
  };
}
// The stores are UI code (bundler-style imports), so they are bundled with esbuild the way the app bundles them, then imported.
const dir = tempDir('legion-armory-ui-store-');
const entry = join(dir, 'entry.ts');
const rel = (p: string): string => join(process.cwd(), p).replace(/\\/g, '/');
writeFileSync(entry, `export * from '${rel('ui/src/armory/armoryStore.ts')}';\nexport * as house from '${rel('ui/src/house/houseStore.ts')}';\n`);
const out = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
writeFileSync(join(dir, 'store.mjs'), out.outputFiles[0]!.text);
const store = await import(pathToFileURL(join(dir, 'store.mjs')).href) as Store;
const { getArmory } = store;
const skill = (id: string): S => getArmory().data!.skills.find((s) => s.id === id)!;
const states = (): Record<string, St> => Object.fromEntries(getArmory().data!.skills.map((s) => [s.id, s.state]));
const fresh = async (): Promise<void> => {
  reset();
  store.clearUndo(); store.clearRemoved(); store.dismissPromoted();
  await store.loadArmory();
};

test('a dead core is an error with a reason; a 404 means this version has no Armory; a failed refresh keeps the list', async () => {
  reset(); world.down = true;
  await store.loadArmory();
  assert.equal(getArmory().loaded, false);
  assert.equal(getArmory().loadError, 'Cannot reach Legion core');
  assert.equal(getArmory().loading, false, 'the Try again button must be usable');
  world.down = false;
  await store.loadArmory();
  assert.equal(getArmory().loaded, true);
  assert.equal(getArmory().loadError, null);
  const n = getArmory().data!.skills.length;
  world.down = true;
  await store.loadArmory();
  assert.equal(getArmory().data!.skills.length, n, 'the old list is still there');
  assert.equal(getArmory().loadError, 'Cannot reach Legion core');
  world.down = false;
  assert.equal(await store.retryLoad(), true);
  assert.match(getArmory().notice, /^Armory reloaded\./);
  world.old = true;
  await store.loadArmory();
  assert.equal(getArmory().absent, true, 'an older core without the route is said to have no Armory, not shown as an empty list');
  world.old = false;
  await store.loadArmory();
  assert.equal(getArmory().absent, false);
});

test('Try again keeps "Trying" up for at least a moment; the plain load does not wait', async () => {
  reset(); world.down = true;
  const t0 = Date.now();
  await store.loadArmory();
  assert.ok(Date.now() - t0 < store.RETRY_MIN_MS / 2);
  const t1 = Date.now();
  assert.equal(await store.retryLoad(), false);
  assert.ok(Date.now() - t1 >= store.RETRY_MIN_MS - 25);
  assert.match(getArmory().notice, /^Still could not read the Armory\./);
  world.down = false;
});

test('a state change moves the row at once, is announced, and a second click while it saves is queued, not dropped', async () => {
  await fresh();
  const p = store.setSkillState('mine-cc', 'on');
  assert.equal(skill('mine-cc').state, 'on', 'optimistic');
  assert.deepEqual(getArmory().switching, ['mine-cc']);
  assert.equal(await store.setSkillState('mine-cc', 'on'), true, 'asking for the state that is already showing queues nothing new');
  assert.equal(await p, true);
  assert.deepEqual(getArmory().switching, []);
  assert.match(getArmory().notice, /^mine-cc: agents decide\./);
  assert.equal(world.calls.filter((c) => c.path === '/api/armory/state').length, 1);
  await store.setSkillState('mine-cc', 'manual');
  assert.match(getArmory().notice, /^mine-cc: only when you ask\./);
});

test('changes asked for during a save: the row shows the newest at once, and it is sent after the save (the last wish wins)', async () => {
  await fresh();
  const p = store.setSkillState('mine-cc', 'on');
  void store.setSkillState('mine-cc', 'manual');
  void store.setSkillState('mine-cc', 'off');
  void store.setSkillState('mine-cc', 'manual');
  assert.equal(skill('mine-cc').state, 'manual', 'the row (and so the checked radio) follows the latest wish at once');
  await p;
  assert.equal(skill('mine-cc').state, 'manual');
  assert.deepEqual(getArmory().switching, []);
  const sent = world.calls.filter((c) => c.path === '/api/armory/state').map((c) => (c.body as { state: string }).state);
  assert.deepEqual(sent, ['on', 'manual'], 'two writes: the first, then only the newest queued one');
});

test('a queued change whose save fails puts the row back to the last saved state', async () => {
  await fresh();
  const p = store.setSkillState('mine-cc', 'on');
  world.failState.add('mine-cc');
  void store.setSkillState('mine-cc', 'manual');
  assert.equal(await p, false);
  assert.equal(skill('mine-cc').state, 'on', 'the first save worked, so that is the last saved state');
  assert.ok(getArmory().rowErrors['mine-cc']);
  assert.deepEqual(getArmory().switching, []);
});

test('a failed change puts the row back and says why on that row; a good one clears it', async () => {
  await fresh();
  world.failState.add('mine-cc');
  assert.equal(await store.setSkillState('mine-cc', 'on'), false);
  assert.equal(skill('mine-cc').state, 'off', 'rolled back');
  assert.deepEqual(getArmory().rowErrors['mine-cc'], { op: 'state', message: 'disk is full' });
  assert.equal(getArmory().loadError, null, 'the screen-wide error stays empty');
  world.failState.clear();
  assert.equal(await store.setSkillState('mine-cc', 'on'), true);
  assert.equal(getArmory().rowErrors['mine-cc'], undefined);
  world.failState.add('verify');
  await store.setSkillState('verify', 'on');
  assert.ok(getArmory().rowErrors.verify);
  await store.loadArmory();
  assert.deepEqual(getArmory().rowErrors, {}, 'a good read clears every stale row error');
});

test('a skill that acts on Claude Code itself cannot be turned on: the core says why, and the row stays off', async () => {
  await fresh();
  assert.equal(await store.setSkillState('update-config', 'on'), false);
  assert.equal(skill('update-config').state, 'off');
  assert.match(getArmory().rowErrors['update-config']!.message, /acts on Claude Code itself/);
});

test('which agents: optimistic, and a failure restores the old list with its own error kind', async () => {
  await fresh();
  const p = store.setSkillAgents('mine-cc', ['alpha']);
  assert.deepEqual(skill('mine-cc').agents, ['alpha']);
  assert.equal(await p, true);
  assert.match(getArmory().notice, /^mine-cc: 1 agent\./);
  world.failState.add('agents:mine-cc');
  assert.equal(await store.setSkillAgents('mine-cc', 'all'), false);
  assert.deepEqual(skill('mine-cc').agents, ['alpha'], 'back as it was');
  assert.equal(getArmory().rowErrors['mine-cc']!.op, 'agents');
});

test('turning a group on skips what is on and what cannot be on, says what it did, and Undo restores every old state exactly', async () => {
  await fresh();
  assert.equal(store.bulkCount('plugin:playwright', 'on'), 2);
  const before = states();
  world.calls.length = 0;
  await store.bulkSet('plugin:playwright', 'on');
  assert.equal(skill('playwright:click').state, 'on');
  assert.equal(skill('playwright:snap').state, 'on');
  assert.equal(getArmory().undo?.message, 'Turned on 2 skills. Agents now see 4 descriptions.');
  assert.match(getArmory().notice, /^Turned on 2 skills\./);
  assert.deepEqual(getArmory().undo?.items.map((i) => i.state).sort(), ['manual', 'off'], 'Undo knows the three-state value, not a yes/no');
  await store.undoBulk();
  assert.deepEqual(states(), before, 'exactly the previous states: manual went back to manual, not to off');
  assert.equal(getArmory().undo, null);
  assert.match(getArmory().notice, /^Put back 2 skills\./);

  world.calls.length = 0;
  await store.bulkSet('builtin', 'on');
  assert.deepEqual(world.calls.filter((c) => c.path === '/api/armory/state-bulk').map((c) => c.body!.ids), [['verify']], 'update-config has an offReason and is never asked');
  store.clearUndo();
});

test('a group change is ONE bulk request with every id, no per-skill request; Undo is one request per old state', async () => {
  await fresh();
  world.calls.length = 0;
  await store.bulkSet('plugin:playwright', 'on');
  const sent = world.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(sent, ['POST /api/armory/state-bulk'], 'a group of two is one request, and nothing goes to the single route');
  assert.deepEqual(world.calls[0]!.body, { ids: ['playwright:click', 'playwright:snap'], state: 'on' });
  world.calls.length = 0;
  await store.undoBulk();
  assert.deepEqual(world.calls.map((c) => c.path), ['/api/armory/state-bulk', '/api/armory/state-bulk'], 'manual and off are two states, so two requests, never one per skill');
  assert.deepEqual(world.calls.map((c) => c.body), [{ ids: ['playwright:snap'], state: 'manual' }, { ids: ['playwright:click'], state: 'off' }]);
  assert.equal(skill('playwright:snap').state, 'manual');
  assert.equal(skill('playwright:click').state, 'off');
});

test('rows move at once for a group change, and are all put back with the reason when the whole request fails', async () => {
  await fresh();
  const before = states();
  world.failBulk = 'the write failed';
  const p = store.bulkSet('plugin:playwright', 'on');
  assert.equal(skill('playwright:click').state, 'on', 'optimistic');
  assert.deepEqual([...getArmory().switching].sort(), ['playwright:click', 'playwright:snap']);
  await p;
  assert.deepEqual(states(), before, 'every row is back');
  assert.deepEqual(getArmory().switching, []);
  assert.equal(getArmory().resetting, null);
  assert.match(getArmory().resetErrors['plugin:playwright']!, /^2 of 2 did not change: the write failed/);
  assert.deepEqual(getArmory().rowErrors['playwright:click'], { op: 'state', message: 'the write failed' });
  assert.equal(getArmory().undo, null, 'nothing changed, so there is nothing to undo');
});

test('a skill the core refuses is put back and says why on its row, while the rest of the group is on', async () => {
  await fresh();
  world.failState.add('playwright:click');
  await store.bulkSet('plugin:playwright', 'on');
  assert.equal(skill('playwright:click').state, 'off');
  assert.equal(skill('playwright:snap').state, 'on');
  assert.deepEqual(getArmory().rowErrors['playwright:click'], { op: 'state', message: 'disk is full' });
  assert.equal(getArmory().rowErrors['playwright:snap'], undefined);
});

test('Turn all on is one bulk request, then the notice is closed', async () => {
  await fresh();
  world.calls.length = 0;
  await store.turnAllOn();
  assert.deepEqual(world.calls.map((c) => c.path), ['/api/armory/state-bulk', '/api/armory/notice-seen']);
  assert.deepEqual([...(world.calls[0]!.body!.ids as string[])].sort(), ['mine-cc', 'playwright:click', 'playwright:snap']);
  assert.equal(world.calls[0]!.body!.state, 'on');
  store.clearUndo();
});

test('nothing to change means no request and no Undo offer', async () => {
  await fresh();
  world.calls.length = 0;
  await store.bulkSet('nope', 'on');
  await store.bulkSet('plugin:context7', 'on');
  assert.deepEqual(world.calls, []);
  assert.equal(getArmory().undo, null);
});

test('a group change where one skill fails still does the rest, says how many did not change, and Undo covers only what changed', async () => {
  await fresh();
  world.failState.add('playwright:snap');
  await store.bulkSet('plugin:playwright', 'on');
  assert.equal(skill('playwright:click').state, 'on');
  assert.equal(skill('playwright:snap').state, 'manual', 'the failed one is back as it was');
  assert.match(getArmory().resetErrors['plugin:playwright']!, /^1 of 2 did not change: disk is full/);
  assert.equal(getArmory().undo?.message, 'Turned on 1 skill. 1 did not change. Agents now see 3 descriptions.');
  assert.deepEqual(getArmory().undo?.items.map((i) => i.id), ['playwright:click']);
});

test('a failed Undo keeps the offer, names the reason, lists only what is still to put back, and a second try finishes', async () => {
  await fresh();
  const before = states();
  await store.bulkSet('plugin:playwright', 'on');
  world.failState.add('playwright:snap');
  await store.undoBulk();
  const u = getArmory().undo;
  assert.ok(u, 'dropping the offer would leave no way back');
  assert.equal(u.error, 'Undo failed: disk is full. Try again.');
  assert.deepEqual(u.items.map((i) => i.id), ['playwright:snap']);
  assert.equal(u.total, 2);
  assert.equal(getArmory().notice.trim(), 'Undo failed: disk is full. Try again.');
  assert.equal(skill('playwright:click').state, 'off', 'the one that worked is back');
  world.failState.clear();
  await store.undoBulk();
  assert.equal(getArmory().undo, null);
  assert.deepEqual(states(), before);
  assert.match(getArmory().notice, /^Put back 2 skills\./, 'counted over the whole change');
});

test('the Undo offer goes at the next change and after ten seconds, waits for the pointer and focus, and says when it ran out', async () => {
  await fresh();
  await store.bulkSet('plugin:playwright', 'on');
  assert.ok(getArmory().undo);
  await store.setSkillState('mine-cc', 'on');
  assert.equal(getArmory().undo, null, 'the next change drops it');

  await fresh();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await store.bulkSet('plugin:playwright', 'on');
    store.holdUndo('focus'); store.holdUndo('hover');
    mock.timers.tick(store.UNDO_MS * 5);
    assert.ok(getArmory().undo, 'held: still there after five times the time');
    store.releaseUndo('hover');
    mock.timers.tick(store.UNDO_MS * 5);
    assert.ok(getArmory().undo, 'one holder left');
    store.releaseUndo('focus');
    mock.timers.tick(store.UNDO_MS - 1);
    assert.ok(getArmory().undo);
    mock.timers.tick(1);
    assert.equal(getArmory().undo, null);
    assert.equal(getArmory().notice.trim(), 'Undo is no longer available.');
    assert.equal(store.UNDO_MS, 10_000);
  } finally { mock.timers.reset(); }
});

test('Turn all on: only your Claude Code skills and plugin skills, never built-ins; then the notice is closed; Undo is offered', async () => {
  await fresh();
  assert.equal(getArmory().data!.ccNoticeSeen, false);
  world.calls.length = 0;
  await store.turnAllOn();
  assert.equal(skill('mine-cc').state, 'on');
  assert.equal(skill('playwright:click').state, 'on');
  assert.equal(skill('playwright:snap').state, 'on');
  assert.equal(skill('verify').state, 'off', 'built-ins are not part of it');
  assert.equal(skill('update-config').state, 'off');
  assert.equal(skill('legion-armory:got').state, 'off', 'imported skills are not part of it either');
  assert.equal(getArmory().data!.ccNoticeSeen, true);
  assert.equal(world.calls.at(-1)!.path, '/api/armory/notice-seen', 'closed after the skills, not before');
  assert.equal(getArmory().undo?.key, 'notice');
  assert.equal(getArmory().undo?.message, 'Turned on 3 skills. Agents now see 5 descriptions.');
  await store.undoBulk();
  assert.equal(skill('playwright:snap').state, 'manual');
  assert.equal(skill('mine-cc').state, 'off');
});

test('Turn all on that does not fully work keeps the notice, says how many did not turn on, and does not close it', async () => {
  await fresh();
  world.failState.add('mine-cc');
  world.calls.length = 0;
  await store.turnAllOn();
  assert.match(getArmory().noticeError ?? '', /^1 of 3 did not turn on: disk is full/);
  assert.equal(getArmory().data!.ccNoticeSeen, false);
  assert.ok(!world.calls.some((c) => c.path === '/api/armory/notice-seen'), 'not marked seen');
  assert.equal(getArmory().noticeBusy, false);
  assert.equal(getArmory().undo?.total, 2);
  store.clearUndo();
});

test('Got it: closes the notice; a failure says why and leaves it open', async () => {
  await fresh();
  world.failNotice = true;
  assert.equal(await store.dismissNotice(), false);
  assert.equal(getArmory().noticeError, 'cannot write the notice');
  assert.equal(getArmory().data!.ccNoticeSeen, false);
  world.failNotice = false;
  assert.equal(await store.dismissNotice(), true);
  assert.equal(getArmory().noticeError, null);
  assert.equal(getArmory().data!.ccNoticeSeen, true);
});

test('the Advanced switch: optimistic, announced, and put back with the reason when the core cannot do it', async () => {
  await fresh();
  const p = store.setAllowShell(true);
  assert.equal(getArmory().data!.allowSkillShell, true);
  await p;
  assert.equal(world.allowSkillShell, true);
  assert.match(getArmory().notice, /^Skills may run commands when they load\./);
  world.noShell = true;
  await store.setAllowShell(false);
  assert.equal(getArmory().data!.allowSkillShell, true, 'back as it was');
  assert.equal(getArmory().shellError, 'no route');
  assert.equal(getArmory().shellBusy, false);
  world.noShell = false;
  await store.setAllowShell(false);
  assert.equal(getArmory().shellError, null);
  assert.equal(getArmory().data!.allowSkillShell, false);
});

test('Remove is at once, offers Undo, and Undo posts the old text, then puts the state and the agent list back', async () => {
  await fresh();
  world.texts['legion-armory:mine'] = '---\nname: mine\ndescription: >-\n  Does a thing. Use when: a task needs it\n---\n\n# Body\n\nStep.\n';
  await store.setSkillState('legion-armory:mine', 'manual');
  await store.setSkillAgents('legion-armory:mine', ['alpha']);
  assert.equal(await store.removeSkill('legion-armory:mine'), true);
  assert.equal(getArmory().data!.skills.some((s) => s.id === 'legion-armory:mine'), false, 'gone at once');
  assert.equal(getArmory().removed?.message, 'Removed mine.');
  assert.match(getArmory().notice, /^Removed mine\./);
  world.calls.length = 0;
  await store.undoRemove();
  const post = world.calls.find((c) => c.path === '/api/armory/skill')!;
  assert.equal(post.body!.name, 'mine');
  assert.equal(post.body!.description, 'Does a thing. Use when: a task needs it', 'the whole line goes back as the description');
  assert.ok(!('whenToUse' in post.body!), 'so the text round-trips byte for byte');
  assert.equal(post.body!.body, '# Body\n\nStep.');
  assert.equal(skill('legion-armory:mine').state, 'manual', 'the owner choice goes back too, not the default');
  assert.deepEqual(skill('legion-armory:mine').agents, ['alpha']);
  assert.equal(getArmory().removed, null);
  assert.equal(getArmory().highlight, 'legion-armory:mine');
  assert.match(getArmory().notice, /^Put mine back\./);
});

test('Undo for an imported skill brings back SKILL.md only, off, and keeps what the owner chose', async () => {
  await fresh();
  await store.setSkillState('legion-armory:got', 'manual');
  await store.removeSkill('legion-armory:got');
  assert.equal(getArmory().removed?.source, 'imported');
  world.calls.length = 0;
  await store.undoRemove();
  const post = world.calls.find((c) => c.path === '/api/armory/import')!;
  assert.deepEqual((post.body!.files as { path: string }[]).map((f) => f.path), ['got/SKILL.md']);
  assert.equal(skill('legion-armory:got').source, 'imported');
  assert.equal(skill('legion-armory:got').state, 'manual');
});

test('a failed Undo for Remove keeps the offer with the reason; a failed Remove says so on the row and offers nothing', async () => {
  await fresh();
  await store.removeSkill('legion-armory:mine');
  world.failRestore = true;
  await store.undoRemove();
  assert.equal(getArmory().removed?.error, 'Undo failed: disk is full. Try again.');
  assert.deepEqual(getArmory().busyIds, []);
  assert.equal(getArmory().notice.trim(), 'Undo failed: disk is full. Try again.');
  world.failRestore = false;
  await store.undoRemove();
  assert.equal(getArmory().removed, null);
  assert.ok(skill('legion-armory:mine'));

  world.failDelete = true;
  assert.equal(await store.removeSkill('legion-armory:got'), false);
  assert.deepEqual(getArmory().rowErrors['legion-armory:got'], { op: 'remove', message: 'in use' });
  assert.equal(getArmory().removed, null);
  assert.ok(skill('legion-armory:got'), 'still there');
});

test('only yours and imported skills can be removed, and the check is made before any request', async () => {
  await fresh();
  world.calls.length = 0;
  assert.equal(await store.removeSkill('playwright:click'), false);
  assert.equal(await store.removeSkill('verify'), false);
  assert.equal(await store.removeSkill('nope'), false);
  assert.deepEqual(world.calls, []);
});

test('the Remove Undo waits too, and says when it ran out', async () => {
  await fresh();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await store.removeSkill('legion-armory:got');
    store.holdRemoved('hover');
    mock.timers.tick(store.UNDO_MS * 3);
    assert.ok(getArmory().removed);
    store.releaseRemoved('hover');
    mock.timers.tick(store.UNDO_MS);
    assert.equal(getArmory().removed, null);
    assert.equal(getArmory().notice.trim(), 'Undo is no longer available.');
  } finally { mock.timers.reset(); }
});

test('Promote copies to Doctrine through the one promote route and says it is not approved; a refusal lands on the row', async () => {
  await fresh();
  world.calls.length = 0;
  assert.equal(await store.promoteSkill('mine-cc'), true);
  const c = world.calls.find((x) => x.path === '/api/house/drill/promote')!;
  assert.deepEqual(c.body, { armoryId: 'mine-cc' });
  assert.deepEqual(getArmory().promoted, { id: 'mine-cc', name: 'mine', path: 'skills/yours/mine/SKILL.md', from: 'mine-cc' });
  assert.match(getArmory().notice, /not approved and it is off/);
  assert.ok(world.calls.some((x) => x.path === '/api/house'), 'the Doctrine list is re-read, so the new drill is there when the owner opens it');
  store.dismissPromoted();
  world.failPromote = true;
  assert.equal(await store.promoteSkill('mine-cc'), false);
  assert.equal(getArmory().promoted, null);
  assert.deepEqual(getArmory().rowErrors['mine-cc'], { op: 'promote', message: 'You already have a drill called mine. Rename one of them.' });
});

test('saving a skill: whenToUse is sent only when written, the new skill is highlighted for a few seconds, and the core words come back as the error', async () => {
  await fresh();
  world.calls.length = 0;
  const r = await store.saveSkill({ name: 'fresh', description: 'D.', whenToUse: '   ', body: 'B' });
  assert.deepEqual(r, { id: 'legion-armory:fresh', created: true });
  assert.ok(!('whenToUse' in world.calls.find((c) => c.path === '/api/armory/skill')!.body!));
  assert.equal(getArmory().highlight, 'legion-armory:fresh');
  assert.match(getArmory().notice, /^Saved fresh\. It is off\./);
  await store.saveSkill({ name: 'fresh', description: 'D.', whenToUse: 'when', body: 'B' });
  assert.equal(world.calls.filter((c) => c.path === '/api/armory/skill').at(-1)!.body!.whenToUse, 'when');
  assert.match(getArmory().notice, /^Saved fresh\./);

  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await store.saveSkill({ name: 'other', description: 'D.', whenToUse: '', body: 'B' });
    assert.equal(getArmory().highlight, 'legion-armory:other');
    mock.timers.tick(8000);
    assert.equal(getArmory().highlight, null);
  } finally { mock.timers.reset(); }
  world.failSave = 'A skill called x is already in the Armory and was not written here.';
  await assert.rejects(store.saveSkill({ name: 'x', description: 'D.', whenToUse: '', body: 'B' }), /already in the Armory/);
});

test('importing: the core words come back as the error and nothing is half-added; success is announced as off', async () => {
  await fresh();
  world.failImport = 'A skill called got is already in the Armory. Remove it first, or rename the folder.';
  await assert.rejects(store.importSkill([{ path: 'got/SKILL.md', text: 'x' }]), /Remove it first/);
  world.failImport = '';
  const r = await store.importSkill([{ path: 'another/SKILL.md', text: 'x' }]);
  assert.deepEqual(r.stripped, ['allowed-tools']);
  assert.equal(getArmory().highlight, 'legion-armory:another');
  assert.match(getArmory().notice, /^Added another\. It is off\./);
});

test('the import review is asked of the core (dryRun): files are sent as read, others as a name and a size, a refusal is an answer, and a failed request throws', async () => {
  await fresh();
  world.calls.length = 0;
  const files = [{ path: 'got2/SKILL.md', text: 'x' }, { path: 'got2/run.sh', size: 12, text: null as null }];
  const review = await store.reviewImportFiles(files);
  assert.equal(review.ok, true);
  assert.equal(review.id, 'legion-armory:got2');
  assert.deepEqual(world.calls, [{ method: 'POST', path: '/api/armory/import', body: { files, dryRun: true } }]);
  assert.ok(!world.skills.some((s) => s.id === 'legion-armory:got2'), 'the review adds nothing');
  world.dryRun = { ok: false, refusal: 'There is no SKILL.md in what was given.', name: '', id: '', description: '', kept: [], dropped: [], stripped: [], skillText: '' };
  const no = await store.reviewImportFiles([{ path: 'a.md', text: 'x' }]);
  assert.deepEqual([no.ok, no.refusal], [false, 'There is no SKILL.md in what was given.']);
  world.failImport = 'core is busy';
  await assert.rejects(store.reviewImportFiles(files), /core is busy/);
  world.failImport = '';
  world.dryRun = null;
  world.calls.length = 0;
  await store.importSkill(files);
  assert.deepEqual(world.calls[0]!.body, { files }, 'Add sends the same files, without dryRun');
});

test('what an agent sees: the latest answer wins even when an older one arrives later', async () => {
  await fresh();
  world.eff.alpha = { delay: 60, counts: 1 };
  const slow = store.loadEffective('alpha');
  world.eff.alpha = { delay: 0, counts: 50 };
  await store.loadEffective('alpha');
  await slow;
  assert.equal(getArmory().effective.alpha!.data!.counts.total, 50);
  world.down = true;
  await store.loadEffective('beta');
  assert.equal(getArmory().effective.beta!.status, 'error');
  assert.equal(getArmory().effective.beta!.error, 'Cannot reach Legion core');
  world.down = false;
});

test('Read: a built-in has no text and no request; a failure can be retried; a late answer for a closed dialog is dropped', async () => {
  await fresh();
  world.calls.length = 0;
  await store.openRead('verify', 'verify');
  assert.equal(getArmory().reading?.status, 'builtin');
  assert.deepEqual(world.calls, []);
  world.texts['mine-cc'] = 'FAIL';
  await store.openRead('mine-cc', 'mine-cc');
  assert.equal(getArmory().reading?.status, 'error');
  assert.equal(getArmory().reading?.error, 'cannot read');
  delete world.texts['mine-cc'];
  await store.openRead('mine-cc', 'mine-cc');
  assert.equal(getArmory().reading?.status, 'ready');
  await store.openRead('playwright:click', 'click');
  assert.equal(getArmory().reading?.thirdParty, true);
});

test('Doctrine: a new drill is written through the one drill route, the list is re-read, and the row is found; nothing is approved or switched on', async () => {
  await fresh();
  world.calls.length = 0;
  const path = await store.house.saveDrill({ name: 'steps', description: 'D.', whenToUse: '', body: 'B' }, false);
  assert.equal(path, 'skills/yours/steps/SKILL.md');
  const paths = world.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(paths, ['POST /api/house/drill', 'GET /api/house']);
  assert.ok(!('whenToUse' in world.calls[0]!.body!));
  assert.ok(!('replace' in world.calls[0]!.body!), 'New never asks to replace: the core refuses a taken name');
  assert.equal(store.house.getHouse().justAdded, path);
  assert.match(store.house.getHouse().notice, /^Added steps\. It is not approved and it is off\./);
  world.calls.length = 0;
  await store.house.saveDrill({ name: 'steps', description: 'D.', whenToUse: 'w', body: 'B' }, true);
  assert.equal(world.calls[0]!.body!.replace, true, 'Edit is the one path that sends replace: true');
  assert.match(store.house.getHouse().notice, /^Saved steps\. Your approval no longer applies, so approve it again\./);
  world.failSave = 'description is required.';
  await assert.rejects(store.house.saveDrill({ name: 'x', description: '', whenToUse: '', body: 'B' }, false), /description is required/);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    world.failSave = '';
    await store.house.saveDrill({ name: 'later', description: 'D.', whenToUse: '', body: 'B' }, false);
    assert.equal(store.house.getHouse().justAdded, 'skills/yours/later/SKILL.md');
    mock.timers.tick(8000);
    assert.equal(store.house.getHouse().justAdded, null);
  } finally { mock.timers.reset(); }
});

// ---- Undo for Remove against the REAL routes: the text the core hands back must be enough to bring the skill back ----

const realRig = async (): Promise<ArmoryRig> => {
  const rig = armoryRig({ inherit: false });
  world.real = rig;
  reset(); world.real = rig;
  store.clearUndo(); store.clearRemoved();
  await store.loadArmory();
  return rig;
};

test('real routes: a skill of yours removed and restored is the same file, with its state and agent list', async () => {
  const rig = await realRig();
  await store.saveSkill({ name: 'steps', description: 'Does: a thing, "quoted".', whenToUse: 'a task needs it', body: '# Title\n\n1. one\n2. two' });
  const id = 'legion-armory:steps';
  await store.setSkillState(id, 'manual');
  await store.setSkillAgents(id, ['alpha']);
  const path = getArmory().data!.skills.find((s) => s.id === id)!.path!;
  const { readFileSync } = await import('node:fs');
  const original = readFileSync(path, 'utf8');
  assert.equal(await store.removeSkill(id), true);
  assert.equal(getArmory().data!.skills.some((s) => s.id === id), false);
  await store.undoRemove();
  assert.equal(readFileSync(path, 'utf8'), original, 'byte for byte');
  const back = getArmory().data!.skills.find((s) => s.id === id)!;
  assert.equal(back.state, 'manual');
  assert.deepEqual(back.agents, ['alpha']);
  assert.equal(back.source, 'yours');
  void rig;
});

test('real routes: an imported skill comes back from SKILL.md alone, off or as the owner had it, and still imported', async () => {
  await realRig();
  const text = '---\nname: got\ndescription: Imported thing.\nallowed-tools: Bash\n---\n\nBody.\n';
  const r = await store.importSkill([{ path: 'got/SKILL.md', text }, { path: 'got/ref/a.md', text: 'ref' }]);
  assert.deepEqual(r.stripped, ['allowed-tools']);
  const id = 'legion-armory:got';
  assert.equal(getArmory().data!.skills.find((s) => s.id === id)!.state, 'off');
  await store.setSkillState(id, 'on');
  await store.removeSkill(id);
  await store.undoRemove();
  const back = getArmory().data!.skills.find((s) => s.id === id)!;
  assert.equal(back.source, 'imported');
  assert.equal(back.state, 'on', 'the owner choice is kept');
  await store.setSkillState(id, 'off');
});

test('real routes: a group switch and its Undo go through the real bulk route and come back to the exact old states', async () => {
  const rig = await realRig();
  await store.saveSkill({ name: 'one', description: 'D.', whenToUse: '', body: 'B' });
  await store.saveSkill({ name: 'two', description: 'D.', whenToUse: '', body: 'B' });
  await store.setSkillState('legion-armory:one', 'on');
  await store.setSkillState('legion-armory:two', 'manual');
  world.calls.length = 0;
  await store.bulkSet('yours', 'off');
  assert.deepEqual(world.calls.filter((c) => c.path.startsWith('/api/armory/state')).map((c) => c.path), ['/api/armory/state-bulk']);
  const disk = (): Record<string, string> => Object.fromEntries(Object.entries(JSON.parse(readFileSync(armoryFilePath(rig.dataDir), 'utf8')).skills as Record<string, { state: string }>).map(([k, v]) => [k, v.state]));
  assert.deepEqual(disk(), { 'legion-armory:one': 'off', 'legion-armory:two': 'off' });
  await store.undoBulk();
  assert.deepEqual(disk(), { 'legion-armory:one': 'on', 'legion-armory:two': 'manual' });
  assert.deepEqual(getArmory().data!.skills.filter((s) => s.source === 'yours').map((s) => [s.id, s.state]), [['legion-armory:one', 'on'], ['legion-armory:two', 'manual']]);
});

test('real routes: the state, agents and effective answers have the shapes the store reads', async () => {
  await realRig();
  await store.saveSkill({ name: 'shape', description: 'D.', whenToUse: '', body: 'B' });
  const s = getArmory().data!.skills.find((x) => x.id === 'legion-armory:shape')!;
  for (const k of ['id', 'name', 'description', 'source', 'plugin', 'state', 'stateIsDefault', 'agents', 'path', 'manualOnlyInFrontmatter']) assert.ok(k in s, `skill has ${k}`);
  assert.equal(s.state, 'off', 'yours starts off, like every other skill');
  await store.setSkillState('legion-armory:shape', 'on');
  await store.loadEffective('alpha');
  const e = getArmory().effective.alpha!;
  assert.equal(e.status, 'ready');
  assert.ok(e.data!.counts.total >= 1);
  assert.equal(getArmory().data!.ccNoticeSeen, false);
  await store.dismissNotice();
  assert.equal(getArmory().data!.ccNoticeSeen, true);
});


test('Refresh asks Claude Code again (POST /api/armory/refresh), replaces the list and the time, and says so in the live region', async () => {
  await fresh();
  assert.equal(getArmory().data!.discoveredAt, '2026-10-06T10:00:00.000Z');
  world.skills.push(mk('claude.ai:Weekly Report', 'claude-plugin', { name: 'Weekly Report', plugin: 'claude.ai' }));
  world.calls.length = 0;
  const p = store.refreshDiscovery();
  assert.equal(getArmory().refreshing, true, 'busy while it runs');
  assert.equal(await store.refreshDiscovery(), false, 'a second click while it runs does nothing');
  assert.equal(await p, true);
  assert.deepEqual(world.calls.map((c) => `${c.method} ${c.path}`), ['POST /api/armory/refresh']);
  assert.equal(getArmory().refreshing, false);
  assert.equal(getArmory().refreshError, null);
  assert.equal(getArmory().data!.discoveredAt, '2026-10-06T11:00:00.000Z');
  assert.ok(getArmory().data!.skills.some((x) => x.id === 'claude.ai:Weekly Report'), 'the new skill is listed');
  assert.match(getArmory().notice, /^Refreshed from Claude Code\. \d+ skills listed\./);
});

test('a Refresh that falls back to the folders is announced as such; one that fails keeps the list, says why, and can be tried again', async () => {
  await fresh();
  world.discovery = 'disk-fallback'; world.discoveryReason = 'The handshake timed out.';
  assert.equal(await store.refreshDiscovery(), true);
  assert.equal(getArmory().data!.discovery, 'disk-fallback');
  assert.match(getArmory().notice, /^Refreshed, but Claude Code could not be asked\./);
  const n = getArmory().data!.skills.length;
  world.failRefresh = 'core is busy';
  assert.equal(await store.refreshDiscovery(), false);
  assert.equal(getArmory().refreshError, 'core is busy');
  assert.equal(getArmory().data!.skills.length, n, 'the old list stays');
  assert.equal(getArmory().refreshing, false, 'the button is usable again');
  assert.match(getArmory().notice, /^Could not refresh: core is busy\./);
  world.failRefresh = '';
  assert.equal(await store.refreshDiscovery(), true);
  assert.equal(getArmory().refreshError, null, 'a good try clears the error');
});

test('built-ins in bulk: only the useful ones go on; the others and the locked ones are never asked', async () => {
  await fresh();
  world.skills.push(mk('slides', 'claude-builtin', { path: null, fit: 'other' }), mk('debug', 'claude-builtin', { path: null, fit: 'fit' }));
  await store.loadArmory();
  assert.equal(store.bulkCount('builtin', 'on'), 2, 'verify and debug, not slides or update-config');
  world.calls.length = 0;
  await store.bulkSet('builtin', 'on');
  assert.deepEqual(world.calls.filter((c) => c.path === '/api/armory/state-bulk').map((c) => [...(c.body!.ids as string[])].sort()), [['debug', 'verify']]);
  assert.equal(skill('slides').state, 'off', 'an "other" built-in stays as it was');
  assert.equal(skill('update-config').state, 'off');
  assert.equal(getArmory().undo?.message, 'Turned on 2 skills. Agents now see 4 descriptions.');
  await store.undoBulk();
  assert.equal(skill('verify').state, 'off');
  store.clearUndo();
});

test('a skill whose name has spaces switches, bulk-changes and reads like any other (the id is used as given)', async () => {
  await fresh();
  world.skills.push(mk('claude.ai:Weekly Report', 'claude-plugin', { name: 'Weekly Report', plugin: 'claude.ai', path: null }));
  await store.loadArmory();
  world.calls.length = 0;
  assert.equal(await store.setSkillState('claude.ai:Weekly Report', 'manual'), true);
  assert.equal(skill('claude.ai:Weekly Report').state, 'manual');
  assert.deepEqual(world.calls.map((c) => c.body), [{ id: 'claude.ai:Weekly Report', state: 'manual' }], 'sent as given, not slugged');
  assert.equal(store.bulkCount('plugin:claude.ai', 'on'), 1);
  await store.bulkSet('plugin:claude.ai', 'on');
  assert.equal(skill('claude.ai:Weekly Report').state, 'on');
  store.clearUndo();
});

/* ---- review fixes ---- */

test('B2: the store says what turning on would do BEFORE it is done, and the Undo bar repeats what agents now see', async () => {
  await fresh();
  store.setAgentContext([{ id: 'zealot', name: 'Zealot' }]);
  const quiet = store.consequenceOf('notice');
  assert.deepEqual([quiet.over, quiet.message], [false, ''], 'three skills do not crowd anyone');
  for (let i = 0; i < 45; i++) world.skills.push(mk(`bulk-${i}`, 'claude-personal'));
  await store.loadArmory();
  const c = store.consequenceOf('notice');
  assert.equal(c.over, true);
  assert.match(c.message, /^Zealot would see 5\d skill descriptions if you turn on \d+ skills \(the built-in skills are not included\)\. More than about 40 crowds out the task\. Turn on anyway\?$/);
  assert.equal(skill('bulk-0').state, 'off', 'asking changes nothing');
  world.calls.length = 0;
  await store.turnAllOn();
  assert.match(getArmory().undo!.message, /^Turned on 48 skills\. Agents now see 5\d descriptions\.$/);
});

test('B2: skills that carry flags are counted in what the owner is told, and in the Undo bar', async () => {
  await fresh();
  store.setAgentContext([{ id: 'zealot', name: 'Zealot' }]);
  world.skills.find((s) => s.id === 'mine-cc')!.runsCommandsOnLoad = true;
  await store.loadArmory();
  await store.bulkSet('personal', 'on');
  assert.match(getArmory().undo!.message, / Of these, 1 runs commands when loaded\.$/);
});

test('m3 + B9: Undo after "Turn all on" puts the notice back, and says so in words that stay', async () => {
  await fresh();
  await store.turnAllOn();
  assert.equal(getArmory().data!.ccNoticeSeen, true);
  world.calls.length = 0;
  await store.undoBulk();
  assert.deepEqual(world.calls.filter((c) => c.path === '/api/armory/notice-seen').map((c) => c.body), [{ seen: false }]);
  assert.equal(getArmory().data!.ccNoticeSeen, false, 'the notice is back');
  assert.equal(world.ccNoticeSeen, false);
  assert.deepEqual(getArmory().undone, { key: 'notice', message: 'Put back 3 skills.' });
  assert.match(getArmory().notice, /^Put back 3 skills\./);
  store.clearUndone();
  assert.equal(getArmory().undone, null);
});

test('m3: a group Undo is shown too, and a failed "Turn all on" does not bring a notice back that was never closed', async () => {
  await fresh();
  await store.bulkSet('plugin:playwright', 'on');
  await store.undoBulk();
  assert.deepEqual(getArmory().undone, { key: 'plugin:playwright', message: 'Put back 2 skills.' });
  world.calls.length = 0;
  await store.bulkSet('plugin:playwright', 'on');
  assert.equal(getArmory().undone, null, 'the next change clears it');
  world.failState.add('mine-cc');
  await store.turnAllOn();
  assert.equal(getArmory().data!.ccNoticeSeen, false);
  world.calls.length = 0;
  await store.undoBulk();
  assert.ok(!world.calls.some((c) => c.path === '/api/armory/notice-seen'), 'the notice was never closed, so it is not reopened');
});

test('B5: a row being removed is busy with its operation at once, and not busy afterwards', async () => {
  await fresh();
  world.slow = 30;
  const p = store.removeSkill('legion-armory:got');
  assert.equal(getArmory().busyOps['legion-armory:got'], 'remove');
  assert.ok(getArmory().busyIds.includes('legion-armory:got'));
  await p;
  assert.deepEqual(getArmory().busyOps, {});
  world.slow = 0;
  world.failDelete = true;
  assert.equal(await store.removeSkill('legion-armory:mine'), false);
  assert.deepEqual(getArmory().busyOps, {}, 'a failure frees the row too');
});

test('M3: Open Doctrine reveals the new drill (its group opens, the row is marked and takes focus), and the bar is gone', async () => {
  await fresh();
  await store.promoteSkill('mine-cc');
  assert.ok(getArmory().promoted);
  store.showPromotedDrill();
  assert.equal(getArmory().promoted, null);
});

test('m9: two skills with one name are told apart in what is announced', async () => {
  await fresh();
  world.skills.push(mk('debug', 'claude-builtin', { path: null, fit: 'other' }), mk('superpowers:debug', 'claude-plugin'));
  await store.loadArmory();
  await store.setSkillState('debug', 'on');
  assert.match(getArmory().notice, /^debug \(built-in\): agents decide\./);
  await store.setSkillState('superpowers:debug', 'on');
  assert.match(getArmory().notice, /^debug \(superpowers\): agents decide\./);
  await store.setSkillState('mine-cc', 'on');
  assert.match(getArmory().notice, /^mine-cc: agents decide\./, 'a name that is alone stays plain');
});

test('B3: reveal marks one skill, and your own drills are named the way you typed them', async () => {
  await fresh();
  store.revealSkill('mine-cc');
  assert.equal(getArmory().reveal, 'mine-cc');
  const drills = store.drillRefsOf([
    { category: 'skills', skill: 'skills/yours/my-drill/SKILL.md', path: 'skills/yours/my-drill/SKILL.md', group: 'yours', on: true, title: 'A title' },
    { category: 'skills', skill: 'skills/review/deep/SKILL.md', path: 'skills/review/deep/SKILL.md', group: 'review', on: false, title: 'deep-review' },
    { category: 'skills', skill: 'skills/review/deep/SKILL.md', path: 'skills/review/deep/refs/a.md', group: 'review', on: false },
  ]);
  assert.deepEqual(drills.map((d) => [d.id, d.name, d.on]), [['drill:yours/my-drill', 'my-drill', true], ['drill:review/deep', 'Deep', false]]);
});

test('B9: your own drill can be removed (DELETE), the row says so at once, and Undo posts it again with replace; it comes back not approved and off', async () => {
  await fresh();
  const text = `---${NL}name: mine${NL}description: >-${NL}  Does a thing. Use when: asked.${NL}---${NL}${NL}Body.${NL}`;
  world.drillText = text;
  world.slow = 25;
  const path = 'skills/yours/mine/SKILL.md';
  const p = store.house.removeDrill(path, 'mine');
  assert.equal(store.house.getHouse().removingPath, path, 'Removing… at once');
  assert.equal(await p, true);
  world.slow = 0;
  assert.equal(store.house.getHouse().removingPath, null);
  const del = world.calls.find((c) => c.method === 'DELETE' && c.path.startsWith('/api/house/drill'))!;
  assert.equal(decodeURIComponent(del.path.split('path=')[1]!), path);
  const r = store.house.getHouse().removedDrill!;
  assert.equal(r.message, 'Removed mine.');
  world.calls.length = 0;
  await store.house.undoRemoveDrill();
  const post = world.calls.find((c) => c.method === 'POST' && c.path === '/api/house/drill')!;
  assert.deepEqual(post.body, { name: 'mine', description: 'Does a thing. Use when: asked.', body: 'Body.', replace: true });
  assert.equal(store.house.getHouse().removedDrill, null);
  assert.match(store.house.getHouse().notice, /^Put mine back\. It is not approved and it is off\./);
  assert.equal(store.house.getHouse().focusPath, path, 'the restored row is found and focused');
});

test('B9: a refused Remove says why, a failed Undo stays on offer, and a shipped drill is refused by the core', async () => {
  await fresh();
  world.drillText = '---\nname: mine\ndescription: D.\n---\n\nB.\n';
  assert.equal(await store.house.removeDrill('skills/review/x/SKILL.md', 'x'), false);
  assert.match(store.house.getHouse().drillError ?? '', /^x: .*ships with the app/);
  assert.equal(store.house.getHouse().removedDrill, null);
  assert.equal(await store.house.removeDrill('skills/yours/mine/SKILL.md', 'mine'), true);
  assert.equal(store.house.getHouse().drillError, null);
  world.failRestore = true;
  await store.house.undoRemoveDrill();
  assert.match(store.house.getHouse().removedDrill!.error ?? '', /^Undo failed: .* Try again\.$/);
  world.failRestore = false;
  await store.house.undoRemoveDrill();
  assert.equal(store.house.getHouse().removedDrill, null);
  store.house.dismissRemovedDrill();
});

test('M3: revealDrill marks the drill and asks for focus on it, once', async () => {
  await fresh();
  store.house.revealDrill('skills/yours/mine/SKILL.md');
  assert.deepEqual([store.house.getHouse().justAdded, store.house.getHouse().focusPath], ['skills/yours/mine/SKILL.md', 'skills/yours/mine/SKILL.md']);
  store.house.clearFocusPath();
  assert.equal(store.house.getHouse().focusPath, null);
});

test('item 19: a new skill starts off and its row says so with a Turn on; an edit does not say it; any state change clears it', async () => {
  await fresh();
  await store.saveSkill({ name: 'brand-new', description: 'D.', whenToUse: '', body: 'B' });
  assert.equal(skill('legion-armory:brand-new').state, 'off');
  assert.equal(getArmory().savedOff, 'legion-armory:brand-new');
  await store.saveSkill({ name: 'brand-new', description: 'D2.', whenToUse: '', body: 'B' });
  assert.equal(getArmory().savedOff, null, 'saving over an existing skill is not "just created"');
  await store.saveSkill({ name: 'second', description: 'D.', whenToUse: '', body: 'B' });
  assert.equal(await store.setSkillState('legion-armory:second', 'on'), true);
  assert.equal(getArmory().savedOff, null, 'Turn on (a state change) closes the line');
  assert.equal(skill('legion-armory:second').state, 'on');
});

test('item 16: after Undo of a Remove the restored row is asked to take focus, once', async () => {
  await fresh();
  store.clearFocusRow();
  assert.equal(await store.removeSkill('legion-armory:mine'), true);
  assert.equal(getArmory().focusRow, null);
  await store.undoRemove();
  assert.equal(getArmory().focusRow, 'legion-armory:mine');
  store.clearFocusRow();
  assert.equal(getArmory().focusRow, null);
});

test('network: the agents panel asks once for every agent (counts), a failure shows on each agent, and a late answer for an older call is dropped', async () => {
  await fresh();
  world.eff = { alpha: { delay: 0, counts: 3 }, beta: { delay: 0, counts: 50 } };
  world.calls.length = 0;
  await store.loadEffectiveAll(['alpha', 'beta']);
  assert.equal(world.calls.filter((c) => c.path.startsWith('/api/armory/effective')).length, 1, 'one request, not one per agent');
  assert.equal(world.calls.at(-1)!.path, '/api/armory/effective-all');
  assert.equal(getArmory().effective.alpha!.data!.counts.total, 3);
  assert.equal(getArmory().effective.beta!.data!.counts.total, 50);
  world.failEffAll = true;
  await store.loadEffectiveAll(['alpha', 'beta']);
  assert.deepEqual(['alpha', 'beta'].map((a) => getArmory().effective[a]!.status), ['error', 'error']);
  world.failEffAll = false;
  await store.loadEffectiveAll(['alpha', 'gone']);
  assert.equal(getArmory().effective.gone!.status, 'error', 'an agent the core did not list says so');
});

test('network: Doctrine read on entry takes a fresh answer or a read already under way; a caller that changed something always asks', async () => {
  await fresh();
  const reads = (): number => world.calls.filter((c) => c.path === '/api/house').length;
  const before = reads();
  await Promise.all([store.house.loadHouse({ maxAgeMs: 0 }), store.house.loadHouse({ maxAgeMs: 0 })]);
  assert.equal(reads() - before, 1, 'two entry reads at once are one request');
  await store.house.loadHouse({ maxAgeMs: 5000 });
  assert.equal(reads() - before, 1, 'a fresh answer is taken as it is');
  await store.house.loadHouse();
  assert.equal(reads() - before, 2, 'after a change the screen always asks again');
  // Promote read it for the owner and then opens Doctrine: that read counts as fresh
  await store.promoteSkill('mine-cc');
  const afterPromote = reads();
  store.house.markHouseFresh();
  await store.house.loadHouse({ maxAgeMs: 5000 });
  assert.equal(reads(), afterPromote, 'Promote then Open Doctrine is the one request');
});
