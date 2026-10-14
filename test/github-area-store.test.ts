/**
 * GitHub area store against a fake core (no network, a stub `window`): the races, the rollbacks, the sign-in run token and the one link helper.
 * The store is UI code with bundler-style imports, so it is bundled with esbuild the way the app bundles it, then imported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { tempDir } from './tmp-cleanup.js';

const opened: string[] = [];
const unref = <T>(t: T): T => { (t as unknown as { unref?: () => void }).unref?.(); return t; };
const listeners: Record<string, ((e: unknown) => void)[]> = {};
const win = {
  location: { search: '' },
  legion: { openExternal: (u: string) => { opened.push(u); }, connectorConnect: undefined as undefined | (() => Promise<{ ok: boolean; error?: string; cancelled?: boolean }>) },
  setInterval: (f: () => void, ms: number) => unref(setInterval(f, ms)),
  clearInterval: (t: ReturnType<typeof setInterval>) => clearInterval(t),
  setTimeout: (f: () => void, ms: number) => unref(setTimeout(f, ms)),
  clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
  addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
  dispatchEvent: (e: { type: string }) => { for (const fn of listeners[e.type] ?? []) fn(e); return true; },
};
(globalThis as unknown as { window: unknown }).window = win;

type Reply = { status: number; body: unknown };
const calls: { method: string; path: string; body?: unknown }[] = [];
let core: (method: string, path: string, body: unknown) => Reply | Promise<Reply> = () => ({ status: 200, body: {} });
let down = false;
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }): Promise<Response> => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, path, ...(body ? { body } : {}) });
  if (down) throw new TypeError('fetch failed');
  const r = await core(method, path, body);
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const defer = <T>(): { p: Promise<T>; ok: (v: T) => void } => { let ok!: (v: T) => void; const p = new Promise<T>((r) => { ok = r; }); return { p, ok }; };

interface Row { fullName: string; ticked: boolean; private: boolean; installedRead: boolean; installedWrite: boolean; htmlUrl: string; installationSettingsUrl: string }
interface View { registered: { read: boolean; write: boolean }; signedIn: { read: boolean; write: boolean }; login?: string; agentsEnabled: boolean; selection: string; repos: Row[]; truncated: boolean; activity: unknown[]; problem?: { kind: string } }
const row = (n: string, ticked = false): Row => ({ fullName: `dnh33/${n}`, ticked, private: true, installedRead: true, installedWrite: false, htmlUrl: `https://github.com/dnh33/${n}`, installationSettingsUrl: 'https://github.com/settings/installations/1' });
const view = (o: Partial<View> = {}): View => ({ registered: { read: true, write: true }, signedIn: { read: true, write: false }, login: 'dnh33', agentsEnabled: true, selection: 'selected', repos: [row('a'), row('b')], truncated: false, activity: [], ...o });
const ok = (body: unknown): Reply => ({ status: 200, body });
type Gate = ReturnType<typeof defer<Reply>>;

interface Store {
  getGithub(): { picker: { query: string; loading: boolean; data: Record<string, { rows: { id: number; installed: boolean }[] } | undefined>; loadError: string | null; sending: Record<string, number | undefined>; errors: Record<string, string> } | null; view: View | null; why: string | null; signingIn: boolean; flow: unknown; writeFlow: unknown; busy: string | null; ticking: string[]; agentsSending: boolean; writeRevokeUrl: string | null };
  loadArea(force?: boolean): Promise<void>;
  initGithub(): void;
  openGithubArea(repo?: string): void;
  setTick(repo: string, on: boolean): Promise<void>;
  setAgentsEnabled(on: boolean): Promise<void>;
  connectRead(): Promise<void>;
  cancelSignIn(): void;
  pollSignIn(): Promise<void>;
  connectWrite(): Promise<void>;
  cancelWriteSignIn(): void;
  disconnectWrite(): Promise<void>;
  createRepo(b: { name: string; private: boolean; readme: boolean; tick: boolean }): Promise<{ ok: boolean; kind?: string }>;
  watchInCi(repo: string): Promise<void>;
  openAtGithub(url: string): boolean;
  getCi(): { panelOpen: boolean };
  getApp(): { toasts: { text: string; kind: string }[] };
  openPicker(): void;
  closePicker(): void;
  setPickerQuery(q: string): void;
  loadPicker(): Promise<void>;
  setPickerRepo(app: 'read' | 'write', id: number, on: boolean): Promise<void>;
}
const dir = tempDir('legion-github-store-');
const entry = join(dir, 'entry.ts');
const rel = (p: string): string => join(process.cwd(), p).replace(/\\/g, '/');
writeFileSync(entry, `export * from '${rel('ui/src/github/githubStore.ts')}';\nexport { openGithubArea } from '${rel('ui/src/github/openArea.ts')}';
export { getCi } from '${rel('ui/src/ci/ciStore.ts')}';\nexport { getState as getApp } from '${rel('ui/src/store.ts')}';\n`);
const out = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
writeFileSync(join(dir, 'store.mjs'), out.outputFiles[0]!.text);
const S = await import(pathToFileURL(join(dir, 'store.mjs')).href) as Store;
const gh = S.getGithub;
const pk = (): NonNullable<ReturnType<Store['getGithub']>['picker']> => gh().picker!;
const toasts = (): string[] => S.getApp().toasts.map((t) => t.text);
const ticked = (): Record<string, boolean> => Object.fromEntries(gh().view!.repos.map((r) => [r.fullName, r.ticked]));

const fresh = async (v: View = view()): Promise<void> => {
  calls.length = 0; opened.length = 0; down = false;
  core = (_m, p) => (p.startsWith('/api/github/area') ? ok(v) : ok({}));
  await S.loadArea(true);
  calls.length = 0;
};

test('watchInCi: a failed save says why and does not open the CI panel', async () => {
  await fresh();
  core = (m, p) => (m === 'PUT' && p === '/api/ci/repo' ? { status: 400, body: { error: 'Use owner/name.' } } : ok({}));
  await S.watchInCi('dnh33/a');
  assert.ok(toasts().includes('Use owner/name.'), `toasts: ${toasts().join(' | ')}`);
  assert.equal(S.getCi().panelOpen, false);
});

test('loadArea: a 403 with a cached view keeps the real problem and shows the plain message; only an unreachable core is "network"', async () => {
  await fresh(view({ problem: { kind: 'auth-expired' } }));
  core = () => ({ status: 403, body: { error: 'GitHub says you cannot do that.' } });
  await S.loadArea(true);
  assert.equal(gh().view!.problem?.kind, 'auth-expired');
  assert.equal(gh().why, 'GitHub says you cannot do that.');
  core = () => ({ status: 500, body: { error: 'Something broke in the core.' } });
  await S.loadArea(true);
  assert.equal(gh().view!.problem?.kind, 'auth-expired');
  down = true;
  await S.loadArea(true);
  assert.equal(gh().view!.problem?.kind, 'network');
  down = false;
});

test('loadArea: a slow old reply never overwrites a newer one', async () => {
  await fresh();
  const slow = defer<Reply>();
  let n = 0;
  core = () => (n++ === 0 ? slow.p : ok(view({ repos: [row('a'), row('b'), row('new')] })));
  const first = S.loadArea(true);
  await S.loadArea(true);
  slow.ok(ok(view({ repos: [row('old')] })));
  await first;
  assert.deepEqual(gh().view!.repos.map((r) => r.fullName), ['dnh33/a', 'dnh33/b', 'dnh33/new']);
});

test('setTick: a read that was sent earlier does not undo the optimistic toggle', async () => {
  await fresh();
  const slowRead = defer<Reply>();
  const tickReply = defer<Reply>();
  core = (m, p) => (m === 'GET' ? slowRead.p : p.includes('/tick') ? tickReply.p : ok({}));
  const read = S.loadArea(true);
  const tick = S.setTick('dnh33/a', true);
  slowRead.ok(ok(view()));
  await read;
  assert.equal(ticked()['dnh33/a'], true);
  tickReply.ok(ok(view({ repos: [row('a', true), row('b')] })));
  await tick;
  assert.equal(ticked()['dnh33/a'], true);
});

test('setTick: one request per repo at a time, and the switch says it is sending', async () => {
  await fresh();
  const reply = defer<Reply>();
  core = () => reply.p;
  const one = S.setTick('dnh33/a', true);
  void S.setTick('dnh33/a', false);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
  assert.deepEqual(gh().ticking, ['dnh33/a']);
  reply.ok(ok(view({ repos: [row('a', true), row('b')] })));
  await one;
  assert.deepEqual(gh().ticking, []);
});

test('setTick: the reply of the core is the new view, as it is', async () => {
  await fresh();
  core = () => ok(view({ repos: [row('a', true), row('b'), row('c')], problem: { kind: 'rate-limited' } }));
  await S.setTick('dnh33/a', true);
  assert.deepEqual(gh().view!.repos.map((r) => r.fullName), ['dnh33/a', 'dnh33/b', 'dnh33/c']);
  assert.equal(gh().view!.problem?.kind, 'rate-limited');
});

test('setTick: a failure rolls back that repo only', async () => {
  await fresh();
  const a: Gate = defer<Reply>();
  const b: Gate = defer<Reply>();
  core = (_m, p) => (p.includes('/dnh33/a/') ? a.p : b.p);
  const ta = S.setTick('dnh33/a', true);
  const tb = S.setTick('dnh33/b', true);
  b.ok(ok(view({ repos: [row('a', true), row('b', true)] })));
  await tb;
  a.ok({ status: 500, body: { error: 'The disk is full.' } });
  await ta;
  assert.deepEqual(ticked(), { 'dnh33/a': false, 'dnh33/b': true });
  assert.ok(toasts().includes('The disk is full.'));
});

test('setAgentsEnabled: one request at a time, rolls back on a failure', async () => {
  await fresh();
  const reply = defer<Reply>();
  core = () => reply.p;
  const one = S.setAgentsEnabled(false);
  void S.setAgentsEnabled(true);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
  assert.equal(gh().agentsSending, true);
  reply.ok({ status: 500, body: { error: 'The switch did not save.' } });
  await one;
  assert.equal(gh().view!.agentsEnabled, true);
  assert.equal(gh().agentsSending, false);
});

test('sign-in: a Cancel then Connect is not cleared by the first run ending', async () => {
  await fresh();
  const runs: ReturnType<typeof defer<{ ok: boolean; cancelled?: boolean }>>[] = [];
  win.legion.connectorConnect = () => { const d = defer<{ ok: boolean; cancelled?: boolean }>(); runs.push(d); return d.p; };
  core = (_m, p) => (p === '/api/connectors/github' ? ok({ flow: { phase: 'pending', userCode: 'AB-12', verificationUri: 'https://github.com/login/device' } }) : p.startsWith('/api/github/area') ? ok(view()) : ok({}));
  const first = S.connectRead();
  S.cancelSignIn();
  const second = S.connectRead();
  assert.equal(runs.length, 2);
  runs[0]!.ok({ ok: false, cancelled: true });
  await first;
  assert.equal(gh().signingIn, true, 'the second sign-in is still waiting');
  runs[1]!.ok({ ok: true });
  await second;
  assert.equal(gh().signingIn, true, 'the app only started the flow; the wait goes on until the core says signed in');
  S.cancelSignIn();
  win.legion.connectorConnect = undefined;
});

test('sign-in: the code stays on screen after the app opens github.com, until the core says signed in (mutation: clear the flow when the app call returns)', async () => {
  await fresh(view({ signedIn: { read: false, write: false } }));
  let status: unknown = { signedIn: false, flow: { phase: 'pending', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device' } };
  // the real desktop call starts the flow, opens the page and returns at once
  win.legion.connectorConnect = async () => ({ ok: true });
  core = (_m, p) => (p === '/api/connectors/github' ? ok(status) : p.startsWith('/api/github/area') ? ok(view({ signedIn: { read: false, write: false } })) : ok({}));
  await S.connectRead();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(gh().signingIn, true);
  assert.equal((gh().flow as { userCode?: string } | null)?.userCode, 'WDJB-MJHT', 'the code is shown right away');
  status = { signedIn: true, flow: { phase: 'idle' } };
  await S.pollSignIn();
  assert.equal(gh().signingIn, false);
  assert.equal(gh().flow, null);
  win.legion.connectorConnect = undefined;
});

test('sign-in: a failed or expired flow ends the wait and says why', async () => {
  await fresh(view({ signedIn: { read: false, write: false } }));
  win.legion.connectorConnect = async () => ({ ok: true });
  core = (_m, p) => (p === '/api/connectors/github' ? ok({ signedIn: false, flow: { phase: 'failed', reason: 'expired', message: 'The code ran out. Connect again.' } }) : p.startsWith('/api/github/area') ? ok(view({ signedIn: { read: false, write: false } })) : ok({}));
  await S.connectRead();
  await S.pollSignIn();
  assert.equal(gh().signingIn, false);
  assert.ok(toasts().includes('The code ran out. Connect again.'), `toasts: ${toasts().join(' | ')}`);
  win.legion.connectorConnect = undefined;
});

test('createRepo: a needs-write reply reads the area again, so the form falls back to Connect', async () => {
  await fresh(view({ signedIn: { read: true, write: true } }));
  core = (m) => (m === 'POST' ? ok({ phase: 'needs-write', message: 'Turn on writes first.' }) : ok(view({ signedIn: { read: true, write: false } })));
  const r = await S.createRepo({ name: 'x', private: true, readme: false, tick: false });
  assert.equal(r.kind, 'sign-in');
  assert.ok(calls.some((c) => c.method === 'GET' && c.path.startsWith('/api/github/area')), 'area was not read again');
  assert.equal(gh().view!.signedIn.write, false);
});

test('openAtGithub: only https://github.com opens; anything else says so', async () => {
  await fresh();
  assert.equal(S.openAtGithub('https://github.com/dnh33/a'), true);
  for (const u of ['https://evil.example/x', 'https://github.com.evil.example/', 'http://github.com/a', 'javascript:alert(1)', 'not a url', 'https://github.com@evil.example/']) assert.equal(S.openAtGithub(u), false, u);
  assert.deepEqual(opened, ['https://github.com/dnh33/a']);
  assert.ok(toasts().some((t) => /github\.com/.test(t)));
});

test('connectWrite: while a write sign-in code is open it does not start a second one', async () => {
  await fresh();
  core = (_m, p) => (p === '/api/github/apps/write/connect' ? ok({ phase: 'pending', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 600000 }) : p.startsWith('/api/github/area') ? ok(view()) : ok({}));
  await S.connectWrite();
  assert.ok(gh().writeFlow);
  await S.connectWrite();
  assert.equal(calls.filter((c) => c.path === '/api/github/apps/write/connect').length, 1);
  S.cancelWriteSignIn();
  await sleep(10);
});

test('disconnectWrite: keeps the revoke link the core sent', async () => {
  await fresh(view({ signedIn: { read: true, write: true } }));
  core = (_m, p) => (p === '/api/github/apps/write/disconnect' ? ok({ ok: true, revokeUrl: 'https://github.com/settings/applications' }) : ok(view()));
  await S.disconnectWrite();
  assert.equal(gh().writeRevokeUrl, 'https://github.com/settings/applications');
});

test('openGithubArea: the agent editor and project page open the area on that repo through the started store (mutation: no listener in initGithub)', async () => {
  await fresh();
  S.initGithub();
  S.openGithubArea('dnh33/a');
  const g = gh() as unknown as { open: boolean; expanded: string | null };
  assert.equal(g.open, true);
  assert.equal(g.expanded, 'dnh33/a');
});

/* ---------- choose repos ---------- */
const rowsFor = (installed: number[]) => [1, 2, 3].map((id) => ({ id, fullName: `dnh33/r${id}`, private: true, admin: true, installed: installed.includes(id) }));
const pickerBody = (installed: number[], over: Record<string, unknown> = {}) => ({ phase: 'ready', installationId: 11, selection: 'selected', account: 'dnh33', rows: rowsFor(installed), seesUninstalled: true, installUrl: 'https://github.com/apps/legion-read/installations/new', truncated: false, ...over });
const bothSignedIn = (): View => view({ signedIn: { read: true, write: true } });
const pickerCore = (state: Record<string, number[]> = { read: [1], write: [] }) => (m: string, p: string): Reply => {
  const list = /^\/api\/github\/apps\/(read|write)\/repos/.exec(p);
  if (m === 'GET' && list) return ok(pickerBody(state[list[1]!]!));
  if (p.startsWith('/api/github/area')) return ok(bothSignedIn());
  return ok({ ok: true });
};
const apiCalls = (): string[] => calls.filter((c) => c.path.startsWith('/api/github/apps/')).map((c) => `${c.method} ${c.path}`);

test('picker: opening it reads each signed-in App with the search; the read App alone when writes are off', async () => {
  await fresh(bothSignedIn());
  core = pickerCore();
  S.openPicker();
  await sleep(10);
  assert.deepEqual(apiCalls(), ['GET /api/github/apps/read/repos', 'GET /api/github/apps/write/repos']);
  assert.equal(pk().loading, false);
  assert.deepEqual(pk().data.read!.rows.map((r) => r.installed), [true, false, false]);
  S.closePicker();
  await fresh();
  core = pickerCore();
  S.openPicker();
  await sleep(10);
  assert.deepEqual(apiCalls(), ['GET /api/github/apps/read/repos']);
  S.closePicker();
});

test('picker: a tick is sent at once (PUT), shows busy for that box, blocks a second change on that App only, then refreshes the area', async () => {
  await fresh(bothSignedIn());
  core = pickerCore();
  S.openPicker();
  await sleep(10);
  calls.length = 0;
  const hold = defer<Reply>();
  core = (m, p) => (m === 'PUT' && p === '/api/github/apps/read/repos/2' ? hold.p : pickerCore()(m, p));
  const one = S.setPickerRepo('read', 2, true);
  assert.deepEqual(apiCalls(), ['PUT /api/github/apps/read/repos/2']);
  assert.equal(pk().sending.read, 2);
  assert.equal(pk().data.read!.rows.find((r) => r.id === 2)!.installed, true, 'shown ticked while it is sent');
  void S.setPickerRepo('read', 3, true);
  assert.equal(apiCalls().length, 1, 'one change at a time on an App');
  const other = S.setPickerRepo('write', 3, true);
  assert.equal(apiCalls().length, 2, 'the other App is free');
  hold.ok(ok({ ok: true }));
  await Promise.all([one, other]);
  assert.deepEqual(pk().sending, {});
  assert.ok(calls.some((c) => c.path.startsWith('/api/github/area')), 'the area list is read again');
  await S.setPickerRepo('read', 2, false);
  assert.ok(apiCalls().includes('DELETE /api/github/apps/read/repos/2'));
  S.closePicker();
});

test('picker: a failed tick rolls back that box only and puts the plain reason under that row', async () => {
  await fresh(bothSignedIn());
  core = pickerCore();
  S.openPicker();
  await sleep(10);
  core = (m, p) => (m === 'PUT' ? { status: 403, body: { error: 'You need to be an admin of that repo to add it.' } } : pickerCore()(m, p));
  await S.setPickerRepo('read', 2, true);
  assert.deepEqual(pk().data.read!.rows.map((r) => r.installed), [true, false, false]);
  assert.equal(pk().errors['read:2'], 'You need to be an admin of that repo to add it.');
  assert.deepEqual(pk().sending, {});
  // the next try clears the reason
  core = pickerCore();
  await S.setPickerRepo('read', 2, true);
  assert.equal(pk().errors['read:2'], undefined);
  assert.equal(pk().data.read!.rows[1]!.installed, true);
  S.closePicker();
});

test('picker: a list read that arrives while a tick is being sent does not undo it, and a late reply after Done is dropped', async () => {
  await fresh(bothSignedIn());
  core = pickerCore();
  S.openPicker();
  await sleep(10);
  const hold = defer<Reply>();
  const slowList = defer<Reply>();
  core = (m, p) => (m === 'PUT' ? hold.p : m === 'GET' && p.startsWith('/api/github/apps/read/') ? slowList.p : pickerCore()(m, p));
  const tick = S.setPickerRepo('read', 2, true);
  const reload = S.loadPicker();
  slowList.ok(ok(pickerBody([1])));
  await sleep(5);
  assert.equal(pk().data.read!.rows.find((r) => r.id === 2)!.installed, true, 'the pending tick stays on top of an older list');
  hold.ok(ok({ ok: true }));
  await Promise.all([tick, reload]);
  // a reply that lands after Done changes nothing
  const late = defer<Reply>();
  core = () => late.p;
  const pending = S.loadPicker();
  S.closePicker();
  late.ok(ok(pickerBody([1])));
  await pending;
  assert.equal(gh().picker, null);
});

test('picker: a reply the core could not have sent says so and shows no rows; the search asks the core after a pause', async () => {
  await fresh();
  core = () => ok({ phase: 'ready' });
  S.openPicker();
  await sleep(10);
  assert.equal(pk().loadError, 'Legion sent a reply it could not read.');
  core = pickerCore();
  calls.length = 0;
  S.setPickerQuery('r');
  S.setPickerQuery('r2');
  assert.equal(apiCalls().length, 0, 'not while typing');
  await sleep(320);
  assert.deepEqual(apiCalls(), ['GET /api/github/apps/read/repos?q=r2']);
  assert.equal(pk().loadError, null);
  S.closePicker();
});

test('picker: after an unsure failure (5xx or no answer) the list is read again, since GitHub may have made the change; a plain refusal (4xx) is not (mutation: never re-read)', async () => {
  await fresh(bothSignedIn());
  core = pickerCore();
  S.openPicker();
  await sleep(10);
  calls.length = 0;
  core = (m, p) => (m === 'PUT' ? { status: 502, body: { error: 'Could not reach GitHub. Check the repo list before you try again.' } } : pickerCore()(m, p));
  await S.setPickerRepo('read', 2, true);
  await sleep(10);
  assert.ok(apiCalls().includes('GET /api/github/apps/read/repos'), `calls: ${apiCalls().join(' | ')}`);
  calls.length = 0;
  core = (m, p) => (m === 'PUT' ? { status: 403, body: { error: 'You need to be an admin of that repo to add it.' } } : pickerCore()(m, p));
  await S.setPickerRepo('read', 2, true);
  await sleep(10);
  assert.ok(!apiCalls().includes('GET /api/github/apps/read/repos'), 'a refusal does not re-read');
  S.closePicker();
});
