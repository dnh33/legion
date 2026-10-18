// test/folder-trust-gates.test.ts: the trust record for folders (security finding H1) through the real gates routes.
// Adding a folder is a loosening: it needs the app's native confirm and the digest of what the dialog showed, and the dialog names the exact commands.
// Removing one tightens: no native, no dialog. The core scans the folder itself; the window only names a path.
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGatesCore, createGatesModule } from '../src/core/gates-settings/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { scanFolder } from '../src/core/folder-trust.js';
import { AUTH, makeFakes, start } from './helpers-c.js';

const J = { 'Content-Type': 'application/json' };
const NATIVE = 'native-secret';
const KEYRING = { get: () => Buffer.alloc(32, 9) };
const DIGEST = 'x-legion-gates-digest';
const SECRET = 'ZZ-ENV-VALUE-77aa1';

const put = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
function repoWith(settings: unknown): string {
  const repo = cleanupTemp('legion-trust-repo-');
  mkdirSync(join(repo, '.git'), { recursive: true });
  put(join(repo, '.claude', 'settings.json'), JSON.stringify(settings));
  return repo;
}
const HOOKS = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node mark-it.js' }] }] }, env: { MY_TOKEN: SECRET } };

async function boot(o: { keyed?: boolean } = { keyed: true }) {
  const root = cleanupTemp('legion-trust-gates-');
  const data = join(root, 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const f = makeFakes({ holdRuns: true });
  const deps = { config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false };
  const core = createGatesCore({ dataDir: data, projects, ...(o.keyed === false ? {} : { keyring: KEYRING }) });
  const mod = createGatesModule(deps, { projects, core, nativeSecret: NATIVE });
  (f.ctx as { modules?: unknown }).modules = [mod];
  const s = await start(f.ctx);
  const call = (headers: Record<string, string>) => (m: string, path: string, body?: unknown) =>
    fetch(s.base + path, { method: m, headers: { ...headers, ...J }, body: body === undefined ? undefined : JSON.stringify(body) });
  const admin = call(AUTH);
  const preview = async (patch: unknown) => (await (await admin('POST', '/api/gates/preview', { name: 'app', patch })).json()) as { loosening: string[]; loosens: boolean; digest: string; error?: string };
  /** What the app does for a confirmed change. */
  const confirmed = async (patch: unknown, digest?: string) => admin_native('PATCH', '/api/gates/app', patch, digest ?? (await preview(patch)).digest);
  const admin_native = (m: string, path: string, body: unknown, digest?: string) =>
    fetch(s.base + path, { method: m, headers: { ...AUTH, ...J, 'X-Legion-Native': NATIVE, ...(digest ? { [DIGEST]: digest } : {}) }, body: JSON.stringify(body) });
  return { core, data, admin, preview, confirmed, admin_native, close: async () => { await mod.dispose?.(); await s.close(); } };
}

test('trusting a folder needs the native confirm: 403 without it, whatever the digest', async () => {
  const r = await boot();
  const repo = repoWith(HOOKS);
  try {
    const pv = await r.preview({ trustFolder: repo });
    assert.equal(pv.loosens, true);
    const res = await r.admin('PATCH', '/api/gates/app', { trustFolder: repo });
    assert.equal(res.status, 403);
    assert.deepEqual(r.core.trustedFolders(), []);
  } finally { await r.close(); }
});

test('the dialog lines name the folder and the exact commands, and no environment value', async () => {
  const r = await boot();
  const repo = repoWith(HOOKS);
  try {
    const pv = await r.preview({ trustFolder: repo });
    const text = pv.loosening.join('\n');
    assert.ok(text.includes(scanFolder(repo).folder), 'the folder');
    assert.match(text, /Hook PreToolUse \(command\) in \.claude\/settings\.json runs: node mark-it\.js/);
    assert.match(text, /MY_TOKEN/);
    assert.equal(text.includes(SECRET), false, 'no value');
  } finally { await r.close(); }
});

test('native + the previewed digest trusts the folder; the record holds the real path and the fingerprint', async () => {
  const r = await boot();
  const repo = repoWith(HOOKS);
  try {
    const res = await r.confirmed({ trustFolder: repo });
    assert.equal(res.status, 200);
    const scan = scanFolder(repo);
    assert.deepEqual(r.core.trustedFolders(), [{ folder: scan.folder, digest: scan.digest }]);
    assert.equal(JSON.stringify(await res.json()).includes(SECRET), false);
  } finally { await r.close(); }
});

test('the folder changed between the dialog and Confirm: the digest no longer fits and nothing is trusted', async () => {
  const r = await boot();
  const repo = repoWith(HOOKS);
  try {
    const pv = await r.preview({ trustFolder: repo });
    put(join(repo, '.claude', 'settings.json'), JSON.stringify({ ...HOOKS, apiKeyHelper: 'steal.sh' }));
    const res = await r.admin_native('PATCH', '/api/gates/app', { trustFolder: repo }, pv.digest);
    assert.equal(res.status, 409);
    assert.deepEqual(r.core.trustedFolders(), []);
  } finally { await r.close(); }
});

test('a folder with nothing to trust is refused: there is nothing to put on the list', async () => {
  const r = await boot();
  const repo = repoWith({ permissions: { deny: ['Bash(rm:*)'] } });
  try {
    const res = await r.admin('POST', '/api/gates/preview', { name: 'app', patch: { trustFolder: repo } });
    assert.equal(res.status, 400);
    assert.match(String(((await res.json()) as { error: string }).error), /nothing/i);
  } finally { await r.close(); }
});

test('a folder that does not exist is refused', async () => {
  const r = await boot();
  try {
    const res = await r.admin('POST', '/api/gates/preview', { name: 'app', patch: { trustFolder: join(r.data, 'no-such-folder') } });
    assert.equal(res.status, 400);
  } finally { await r.close(); }
});

test('without a key to sign with, nothing can be trusted', async () => {
  const r = await boot({ keyed: false });
  const repo = repoWith(HOOKS);
  try {
    const res = await r.admin_native('PATCH', '/api/gates/app', { trustFolder: repo }, (await r.preview({ trustFolder: repo })).digest);
    assert.equal(res.status, 400);
    assert.deepEqual(r.core.trustedFolders(), []);
  } finally { await r.close(); }
});

test('removing a trusted folder needs no native and no digest', async () => {
  const r = await boot();
  const repo = repoWith(HOOKS);
  try {
    assert.equal((await r.confirmed({ trustFolder: repo })).status, 200);
    const folder = r.core.trustedFolders()[0]!.folder;
    const pv = await r.preview({ untrustFolder: folder });
    assert.equal(pv.loosens, false);
    const res = await r.admin('PATCH', '/api/gates/app', { untrustFolder: folder });
    assert.equal(res.status, 200);
    assert.deepEqual(r.core.trustedFolders(), []);
  } finally { await r.close(); }
});

test('trusting again after the content changed replaces the old record (one record per folder)', async () => {
  const r = await boot();
  const repo = repoWith(HOOKS);
  try {
    assert.equal((await r.confirmed({ trustFolder: repo })).status, 200);
    put(join(repo, '.claude', 'settings.json'), JSON.stringify({ ...HOOKS, apiKeyHelper: 'x.sh' }));
    const pv = await r.preview({ trustFolder: repo });
    assert.equal(pv.loosens, true, 'new content is a new loosening');
    assert.equal((await r.confirmed({ trustFolder: repo })).status, 200);
    const list = r.core.trustedFolders();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.digest, scanFolder(repo).digest);
  } finally { await r.close(); }
});

test('trusting a folder that is already trusted at this content changes nothing and needs no dialog', async () => {
  const r = await boot();
  const repo = repoWith(HOOKS);
  try {
    assert.equal((await r.confirmed({ trustFolder: repo })).status, 200);
    const pv = await r.preview({ trustFolder: repo });
    assert.equal(pv.loosens, false);
  } finally { await r.close(); }
});

test('the trust list survives a restart (signed), and an unsigned edit of the file is not applied', async () => {
  const r = await boot();
  const repo = repoWith(HOOKS);
  try {
    assert.equal((await r.confirmed({ trustFolder: repo })).status, 200);
    await r.core.store.flush();
    const file = join(r.data, 'gates', 'app.json');
    const again = createGatesCore({ dataDir: r.data, keyring: KEYRING });
    assert.equal(again.trustedFolders().length, 1);
    // another program adds a record by hand
    const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete j.sig;
    j.trustedFolders = [...(j.trustedFolders as unknown[]), { folder: join(r.data, 'evil'), digest: 'b'.repeat(64) }];
    writeFileSync(file, JSON.stringify(j));
    const third = createGatesCore({ dataDir: r.data, keyring: KEYRING });
    assert.deepEqual(third.trustedFolders(), [], 'an unsigned file with a looser list reads as Ask and trusts nothing');
    assert.ok(third.store.changedOutside().includes('app'));
  } finally { await r.close(); }
});

test('GET /api/gates/trusted-folders: each record with whether it still fits, and a short summary; no value', async () => {
  const r = await boot();
  const repo = repoWith(HOOKS);
  try {
    assert.equal((await r.confirmed({ trustFolder: repo })).status, 200);
    const list = (await (await r.admin('GET', '/api/gates/trusted-folders')).json()) as Array<{ folder: string; current: boolean; summary: string[] }>;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.current, true);
    assert.match(list[0]!.summary.join('\n'), /node mark-it\.js/);
    put(join(repo, '.claude', 'settings.json'), JSON.stringify({ ...HOOKS, apiKeyHelper: 'x.sh' }));
    const after = (await (await r.admin('GET', '/api/gates/trusted-folders')).json()) as Array<{ current: boolean }>;
    assert.equal(after[0]!.current, false, 'changed content: it asks again');
    assert.equal(JSON.stringify(list).includes(SECRET), false);
  } finally { await r.close(); }
});

test('a patch may not name a digest: only a path (the core works the fingerprint out itself)', async () => {
  const r = await boot();
  const repo = repoWith(HOOKS);
  try {
    const res = await r.admin('POST', '/api/gates/preview', { name: 'app', patch: { trustedFolders: [{ folder: repo, digest: 'c'.repeat(64) }] } });
    assert.equal(res.status, 400);
  } finally { await r.close(); }
});
