/**
 * "Comes with Legion": the core marks the agents it seeded whose approval setting the owner has not changed. Absent means "your choice", so an
 * install from before the mark shows no tags. The first change of an agent's approval clears it; nothing the window sends can set it; no run reads it.
 * Also (upgrade from 0.3.4): a data folder made by 0.3.4 loads with every agent's effective mode unchanged and counts as an existing install.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Store } from '../src/core/store.js';
import { effectiveMode } from '../src/core/permission-mode.js';
import { AUTH, makeFakes, start } from './helpers-c.js';
import { isFreshInstall, shouldShowPresetChoice } from '../ui/src/welcome/presetChoiceLogic.js';
import type { AgentProfile } from '../src/shared/types.js';

const J = { 'Content-Type': 'application/json' };
const own = (a: AgentProfile) => effectiveMode({ agentMode: a.approval, source: a.approvalSource ?? 'own', appPreset: 'ask' });

test('seedDefaults marks every agent it creates', () => {
  const dir = cleanupTemp('legion-seedmark-');
  const s = new Store(join(dir, 'data'));
  s.seedDefaults(join(dir, 'ws'));
  const all = s.listAgents();
  assert.ok(all.length >= 13, `the roster (${all.length})`);
  for (const a of all) assert.equal(a.seedApproval, true, a.id);
});

test('seedDefaults never marks an agent that already exists, so an install from before the mark shows no tags', async () => {
  const dir = cleanupTemp('legion-seedmark-up-');
  const first = new Store(join(dir, 'data'));
  first.seedDefaults(join(dir, 'ws'));
  // what 0.3.4 wrote: the same agents, no mark, no approvalSource
  const old = first.listAgents().map(({ seedApproval: _x, ...rest }) => rest);
  await first.flush();
  const file = join(dir, 'data', 'state.json');
  const st = JSON.parse(readFileSync(file, 'utf8')) as { agents: unknown[] };
  st.agents = old;
  writeFileSync(file, JSON.stringify(st));
  const again = new Store(join(dir, 'data'));
  again.seedDefaults(join(dir, 'ws'));
  for (const a of again.listAgents()) assert.equal(a.seedApproval, undefined, a.id);
  assert.equal(again.listAgents().length, old.length, 'nothing was added');
});

test('upgrade from 0.3.4: every agent keeps the effective mode it had, and the mark is absent everywhere', async () => {
  const dir = cleanupTemp('legion-seedmark-034-');
  mkdirSync(join(dir, 'data'), { recursive: true });
  // a 0.3.4 shaped folder: agents with an approval and no approvalSource, one edited seed, one custom agent
  const mk = (id: string, approval: string): Record<string, unknown> => ({ id, name: id, emoji: 'x', description: '', systemPrompt: 'p', model: 'auto', vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval, mcpServers: ['*'], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
  const before: Record<string, string> = { zealot: 'auto-edits', builder: 'full', scout: 'ask', scribe: 'auto-edits', inquisitor: 'full', mine: 'auto-edits' };
  writeFileSync(join(dir, 'data', 'state.json'), JSON.stringify({ agents: Object.entries(before).map(([id, a]) => mk(id, a)), tasks: [], vms: [], migrations: [] }));
  const s = new Store(join(dir, 'data'));
  s.seedDefaults(join(dir, 'ws'));
  for (const [id, mode] of Object.entries(before)) {
    const a = s.getAgent(id)!;
    assert.equal(a.approval, mode, `${id} keeps its stored mode`);
    assert.equal(a.approvalSource, undefined, `${id} still has no source`);
    assert.equal(own(a), mode, `${id} runs as before`);
    assert.equal(a.seedApproval, undefined, `${id} carries no mark`);
  }
  // so the first-run screen never shows: it is an existing install, whatever gates settings (none, in 0.3.4) say
  assert.equal(isFreshInstall(s.listAgents()), false);
  assert.equal(shouldShowPresetChoice({ app: { version: 1 }, projects: {}, unreadable: [], changedOutside: [], canSign: true }, true, s.listAgents()), false);
  // the seeds this folder lacked are added by the core as they always were, with their own shipped modes
  assert.equal(s.getAgent('sentinel')!.approval, 'ask');
});

async function boot() {
  const f = makeFakes({ holdRuns: true });
  f.ctx.store.upsertAgent({ ...f.ctx.store.getAgent('scout')!, seedApproval: true });
  const server = await start(f.ctx);
  const http = async (method: string, route: string, body?: unknown) => {
    const r = await fetch(server.base + route, { method, headers: { ...AUTH, ...J }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  return { f, http, close: () => server.close() };
}

test('a PATCH that does not touch the approval keeps the mark; one that changes the approval clears it', async () => {
  const r = await boot();
  try {
    assert.equal((await r.http('PATCH', '/api/agents/scout', { description: 'new words' })).json.seedApproval, true);
    assert.equal((await r.http('PATCH', '/api/agents/scout', { approval: 'ask', approvalSource: 'own' })).json.seedApproval, true, 'the same setting is not a change');
    const changed = await r.http('PATCH', '/api/agents/scout', { approvalSource: 'project' });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.seedApproval, undefined);
    assert.equal(r.f.ctx.store.getAgent('scout')!.seedApproval, undefined);
    // and it stays cleared when the owner sets it back
    await r.http('PATCH', '/api/agents/scout', { approvalSource: 'own' });
    assert.equal(r.f.ctx.store.getAgent('scout')!.seedApproval, undefined);
  } finally { await r.close(); }
});

test('nothing the window sends can set the mark', async () => {
  const r = await boot();
  try {
    const made = await r.http('POST', '/api/agents', { name: 'Mine', seedApproval: true });
    assert.equal(made.status, 201);
    assert.equal(made.json.seedApproval, undefined);
    r.f.ctx.store.upsertAgent({ ...r.f.ctx.store.getAgent('scout')!, seedApproval: undefined as never });
    delete (r.f.ctx.store.getAgent('scout') as Partial<AgentProfile>).seedApproval;
    const patched = await r.http('PATCH', '/api/agents/scout', { description: 'x', seedApproval: true });
    assert.equal(patched.json.seedApproval, undefined);
  } finally { await r.close(); }
});
