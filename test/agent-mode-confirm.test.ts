/**
 * Raising how little an agent asks needs the app's native confirm. These tests run the REAL core (the agent routes, the gates store, the
 * projects store) and the real IPC code with a fake dialog: the core refuses a raise without the native secret and the digest of the exact
 * change, accepts it with both, and lets a tightening or no change through free. The dialog names the agent and the mode in plain words.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CONFIRM_BUSY, ConfirmBusyError } from '../src/electron/confirm-window-logic.js';
import { agentModeChange, parseAgentModeChange, resetAgentModeCancelForTests } from '../src/electron/agent-mode-ipc.js';
import type { AgentModeIpcDeps } from '../src/electron/agent-mode-ipc.js';
import { createGatesCore, createGatesModule } from '../src/core/gates-settings/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { NO_SANDBOX_LINE } from '../src/shared/gates-registry.js';
import { AUTH, makeFakes, mkAgent, start } from './helpers-c.js';

const NATIVE = 'native-secret';
const J = { 'Content-Type': 'application/json' };
const DIGEST = 'x-legion-gates-digest';
type Dialog = { title: string; message: string; detail: string; confirmLabel: string };

async function boot(answers: boolean[] = [], o: { noGates?: boolean } = {}) {
  resetAgentModeCancelForTests();
  const data = join(cleanupTemp('legion-agent-mode-'), 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const f = makeFakes({ holdRuns: true });
  const proj = projects.create({ name: 'Shop' });
  const core = createGatesCore({ dataDir: data, projects, keyring: { get: () => Buffer.alloc(32, 9) } });
  const mod = createGatesModule({ config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false }, { projects, core, nativeSecret: NATIVE });
  if (!o.noGates) { (f.ctx as { modules?: unknown }).modules = [mod]; (f.ctx as { agentMode?: unknown }).agentMode = mod.agentMode; }
  const worker = f.ctx.store.upsertAgent({ ...mkAgent('worker', 'Worker'), approval: 'ask' });
  const s = await start(f.ctx);
  const dialogs: Dialog[] = [];
  const calls: Array<{ method: string; route: string; native: boolean; digest?: string; body?: unknown }> = [];
  const http = async (method: string, route: string, body?: unknown, h: Record<string, string> = {}) => {
    const r = await fetch(s.base + route, { method, headers: { ...AUTH, ...J, ...h }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const native = { 'X-Legion-Native': NATIVE };
  const deps: AgentModeIpcDeps = {
    async call(method, route, body, nat, extra) {
      calls.push({ method, route, native: nat === true, ...(extra?.[DIGEST] ? { digest: extra[DIGEST] } : {}), ...(body !== undefined ? { body } : {}) });
      return http(method, route, body, { ...(nat ? native : {}), ...(extra ?? {}) });
    },
    async confirm(d) { dialogs.push(d); return answers.shift() ?? false; },
  };
  const preview = async (body: unknown) => (await http('POST', '/api/agents/mode-preview', body)).json as { raises: boolean; digest: string; loosening: string[]; agentName: string };
  const writes = () => calls.filter((c) => c.method === 'PATCH');
  const mode = (id = 'worker') => { const a = f.ctx.store.getAgent(id)!; return [a.approval, a.approvalSource ?? 'own']; };
  return { f, core, projects, proj, worker, http, native, deps, dialogs, calls, preview, writes, mode, close: async () => { await mod.dispose?.(); await s.close(); } };
}
type R = Awaited<ReturnType<typeof boot>>;
const withBoot = (answers: boolean[], fn: (r: R) => Promise<void>, o: { noGates?: boolean } = {}) => async () => { const r = await boot(answers, o); try { await fn(r); } finally { await r.close(); } };

// ---------------------------------------------------------------- the core

test('core: raising an agent to Full or Accept edits without the native secret is refused and nothing changes', withBoot([], async (r) => {
  for (const approval of ['full', 'auto-edits']) {
    const res = await r.http('PATCH', '/api/agents/worker', { approval, approvalSource: 'own' });
    assert.equal(res.status, 403, approval);
    assert.match(String(res.json.error), /native_confirmation_required/);
  }
  assert.deepEqual(r.mode(), ['ask', 'own']);
  // the admin secret alone, a wrong native secret: both refused
  assert.equal((await r.http('PATCH', '/api/agents/worker', { approval: 'full' }, { 'X-Legion-Native': 'guess' })).status, 403);
  assert.deepEqual(r.mode(), ['ask', 'own']);
}));

test('core: with the native secret a raise still needs the digest of this exact change', withBoot([], async (r) => {
  const noDigest = await r.http('PATCH', '/api/agents/worker', { approval: 'full' }, r.native);
  assert.equal(noDigest.status, 409);
  const other = await r.preview({ agentId: 'worker', approval: 'auto-edits' });
  const wrong = await r.http('PATCH', '/api/agents/worker', { approval: 'full' }, { ...r.native, [DIGEST]: other.digest });
  assert.equal(wrong.status, 409, 'the digest of Accept edits does not allow Full');
  assert.deepEqual(r.mode(), ['ask', 'own']);
  const pv = await r.preview({ agentId: 'worker', approval: 'full' });
  assert.equal(pv.raises, true);
  const ok = await r.http('PATCH', '/api/agents/worker', { approval: 'full' }, { ...r.native, [DIGEST]: pv.digest });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(r.mode(), ['full', 'own']);
}));

test('core: the digest follows the presets, so a preset that changes while the dialog is open voids the confirmation', withBoot([], async (r) => {
  r.projects.setMembers(r.proj.id, ['worker']);
  const pv = await r.preview({ agentId: 'worker', approvalSource: 'project' });
  assert.equal(pv.raises, false, 'the project has no preset and the app is Ask');
  r.core.store.patchProject(r.proj.id, { preset: 'ask' });
  const pv2 = await r.preview({ agentId: 'worker', approvalSource: 'project' });
  assert.notEqual(pv2.digest, pv.digest);
  // the owner confirms Follow project while the project is Ask, then the project is set to Bypass before the save lands
  r.core.store.patchApp({ preset: 'bypass' });
  const late = await r.http('PATCH', '/api/agents/worker', { approvalSource: 'project' }, { ...r.native, [DIGEST]: pv2.digest });
  assert.equal(late.status, 409);
  assert.deepEqual(r.mode(), ['ask', 'own']);
}));

test('core: tightening and no change need nothing', withBoot([], async (r) => {
  r.f.ctx.store.upsertAgent({ ...r.worker, approval: 'full' });
  assert.equal((await r.http('PATCH', '/api/agents/worker', { description: 'x' })).status, 200, 'no approval field');
  assert.equal((await r.http('PATCH', '/api/agents/worker', { approval: 'full', approvalSource: 'own' })).status, 200, 'the same mode');
  assert.equal((await r.http('PATCH', '/api/agents/worker', { approval: 'auto-edits' })).status, 200, 'Full to Accept edits');
  assert.equal((await r.http('PATCH', '/api/agents/worker', { approval: 'ask' })).status, 200, 'Accept edits to Ask');
  assert.deepEqual(r.mode(), ['ask', 'own']);
  // a digest sent with a change that does not raise must still match
  const pv = await r.preview({ agentId: 'worker', approval: 'ask' });
  assert.equal((await r.http('PATCH', '/api/agents/worker', { approval: 'ask' }, { [DIGEST]: pv.digest })).status, 200);
  assert.equal((await r.http('PATCH', '/api/agents/worker', { approval: 'ask' }, { [DIGEST]: '0'.repeat(64) })).status, 409);
}));

test('core: following a project is a raise only when the app or that project has a looser preset', withBoot([], async (r) => {
  r.projects.setMembers(r.proj.id, ['worker']);
  // no presets: follow the app default, Ask
  assert.equal((await r.http('PATCH', '/api/agents/worker', { approvalSource: 'project' })).status, 200);
  assert.deepEqual(r.mode(), ['ask', 'project']);
  assert.equal((await r.http('PATCH', '/api/agents/worker', { approvalSource: 'own' })).status, 200);
  // a strict project preset
  r.core.store.patchProject(r.proj.id, { preset: 'ask' });
  assert.equal((await r.http('PATCH', '/api/agents/worker', { approvalSource: 'project' })).status, 200, 'Ask is not looser than an own Ask');
  assert.equal((await r.http('PATCH', '/api/agents/worker', { approvalSource: 'own' })).status, 200);
  // Bypass on the project: following it is Full for this agent
  r.core.store.patchProject(r.proj.id, { preset: 'bypass' });
  const refused = await r.http('PATCH', '/api/agents/worker', { approvalSource: 'project' });
  assert.equal(refused.status, 403);
  assert.deepEqual(r.mode(), ['ask', 'own']);
  const pv = await r.preview({ agentId: 'worker', approvalSource: 'project' });
  assert.equal(pv.raises, true);
  assert.ok(pv.loosening.some((l) => l.includes('Worker') && l.includes('"Shop"')), pv.loosening.join(' | '));
  assert.equal((await r.http('PATCH', '/api/agents/worker', { approvalSource: 'project' }, { ...r.native, [DIGEST]: pv.digest })).status, 200);
  assert.deepEqual(r.mode(), ['ask', 'project']);
  // from Full on its own to following a Bypass project is not a raise; following it back to a strict project is a tightening
  r.f.ctx.store.upsertAgent({ ...r.f.ctx.store.getAgent('worker')!, approval: 'full', approvalSource: 'own' });
  assert.equal((await r.http('PATCH', '/api/agents/worker', { approvalSource: 'project' })).status, 200, 'Full to Bypass is not a raise inside the project; outside it the app is Ask');
}));

test('core: an app preset looser than the agent raises when the agent follows it, even outside any project', withBoot([], async (r) => {
  r.core.store.patchApp({ preset: 'smart' });
  assert.equal((await r.http('PATCH', '/api/agents/worker', { approvalSource: 'project' })).status, 403);
  r.core.store.patchApp({ preset: 'ask' });
  assert.equal((await r.http('PATCH', '/api/agents/worker', { approvalSource: 'project' })).status, 200);
}));

test('core: creating an agent at Ask or following a strict preset needs nothing; Full or a looser followed preset does', withBoot([], async (r) => {
  assert.equal((await r.http('POST', '/api/agents', { name: 'Plain' })).status, 201);
  assert.equal((await r.http('POST', '/api/agents', { name: 'Asker', approval: 'ask', approvalSource: 'own' })).status, 201);
  assert.equal((await r.http('POST', '/api/agents', { name: 'Follower', approval: 'ask', approvalSource: 'project' })).status, 201, 'app preset is Ask');
  const full = await r.http('POST', '/api/agents', { name: 'Boss', approval: 'full' });
  assert.equal(full.status, 403);
  assert.equal(r.f.ctx.store.listAgents().some((a) => a.name === 'Boss'), false, 'nothing was created');
  const pv = await r.preview({ approval: 'full' });
  assert.equal(pv.raises, true);
  const ok = await r.http('POST', '/api/agents', { name: 'Boss', approval: 'full' }, { ...r.native, [DIGEST]: pv.digest });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.approval, 'full');
  r.core.store.patchApp({ preset: 'bypass' });
  assert.equal((await r.http('POST', '/api/agents', { name: 'Follows Bypass', approvalSource: 'project' })).status, 403);
}));

test('core: the preview names the agent, says what it will run as and carries the no-sandbox line for a raise', withBoot([], async (r) => {
  const pv = await r.preview({ agentId: 'worker', approval: 'full' });
  assert.equal(pv.agentName, 'Worker');
  assert.ok(pv.loosening[0]!.startsWith('Worker will never ask'), pv.loosening[0]);
  assert.ok(pv.loosening.includes(NO_SANDBOX_LINE));
  const ae = await r.preview({ agentId: 'worker', approval: 'auto-edits' });
  assert.match(ae.loosening[0]!, /Worker will change files without asking/);
  const tight = await r.preview({ agentId: 'worker', approval: 'ask' });
  assert.deepEqual([tight.raises, tight.loosening], [false, []]);
  assert.equal((await r.http('POST', '/api/agents/mode-preview', { agentId: 'nobody', approval: 'full' })).status, 404);
  assert.equal((await r.http('POST', '/api/agents/mode-preview', { agentId: 'worker', approval: 'root' })).status, 400);
  assert.equal((await r.http('POST', '/api/agents/mode-preview', { agentId: 'worker', approval: 'full', extra: 1 })).status, 400);
}));

test('core: a core without the gates module still refuses a raise and keeps taking tightening', withBoot([], async (r) => {
  assert.equal((await r.http('PATCH', '/api/agents/worker', { approval: 'full' }, r.native)).status, 403);
  assert.equal((await r.http('POST', '/api/agents', { name: 'Boss', approval: 'auto-edits' }, r.native)).status, 403);
  assert.equal((await r.http('PATCH', '/api/agents/worker', { approval: 'ask' })).status, 200);
  assert.equal((await r.http('POST', '/api/agents', { name: 'Plain' })).status, 201);
}, { noGates: true }));

// ---------------------------------------------------------------- the IPC and its dialog

test('ipc: parse is strict', () => {
  assert.deepEqual(parseAgentModeChange({ agentId: 'worker', approval: 'full' }), { agentId: 'worker', approval: 'full' });
  assert.deepEqual(parseAgentModeChange({ agentId: 'worker', approvalSource: 'project' }), { agentId: 'worker', approvalSource: 'project' });
  for (const bad of [null, [], 'x', {}, { agentId: 'worker' }, { approval: 'full' }, { agentId: 'Worker!', approval: 'full' }, { agentId: 'worker', approval: 'root' },
    { agentId: 'worker', approval: 'full', name: 'x' }, { agentId: 'worker', approvalSource: 'everyone' }, { agentId: '../x', approval: 'full' }, { agentId: 'worker', approval: 'full', systemPrompt: 'x' }]) {
    assert.equal(parseAgentModeChange(bad), undefined, JSON.stringify(bad));
  }
});

test('ipc: Full shows one dialog that names the agent and the mode, then saves with native and the shown digest', withBoot([true], async (r) => {
  const shown = await r.preview({ agentId: 'worker', approval: 'full' });
  const res = await agentModeChange({ agentId: 'worker', approval: 'full' }, r.deps);
  assert.equal(res.ok, true, res.error);
  assert.equal(r.dialogs.length, 1);
  const d = r.dialogs[0]!;
  assert.match(d.message, /Worker/);
  assert.match(d.detail, /Worker will never ask before it runs commands or changes files/);
  assert.ok(d.detail.includes(NO_SANDBOX_LINE));
  assert.equal(d.confirmLabel, 'Confirm change');
  assert.doesNotMatch(JSON.stringify(d), /—/, 'no em dash');
  const w = r.writes();
  assert.equal(w.length, 1);
  assert.deepEqual([w[0]!.route, w[0]!.native, w[0]!.digest, w[0]!.body], ['/api/agents/worker', true, shown.digest, { approval: 'full' }]);
  assert.deepEqual(r.mode(), ['full', 'own']);
}));

test('ipc: Cancel changes nothing and makes no write; the same change cannot raise a second dialog at once', withBoot([false, true], async (r) => {
  const res = await agentModeChange({ agentId: 'worker', approval: 'full' }, r.deps);
  assert.deepEqual([res.ok, res.cancelled], [false, true]);
  assert.equal(r.writes().length, 0);
  assert.deepEqual(r.mode(), ['ask', 'own']);
  const again = await agentModeChange({ agentId: 'worker', approval: 'full' }, r.deps);
  assert.equal(again.ok, false);
  assert.match(again.error ?? '', /cancelled this change a moment ago/);
  assert.equal(r.dialogs.length, 1, 'no second dialog');
}));

test('ipc: a tightening or an unchanged mode shows no dialog and sends no native secret', withBoot([true], async (r) => {
  r.f.ctx.store.upsertAgent({ ...r.worker, approval: 'full' });
  const res = await agentModeChange({ agentId: 'worker', approval: 'ask' }, r.deps);
  assert.equal(res.ok, true, res.error);
  assert.equal(r.dialogs.length, 0);
  assert.equal(r.writes()[0]!.native, false);
  assert.deepEqual(r.mode(), ['ask', 'own']);
  assert.equal((await agentModeChange({ agentId: 'worker', approval: 'ask' }, r.deps)).ok, true);
  assert.equal(r.dialogs.length, 0);
}));

test('ipc: following a Bypass project asks, and Cancel leaves the agent as it was', withBoot([false], async (r) => {
  r.projects.setMembers(r.proj.id, ['worker']);
  r.core.store.patchProject(r.proj.id, { preset: 'bypass' });
  const res = await agentModeChange({ agentId: 'worker', approvalSource: 'project' }, r.deps);
  assert.equal(res.cancelled, true);
  assert.match(r.dialogs[0]!.detail, /follow the way agents ask in the project "Shop"/);
  assert.deepEqual(r.mode(), ['ask', 'own']);
}));

test('ipc: a second change while a dialog is open is refused without a second dialog', withBoot([], async (r) => {
  let release!: (b: boolean) => void;
  r.deps.confirm = (d) => { r.dialogs.push(d); return new Promise<boolean>((res) => { release = res; }); };
  const first = agentModeChange({ agentId: 'worker', approval: 'full' }, r.deps);
  await new Promise((res) => setTimeout(res, 150));
  const second = await agentModeChange({ agentId: 'worker', approval: 'auto-edits' }, r.deps);
  assert.equal(second.ok, false);
  assert.equal(r.dialogs.length, 1);
  release(false); await first;
}));

test('ipc: the core refusing, or not answering, is said plainly and changes nothing', withBoot([true], async (r) => {
  assert.match((await agentModeChange({ agentId: 'nobody', approval: 'full' }, r.deps)).error ?? '', /Unknown agent/);
  const down = { ...r.deps, call: async () => undefined } as AgentModeIpcDeps;
  assert.match((await agentModeChange({ agentId: 'worker', approval: 'full' }, down)).error ?? '', /could not reach its own core/);
  assert.equal(r.dialogs.length, 0);
  assert.deepEqual(r.mode(), ['ask', 'own']);
}));

test('busy: a loosening question that lost to an open one is "already open"; a retry is not paused as if the person had cancelled', withBoot([true], async (r) => {
  const real = r.deps.confirm;
  r.deps.confirm = async () => { throw new ConfirmBusyError(); };
  assert.deepEqual(await agentModeChange({ agentId: 'worker', approval: 'full' }, r.deps), { ok: false, error: CONFIRM_BUSY });
  assert.deepEqual(r.mode(), ['ask', 'own']);
  r.deps.confirm = real;
  const retry = await agentModeChange({ agentId: 'worker', approval: 'full' }, r.deps);
  assert.equal(retry.ok, true, retry.error);
}));
