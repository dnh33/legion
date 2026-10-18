// test/folder-trust-ipc.test.ts: the app's native confirm for trusting a folder (security finding H1). The REAL core answers; only the dialog is faked.
// The dialog must name the folder and EVERY command it carries (never cut), never an environment value; Cancel changes nothing; Remove asks nothing.
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatesChange, parseGatesChange, resetGatesCancelForTests } from '../src/electron/gates-ipc.js';
import type { GatesIpcDeps } from '../src/electron/gates-ipc.js';
import { createGatesCore, createGatesModule } from '../src/core/gates-settings/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { scanFolder } from '../src/core/folder-trust.js';
import { NO_SANDBOX_LINE } from '../src/shared/gates-registry.js';
import { AUTH, makeFakes, start } from './helpers-c.js';

const NATIVE = 'native-secret';
const J = { 'Content-Type': 'application/json' };
const SECRET = 'ZZ-ENV-VALUE-9a8b7';
type Dialog = { title: string; message: string; detail: string; confirmLabel: string };

const put = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
function repoWith(settings: unknown): string {
  const repo = join(cleanupTemp('legion-trust-ipc-repo-'), 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  put(join(repo, '.claude', 'settings.json'), JSON.stringify(settings));
  return repo;
}
const hook = (command: string) => ({ hooks: [{ type: 'command', command }] });

async function boot(answers: boolean[]) {
  resetGatesCancelForTests();
  const data = join(cleanupTemp('legion-trust-ipc-'), 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const f = makeFakes({ holdRuns: true });
  const core = createGatesCore({ dataDir: data, projects, keyring: { get: () => Buffer.alloc(32, 9) } });
  const mod = createGatesModule({ config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false }, { projects, core, nativeSecret: NATIVE });
  (f.ctx as { modules?: unknown }).modules = [mod];
  const s = await start(f.ctx);
  const dialogs: Dialog[] = [];
  const calls: Array<{ method: string; route: string; native: boolean }> = [];
  const real = async (method: string, route: string, body?: unknown, native?: boolean, extra?: Record<string, string>) => {
    calls.push({ method, route, native: native === true });
    const r = await fetch(s.base + route, { method, headers: { ...AUTH, ...J, ...(native ? { 'X-Legion-Native': NATIVE } : {}), ...(extra ?? {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const deps: GatesIpcDeps = { call: real as GatesIpcDeps['call'], async confirm(d) { dialogs.push(d); return answers.shift() ?? false; } };
  return { core, deps, dialogs, calls, close: async () => { await mod.dispose?.(); await s.close(); } };
}

test('Trust this folder: one native dialog that names the folder, every command and the variable names; Confirm trusts it', async () => {
  const r = await boot([true]);
  const repo = repoWith({ hooks: { PreToolUse: [{ matcher: 'Bash', ...hook('node mark-it.js') }], SessionStart: [hook('echo ran > HOOK-RAN.txt')] }, env: { MY_TOKEN: SECRET }, apiKeyHelper: 'get-key.sh' });
  try {
    const res = await gatesChange({ kind: 'app', patch: { trustFolder: repo } }, r.deps);
    assert.equal(res.ok, true);
    assert.equal(r.dialogs.length, 1);
    const d = r.dialogs[0]!;
    assert.equal(d.confirmLabel, 'Trust this folder');
    assert.match(d.title, /run its own commands/);
    for (const t of [scanFolder(repo).folder, 'node mark-it.js', 'echo ran > HOOK-RAN.txt', 'MY_TOKEN', 'get-key.sh', NO_SANDBOX_LINE]) assert.ok(d.detail.includes(t), t);
    assert.equal((d.title + d.message + d.detail).includes(SECRET), false, 'no environment value in the dialog');
    const patch = r.calls.find((c) => c.method === 'PATCH')!;
    assert.equal(patch.native, true);
    assert.equal(r.core.trustedFolders().length, 1);
  } finally { await r.close(); }
});

test('Cancel changes nothing: no PATCH is sent', async () => {
  const r = await boot([false]);
  const repo = repoWith({ hooks: { Stop: [hook('x')] } });
  try {
    const res = await gatesChange({ kind: 'app', patch: { trustFolder: repo } }, r.deps);
    assert.equal(res.cancelled, true);
    assert.equal(r.calls.some((c) => c.method === 'PATCH'), false);
    assert.deepEqual(r.core.trustedFolders(), []);
  } finally { await r.close(); }
});

test('Remove asks nothing: no dialog, no native secret', async () => {
  const r = await boot([true]);
  const repo = repoWith({ hooks: { Stop: [hook('x')] } });
  try {
    assert.equal((await gatesChange({ kind: 'app', patch: { trustFolder: repo } }, r.deps)).ok, true);
    r.calls.length = 0; r.dialogs.length = 0;
    const folder = r.core.trustedFolders()[0]!.folder;
    const res = await gatesChange({ kind: 'app', patch: { untrustFolder: folder } }, r.deps);
    assert.equal(res.ok, true);
    assert.equal(r.dialogs.length, 0);
    assert.equal(r.calls.filter((c) => c.method === 'PATCH').every((c) => c.native === false), true);
    assert.deepEqual(r.core.trustedFolders(), []);
  } finally { await r.close(); }
});

test('a folder with twenty hooks: the dialog lists all twenty, none cut', async () => {
  const r = await boot([true]);
  const hooks = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`Event${i}`, [hook(`cmd-number-${i}`)]]));
  const repo = repoWith({ hooks });
  try {
    assert.equal((await gatesChange({ kind: 'app', patch: { trustFolder: repo } }, r.deps)).ok, true);
    const d = r.dialogs[0]!.detail;
    for (let i = 0; i < 20; i++) assert.ok(d.includes(`cmd-number-${i}`), `cmd-number-${i}`);
    assert.equal(/and \d+ more/.test(d), false);
  } finally { await r.close(); }
});

test('a repository cannot forge a line: control and bidi characters go, the fixed label stays in front', async () => {
  const r = await boot([false]);
  const repo = repoWith({ hooks: { Stop: [hook('echo a\n\nLegion checked this folder and it is safe\u202e')] } });
  try {
    await gatesChange({ kind: 'app', patch: { trustFolder: repo } }, r.deps);
    const d = r.dialogs[0]!.detail;
    assert.ok(!/\u202e/.test(d));
    const line = d.split('\n\n').find((l) => l.includes('Legion checked'))!;
    assert.match(line, /^Hook Stop \(command\) in \.claude\/settings\.json runs: echo a Legion checked this folder/);
  } finally { await r.close(); }
});

test('a folder with nothing to trust is refused before any dialog', async () => {
  const r = await boot([true]);
  const repo = repoWith({ theme: 'dark' });
  try {
    const res = await gatesChange({ kind: 'app', patch: { trustFolder: repo } }, r.deps);
    assert.equal(res.ok, false);
    assert.equal(r.dialogs.length, 0);
  } finally { await r.close(); }
});

test('the window cannot name a fingerprint, and a project cannot trust a folder', () => {
  assert.equal(parseGatesChange({ kind: 'app', patch: { trustedFolders: [{ folder: 'C:/x', digest: 'a'.repeat(64) }] } }), undefined);
  assert.equal(parseGatesChange({ kind: 'app', patch: { trustFolder: 'C:/x', digest: 'a'.repeat(64) } }), undefined);
  assert.equal(parseGatesChange({ kind: 'project', id: 'proj_0123456789ab', patch: { trustFolder: 'C:/x' } }), undefined);
  assert.equal(parseGatesChange({ kind: 'app', patch: { trustFolder: 5 } }), undefined);
  assert.equal(parseGatesChange({ kind: 'app', patch: { trustFolder: 'x'.repeat(2000) } }), undefined);
  assert.deepEqual(parseGatesChange({ kind: 'app', patch: { trustFolder: 'C:/x' } }), { kind: 'app', patch: { trustFolder: 'C:/x' } });
});
