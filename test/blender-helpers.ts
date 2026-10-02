/** Fakes for the Blender bridge tests: a scriptable backend, an approvals auto-answerer, an MCP client onto the guard's tool server. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaultBlenderConfig } from '../src/shared/blender.js';
import type { BlenderConfig } from '../src/shared/blender.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { AuditLog } from '../src/core/blender/audit.js';
import { BlenderGuard } from '../src/core/blender/guard.js';
import type { GuardDeps } from '../src/core/blender/guard.js';
import type { BackendResult, BlenderBackend } from '../src/core/blender/backend.js';
import type { SandboxPort } from '../src/core/blender/sandbox.js';
import type { ModuleJob } from '../src/core/modules.js';
import type { AgentProfile, ApprovalRequest, LegionEvent } from '../src/shared/types.js';

export const tmp = (p = 'legion-bl-'): string => mkdtempSync(join(tmpdir(), p));

export function agent(id = 'sculptor', over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id, name: id === 'sculptor' ? 'Sculptor' : id, emoji: '◈', description: 'x', systemPrompt: '', model: 'auto',
    vm: { enabled: true, size: 'default', idleStopMinutes: 15 }, approval: 'ask', mcpServers: ['*'],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
  };
}

export class FakeBackend implements BlenderBackend {
  readonly kind = 'community' as const;
  execs: string[] = [];
  inspects: Array<{ object?: string }> = [];
  shots: number[] = [];
  queries: string[] = [];
  connected = true;
  nextExec: (script: string) => Promise<BackendResult> | BackendResult = () => ({ ok: true, text: 'ok', images: [] });
  inFlight = 0;
  maxInFlight = 0;
  async connect(): Promise<void> { if (!this.connected) throw new Error('not connected'); }
  isConnected(): boolean { return this.connected; }
  async exec(script: string): Promise<BackendResult> {
    this.execs.push(script);
    this.inFlight++; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try { return await this.nextExec(script); } finally { this.inFlight--; }
  }
  async inspect(o: { object?: string }): Promise<BackendResult> { this.inspects.push(o); return { ok: true, text: 'scene: Cube', images: [] }; }
  async screenshot(o: { maxSize?: number }): Promise<BackendResult> { this.shots.push(o.maxSize ?? 0); return { ok: true, text: 'shot', images: [{ mime: 'image/png', data: 'AAAA' }] }; }
  async docs(q: string): Promise<BackendResult> { this.queries.push(q); return { ok: true, text: 'docs: ' + q, images: [] }; }
  async close(): Promise<void> { this.connected = false; }
}

export class FakeSandbox implements SandboxPort {
  ready = { ready: true, note: 'ok' };
  runs: Array<{ taskId: string; script: string; hash?: string }> = [];
  inspects = 0;
  previews = 0;
  result = { ok: true, text: 'sandbox ran', files: [] as Array<{ name: string; path: string; bytes: number; quarantined?: boolean }> };
  readiness() { return this.ready; }
  async run(r: { taskId: string; script: string; hash?: string }) { this.runs.push({ taskId: r.taskId, script: r.script, hash: r.hash }); return this.result; }
  async inspect(): Promise<BackendResult> { this.inspects++; return { ok: true, text: 'sandbox scene', images: [] }; }
  async preview(): Promise<BackendResult> { this.previews++; return { ok: true, text: 'sandbox preview', images: [{ mime: 'image/png', data: 'BBBB' }] }; }
  async setup() { return [{ step: 'sandbox', ok: true, detail: 'fake' }]; }
}

export interface Rig {
  guard: BlenderGuard;
  backend: FakeBackend;
  sandbox: FakeSandbox;
  approvals: ApprovalBroker;
  bus: EventBus;
  audit: AuditLog;
  dataDir: string;
  cfg: BlenderConfig;
  cards: ApprovalRequest[];
  /** What the fake human answers: true, false, or 'ignore' (nobody answers). */
  decision: { value: boolean | 'ignore' };
  order: string[];
  secrets: string[];
  tainted: { n: number };
  job: ModuleJob;
  backups: string[];
  events: LegionEvent[];
}

export function rig(opts: { cfg?: Partial<BlenderConfig>; timeoutMs?: number; backup?: GuardDeps['backup']; taskId?: string; extra?: Partial<GuardDeps> } = {}): Rig {
  const dataDir = tmp();
  const bus = new EventBus();
  const approvals = new ApprovalBroker(bus, { timeoutMs: opts.timeoutMs });
  const cfg = { ...defaultBlenderConfig(), enabled: true, ...opts.cfg } as BlenderConfig;
  const backend = new FakeBackend();
  const sandbox = new FakeSandbox();
  const cards: ApprovalRequest[] = [];
  const decision: Rig['decision'] = { value: true };
  const order: string[] = [];
  const events: LegionEvent[] = [];
  const secrets: string[] = [];
  const backups: string[] = [];
  bus.on((e) => {
    events.push(e);
    if (e.type === 'approval.requested') {
      cards.push(e.approval);
      order.push('card');
      if (decision.value !== 'ignore') setImmediate(() => approvals.resolve(e.approval.id, decision.value === true));
    }
  });
  const origExec = backend.exec.bind(backend);
  backend.exec = async (s: string) => { order.push('exec'); return origExec(s); };
  const audit = new AuditLog(dataDir, () => secrets);
  const tainted = { n: 0 };
  const job: ModuleJob = { taskId: opts.taskId ?? 'task_1', taint: () => tainted.n > 0, markTainted: () => { tainted.n++; } };
  const guard = new BlenderGuard({
    config: () => cfg, dataDir, approvals, getBackend: async () => { await backend.connect(); return backend; }, sandbox,
    secrets: () => secrets, exportDirFor: (a) => join(dataDir, 'ws', a.id, 'blender-exports'), audit,
    backup: opts.backup ?? (async ({ file }) => { order.push('backup'); backups.push(file); return { ok: true }; }),
    makeDir: () => undefined, workspaceOf: (a) => join(dataDir, 'ws', a.id),
    ...opts.extra,
  });
  return { guard, backend, sandbox, approvals, bus, audit, dataDir, cfg, cards, decision, order, secrets, tainted, job, backups, events };
}

/** An MCP client connected to the guard's server for one agent. */
export async function connectTools(r: Rig, a: AgentProfile = agent(), job: ModuleJob = r.job) {
  const cfg = r.guard.buildServer(a, job, () => 'status text');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(st);
  const client = new Client({ name: 'bl-test', version: '0.0.0' });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text?: string; data?: string }>;
    return { text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), images: content.filter((c) => c.type === 'image'), isError: res.isError === true };
  };
  return { client, call, tools: async () => (await client.listTools()).tools.map((t) => t.name), close: () => client.close() };
}

export const GOOD_SCRIPT = 'import bpy\nbpy.ops.mesh.primitive_cube_add(size=2)\nprint("cube added")\n';
