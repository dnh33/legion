/**
 * The first-run "Also make my agents follow this": ONE native confirm that names every agent made looser, then each change is a guarded PATCH
 * with its own digest. These tests run the REAL core and the real IPC code with a fake dialog. A cancel changes nothing at all.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { agentModeBatch, parseAgentModeBatch, resetAgentModeCancelForTests } from '../src/electron/agent-mode-ipc.js';
import type { AgentModeIpcDeps } from '../src/electron/agent-mode-ipc.js';
import { createGatesCore, createGatesModule } from '../src/core/gates-settings/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { DENY_LINE, NO_SANDBOX_LINE } from '../src/shared/gates-registry.js';
import { AUTH, makeFakes, mkAgent, start } from './helpers-c.js';

const NATIVE = 'native-secret';
const J = { 'Content-Type': 'application/json' };
const DIGEST = 'x-legion-gates-digest';
type Dialog = { title: string; message: string; detail: string; confirmLabel: string };
const IDS = ['alpha', 'bravo', 'charlie', 'delta'];
type Own = Record<string, 'ask' | 'auto-edits' | 'full'>;

async function boot(answers: boolean[] = [], own: Own = {}) {
  resetAgentModeCancelForTests();
  const data = join(cleanupTemp('legion-agent-batch-'), 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const f = makeFakes({ holdRuns: true });
  const core = createGatesCore({ dataDir: data, projects, keyring: { get: () => Buffer.alloc(32, 9) } });
  const mod = createGatesModule({ config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false }, { projects, core, nativeSecret: NATIVE });
  (f.ctx as { modules?: unknown }).modules = [mod]; (f.ctx as { agentMode?: unknown }).agentMode = mod.agentMode;
  for (const id of IDS) f.ctx.store.upsertAgent({ ...mkAgent(id, id[0]!.toUpperCase() + id.slice(1)), approval: own[id] ?? 'ask' });
  const s = await start(f.ctx);
  const dialogs: Dialog[] = [];
  const calls: Array<{ method: string; route: string; native: boolean; digest?: string }> = [];
  const http = async (method: string, route: string, body?: unknown, h: Record<string, string> = {}) => {
    const r = await fetch(s.base + route, { method, headers: { ...AUTH, ...J, ...h }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const deps: AgentModeIpcDeps = {
    async call(method, route, body, nat, extra) {
      calls.push({ method, route, native: nat === true, ...(extra?.[DIGEST] ? { digest: extra[DIGEST] } : {}) });
      return http(method, route, body, { ...(nat ? { 'X-Legion-Native': NATIVE } : {}), ...(extra ?? {}) });
    },
    async confirm(d) { dialogs.push(d); return answers.shift() ?? false; },
  };
  const modes = () => IDS.map((id) => { const a = f.ctx.store.getAgent(id)!; return `${a.approval}/${a.approvalSource ?? 'own'}`; });
  const writes = () => calls.filter((c) => c.method === 'PATCH');
  return { f, core, deps, dialogs, calls, writes, modes, http, close: async () => { await mod.dispose?.(); await s.close(); } };
}
type R = Awaited<ReturnType<typeof boot>>;
const withBoot = (answers: boolean[], fn: (r: R) => Promise<void>, own: Own = {}) => async () => { const r = await boot(answers, own); try { await fn(r); } finally { await r.close(); } };
const follow = (ids: string[]) => ({ changes: ids.map((agentId) => ({ agentId, approvalSource: 'project' as const })) });

test('parse: a list of one to a hundred distinct agents, each a plain mode change, nothing else', () => {
  assert.deepEqual(parseAgentModeBatch(follow(['a', 'b'])), follow(['a', 'b']).changes);
  const dup = follow(['a', 'a']);
  const many = follow(Array.from({ length: 101 }, (_, i) => `a${i}`));
  for (const bad of [null, [], 'x', {}, { changes: [] }, { changes: 'a' }, dup, many, { changes: [{ agentId: 'a' }] }, { changes: [{ agentId: 'a', approval: 'root' }] }, { ...follow(['a']), extra: 1 }]) {
    assert.equal(parseAgentModeBatch(bad), undefined, JSON.stringify(bad).slice(0, 80));
  }
});

test('batch: a loosening shows ONE dialog that names every agent made looser, then each change is a guarded PATCH with its own digest', withBoot([true], async (r) => {
  r.core.store.patchApp({ preset: 'smart' });
  const res = await agentModeBatch(follow(IDS), r.deps);
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.applied, IDS);
  assert.equal(r.dialogs.length, 1);
  const d = r.dialogs[0]!;
  for (const n of ['Alpha', 'Bravo', 'Charlie', 'Delta']) assert.ok(d.detail.includes(n), `${n} is named`);
  assert.equal(d.detail.split(NO_SANDBOX_LINE).length - 1, 1, 'the closing lines appear once');
  assert.equal(d.detail.split(DENY_LINE).length - 1, 1);
  assert.equal(d.confirmLabel, 'Confirm change');
  assert.doesNotMatch(JSON.stringify(d), /—/);
  const w = r.writes();
  assert.equal(w.length, 4);
  assert.ok(w.every((x) => x.native && /^[0-9a-f]{64}$/.test(x.digest ?? '')), 'native secret and a digest on every raise');
  assert.equal(new Set(w.map((x) => x.digest)).size, 4, 'each agent has its own digest');
  assert.deepEqual(r.modes(), IDS.map(() => 'ask/project'));
}));

test('batch: a tightening alone shows no dialog and sends no native secret', withBoot([true], async (r) => {
  // app preset Ask: following it can only tighten
  const res = await agentModeBatch(follow(IDS), r.deps);
  assert.equal(res.ok, true, res.error);
  assert.equal(r.dialogs.length, 0);
  assert.ok(r.writes().every((x) => !x.native));
  assert.deepEqual(r.modes(), ['full/project', 'ask/project', 'ask/project', 'ask/project'], 'alpha keeps Full as the setting it goes back to');
}, { alpha: 'full' }));

test('batch: an agent that loses nothing is not named in the dialog', withBoot([true], async (r) => {
  r.core.store.patchApp({ preset: 'smart' });
  // alpha is Full on its own: following Smart is stricter for it
  const res = await agentModeBatch(follow(IDS), r.deps);
  assert.equal(res.ok, true, res.error);
  assert.doesNotMatch(r.dialogs[0]!.detail, /Alpha/);
  assert.match(r.dialogs[0]!.detail, /Bravo/);
  assert.equal(r.writes().find((w) => w.route.endsWith('/alpha'))?.native, false, 'the tightening carries no native secret');
}, { alpha: 'full' }));

test('batch: Cancel makes no request that changes anything, tightenings included', withBoot([false], async (r) => {
  r.core.store.patchApp({ preset: 'smart' });
  const before = r.modes();
  const res = await agentModeBatch(follow(IDS), r.deps);
  assert.deepEqual([res.ok, res.cancelled, res.applied], [false, true, []]);
  assert.equal(r.writes().length, 0);
  assert.deepEqual(r.modes(), before);
}, { alpha: 'full' }));

test('batch: an agent the core cannot describe stops everything before the dialog', withBoot([true], async (r) => {
  r.core.store.patchApp({ preset: 'smart' });
  const res = await agentModeBatch({ changes: [...follow(['alpha']).changes, { agentId: 'nobody', approvalSource: 'project' }] }, r.deps);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /Unknown agent/);
  assert.equal(r.dialogs.length, 0);
  assert.equal(r.writes().length, 0);
  assert.deepEqual(r.modes(), IDS.map(() => 'ask/own'));
}));

test('batch: one change that went stale while the dialog was open is reported, the others still apply', withBoot([], async (r) => {
  r.core.store.patchApp({ preset: 'smart' });
  r.deps.confirm = async (d) => { r.dialogs.push(d); r.f.ctx.store.upsertAgent({ ...r.f.ctx.store.getAgent('bravo')!, approval: 'auto-edits' }); return true; };
  const res = await agentModeBatch(follow(IDS), r.deps);
  assert.equal(res.ok, false);
  assert.deepEqual(res.applied, ['alpha', 'charlie', 'delta']);
  assert.deepEqual(res.failed?.map((x) => x.agentId), ['bravo']);
  assert.match(res.failed![0]!.error, /changed while/);
  assert.deepEqual(r.modes(), ['ask/project', 'auto-edits/own', 'ask/project', 'ask/project']);
}));

test('batch: the same batch cannot raise a second dialog right after a cancel', withBoot([false], async (r) => {
  r.core.store.patchApp({ preset: 'smart' });
  assert.equal((await agentModeBatch(follow(IDS), r.deps)).cancelled, true);
  const again = await agentModeBatch(follow(IDS), r.deps);
  assert.match(again.error ?? '', /cancelled this change a moment ago/);
  assert.equal(r.dialogs.length, 1);
}));

test('batch: only one batch runs at a time', withBoot([], async (r) => {
  r.core.store.patchApp({ preset: 'smart' });
  let release!: (b: boolean) => void;
  r.deps.confirm = (d) => { r.dialogs.push(d); return new Promise<boolean>((res) => { release = res; }); };
  const first = agentModeBatch(follow(IDS), r.deps);
  await new Promise((res) => setTimeout(res, 200));
  const second = await agentModeBatch(follow(['alpha']), r.deps);
  assert.equal(second.ok, false);
  assert.equal(r.dialogs.length, 1);
  release(false); await first;
}));

test('batch: a core that does not answer changes nothing and says so', withBoot([true], async (r) => {
  const down = { ...r.deps, call: async () => undefined } as AgentModeIpcDeps;
  const res = await agentModeBatch(follow(IDS), down);
  assert.match(res.error ?? '', /could not reach its own core/);
  assert.equal(r.dialogs.length, 0);
}));
