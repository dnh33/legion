/** Shared rig for the agent-mode IPC tests: the REAL core (agent routes, gates routes, projects) and a fake native dialog. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import { join } from 'node:path';
import { resetAgentModeCancelForTests } from '../src/electron/agent-mode-ipc.js';
import type { AgentModeIpcDeps } from '../src/electron/agent-mode-ipc.js';
import { createGatesCore, createGatesModule } from '../src/core/gates-settings/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { AUTH, makeFakes, mkAgent, start } from './helpers-c.js';

export const NATIVE = 'native-secret';
export const J = { 'Content-Type': 'application/json' };
export const DIGEST = 'x-legion-gates-digest';
export type Dialog = { title: string; message: string; detail: string; confirmLabel: string };
export const IDS = ['alpha', 'bravo', 'charlie', 'delta'];
export type Own = Record<string, 'ask' | 'auto-edits' | 'full'>;

export async function boot(answers: boolean[] = [], own: Own = {}) {
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
export type R = Awaited<ReturnType<typeof boot>>;
export const withBoot = (answers: boolean[], fn: (r: R) => Promise<void>, own: Own = {}) => async () => { const r = await boot(answers, own); try { await fn(r); } finally { await r.close(); } };
