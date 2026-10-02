/**
 * The Blender Bridge module. Off by default. When enabled, ONLY the Sculptor gets the in-process `legion_blender` server (see guard.ts);
 * everything raw (the backend's execute tool, the official MCP server, the add-on socket) stays behind it. HTTP routes are admin-only
 * by default-deny (admin.ts): GET /api/blender, POST /api/blender/{setup,test,config,launch}. Status changes go out as `blender.status`
 * events, which server.ts filters for admin clients. See docs/BLENDER.md.
 */
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'node:path';
import { BLENDER_EXEC_TOOL, BLENDER_SERVER_NAME, SCULPTOR_ID } from '../../shared/blender.js';
import type { BlenderBackendKind, BlenderConfig, BlenderInstall, BlenderLight, BlenderSetupResult, BlenderStatusView, BlenderTestResult, BlenderSetupStep } from '../../shared/blender.js';
import type { AgentProfile } from '../../shared/types.js';
import { HttpError } from '../server.js';
import type { CoreModule, ModuleDeps, ModuleJob } from '../modules.js';
import { liveSecrets } from '../kg/index.js';
import { AuditLog } from './audit.js';
import type { BlenderBackend } from './backend.js';
import { CommunityBackend } from './backends/community.js';
import { OfficialBackend } from './backends/official.js';
import { chooseBackend, detectInstalls, pickInstall } from './detect.js';
import { BlenderGuard } from './guard.js';
import type { GuardDeps } from './guard.js';
import { SandboxRunner } from './sandbox.js';
import type { SandboxPort, VmPort } from './sandbox.js';
import { launchBlender, setupLive, testConnection } from './setup.js';
import type { BlenderIo } from './setup.js';
import { BlenderState } from './state.js';
import type { BlenderPatch } from './state.js';
import { createRealIo } from './system.js';
import { tcpProbe } from './tcp.js';

export { BlenderState } from './state.js';

export interface BlenderModuleOptions {
  state?: BlenderState;
  io?: BlenderIo;
  vms?: VmPort;
  boatConfigured?: () => boolean;
  sandbox?: SandboxPort;
  makeBackend?: (kind: BlenderBackendKind, cfg: BlenderConfig) => BlenderBackend;
  probe?: (host: string, port: number) => Promise<boolean>;
  backup?: GuardDeps['backup'];
  log?: (msg: string) => void;
}

/** Server names a user may have added for a Blender MCP; the raw tools of such a server must not reach agents while the bridge is on. */
const RAW_SERVER_GUESSES = ['blender', 'blender-mcp', 'blender_mcp', 'Blender', 'blender-lab', 'blender_lab', 'claude_ai_Blender'];
const DETECT_TTL_MS = 60_000;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export const SCULPTOR_PREAMBLE_ON = [
  'The Blender bridge is on. Your tools are mcp__legion_blender__blender_exec, _inspect, _screenshot, _docs and _status.',
  'Call blender_status first: it says whether the sandbox VM and live Blender are reachable. Scripts default to the sandbox; use mode "live" only when the user asked to work in their open Blender.',
  'Every script is checked and shown to the user in full; a denied or blocked script did not run. Read the finished result with blender_screenshot before you call it done.',
].join('\n');
export const SCULPTOR_PREAMBLE_OFF = 'The Blender bridge is switched off in Settings (Blender), so you have no Blender tools. Plan and explain; tell the user to turn it on if they want you to build.';

export function createBlenderModule(deps: ModuleDeps, opts: BlenderModuleOptions = {}): CoreModule & {
  state: BlenderState; guard: BlenderGuard; status: (refresh?: boolean) => Promise<BlenderStatusView>;
} {
  const log = opts.log ?? (() => undefined);
  const state = opts.state ?? new BlenderState({ dataDir: deps.dataDir, config: deps.config });
  const io = opts.io ?? createRealIo();
  const probe = opts.probe ?? tcpProbe;
  const boatConfigured = opts.boatConfigured ?? (() => false);
  const sandbox: SandboxPort | undefined = opts.sandbox ?? (opts.vms
    ? new SandboxRunner({
      vms: opts.vms, config: () => state.config, boatConfigured,
      workspaceOf: (a) => a.cwd || join(deps.config.workspaceDir, a.id),
    })
    : undefined);
  const audit = new AuditLog(deps.dataDir, () => liveSecrets(deps.config));
  const cfg = (): BlenderConfig => state.config;
  const makeBackend = opts.makeBackend ?? ((kind, c) => (kind === 'official' ? new OfficialBackend(c) : new CommunityBackend(c)));

  // ---- detection (cached; Settings can force a refresh)
  let installs: BlenderInstall[] = [];
  let detectedAt = 0;
  let detectKey = '';
  async function detect(force = false): Promise<BlenderInstall[]> {
    const key = cfg().installPath ?? '';
    if (!force && detectedAt && Date.now() - detectedAt < DETECT_TTL_MS && key === detectKey) return installs;
    try { installs = await detectInstalls(io.detect, cfg().installPath); } catch (e) { log(`blender detection failed: ${e instanceof Error ? e.message : String(e)}`); installs = []; }
    detectedAt = Date.now();
    detectKey = key;
    return installs;
  }
  const choose = () => chooseBackend(cfg().backend, pickInstall(installs));

  // ---- live backend (one at a time; rebuilt when the settings that shape it change)
  let backend: BlenderBackend | null = null;
  let backendKey = '';
  let lastError: string | undefined;
  async function getBackend(): Promise<BlenderBackend> {
    const c = cfg();
    if (!c.enabled) throw new Error('The Blender bridge is switched off in Settings.');
    await detect();
    const choice = choose();
    if (!choice.kind) throw new Error(choice.reason);
    if (choice.kind === 'official' && !c.entry) throw new Error('The official Blender backend is not set up yet. Open Settings, Blender and press Set up.');
    const key = JSON.stringify([choice.kind, c.host, c.port, c.entry ?? null, c.advanced]);
    if (!backend || backendKey !== key) {
      const old = backend;
      backend = null;
      await old?.close().catch(() => undefined);
      backend = makeBackend(choice.kind, c);
      backendKey = key;
    }
    try { await backend.connect(); lastError = undefined; } catch (e) { lastError = e instanceof Error ? e.message : String(e); throw e; }
    return backend;
  }

  // ---- status
  const sculptor = (): AgentProfile | undefined => deps.store.getAgent(SCULPTOR_ID);

  async function status(refresh = false): Promise<BlenderStatusView> {
    const c = cfg();
    if (c.enabled) await detect(refresh);
    const choice = c.enabled ? choose() : { kind: null, reason: 'The Blender bridge is switched off.' };
    const selected = c.enabled ? pickInstall(installs) : undefined;
    const socketOpen = c.enabled ? await probe(c.host, c.port).catch(() => false) : false;
    const sbAgent = sculptor();
    const rd = !c.enabled ? { ready: false, note: 'The bridge is off.' }
      : c.sandbox === 'off' ? { ready: false, note: 'The sandbox is switched off in Settings.' }
        : !sandbox ? { ready: false, note: 'The sandbox is not available in this build.' }
          : !sbAgent ? { ready: false, note: 'The Sculptor agent does not exist.' }
            : sandbox.readiness(sbAgent);
    const rec = state.setup;
    const setupDone = choice.kind === 'official' ? !!c.entry && rec.addonInstalledFor === 'official' : choice.kind === 'community' ? rec.addonInstalledFor === 'community' : false;
    const connected = !!backend?.isConnected();
    const liveUsable = choice.kind !== null && (connected || (socketOpen && (choice.kind === 'community' || !!c.entry)));
    let light: BlenderLight;
    let summary: string;
    if (!c.enabled) { light = 'off'; summary = 'Blender bridge is off.'; }
    else if (socketOpen && lastError && !connected) { light = 'error'; summary = lastError.slice(0, 200); }
    else if (liveUsable) { light = 'connected'; summary = `Blender is reachable (${choice.kind} backend${selected ? `, Blender ${selected.version}` : ''}).${rd.ready ? ' Sandbox VM ready.' : ''}`; }
    else if (rd.ready && c.sandbox !== 'off') { light = 'sandbox'; summary = selected ? `Sandbox VM ready; live Blender ${selected.version} is not connected.` : 'Sandbox VM ready; no Blender found on this computer.'; }
    else if (!selected) { light = 'not-found'; summary = 'Blender was not found on this computer.'; }
    else if (!choice.kind) { light = 'error'; summary = choice.reason; }
    else if (!setupDone) { light = 'needs-setup'; summary = `Blender ${selected.version} found. Press Set up to install the add-on.`; }
    else { light = 'disconnected'; summary = `Blender ${selected.version} found, but its add-on is not listening on port ${c.port}. Open Blender or press Launch.`; }
    return {
      enabled: c.enabled, light, summary, backendChoice: c.backend, chosenBackend: choice.kind, backendReason: choice.reason,
      installs, ...(selected ? { selected } : {}), connected, socketOpen, sandbox: c.sandbox,
      sandboxReady: rd.ready, sandboxNote: rd.note, host: c.host, port: c.port, setup: rec,
      ...(lastError ? { lastError } : {}), lastCheckedAt: new Date().toISOString(), stats: { ...guard.stats },
    };
  }

  // Status events: coalesced, never thrown.
  let emitting = false;
  let again = false;
  function emitStatus(): void {
    if (emitting) { again = true; return; }
    emitting = true;
    void (async () => {
      try { do { again = false; deps.bus.emit({ type: 'blender.status', status: await status() }); } while (again); } catch { /* status is best effort */ } finally { emitting = false; }
    })();
  }

  const guard = new BlenderGuard({
    config: cfg, dataDir: deps.dataDir, approvals: deps.approvals, getBackend, ...(sandbox ? { sandbox } : {}),
    secrets: () => liveSecrets(deps.config),
    exportDirFor: (a) => join(a.cwd || join(deps.config.workspaceDir, a.id), 'blender-exports'),
    audit, ...(opts.backup ? { backup: opts.backup } : {}), onChange: emitStatus,
  });

  const statusText = (a: AgentProfile): string => {
    const c = cfg();
    const lines = [
      `Blender bridge: ${c.enabled ? 'on' : 'off'}. Sandbox setting: ${c.sandbox}.`,
      `Live backend: ${backend?.isConnected() ? `${backend.kind} (connected)` : 'not connected (it connects when a live call is made)'}.`,
      `Sandbox VM: ${sandbox ? sandbox.readiness(a).note : 'not available'}.`,
      `Live export folder: ${join(a.cwd || join(deps.config.workspaceDir, a.id), 'blender-exports')}. Sandbox exports come back to <workspace>/blender-exports/<task>/.`,
      `Scripts this session: ${guard.stats.approved} approved, ${guard.stats.denied} denied, ${guard.stats.blocked} blocked by the safety check.`,
    ];
    return lines.join('\n');
  };

  let lock: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => { const r = lock.then(fn, fn); lock = r.catch(() => undefined); return r; };

  function parsePatch(body: unknown): BlenderPatch {
    if (!isObj(body)) throw new HttpError(400, 'body must be an object');
    const p: BlenderPatch = {};
    if ('enabled' in body) { if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false'); p.enabled = body.enabled; }
    if ('backend' in body) { if (body.backend !== 'auto' && body.backend !== 'official' && body.backend !== 'community') throw new HttpError(400, 'backend must be auto, official or community'); p.backend = body.backend; }
    if ('sandbox' in body) { if (body.sandbox !== 'off' && body.sandbox !== 'vm' && body.sandbox !== 'auto') throw new HttpError(400, 'sandbox must be off, vm or auto'); p.sandbox = body.sandbox; }
    if ('port' in body) { if (typeof body.port !== 'number' || !Number.isInteger(body.port) || body.port < 1024 || body.port > 65535) throw new HttpError(400, 'port must be a whole number from 1024 to 65535'); p.port = body.port; }
    if ('installPath' in body) {
      if (body.installPath !== null && (typeof body.installPath !== 'string' || body.installPath.length > 1000 || /[\0\r\n]/.test(body.installPath))) throw new HttpError(400, 'installPath must be a path or null');
      p.installPath = body.installPath as string | null;
    }
    return p;
  }

  async function runSetup(target: 'live' | 'sandbox' | 'both'): Promise<BlenderSetupResult> {
    const steps: BlenderSetupStep[] = [];
    if (!cfg().enabled) return { ok: false, steps: [{ step: 'enabled', ok: false, detail: 'Turn the Blender bridge on first.' }], status: await status() };
    if (target !== 'sandbox') {
      await detect(true);
      const choice = choose();
      if (!choice.kind) steps.push({ step: 'backend', ok: false, detail: choice.reason });
      else {
        const r = await setupLive(io, cfg(), deps.dataDir, pickInstall(installs), choice.kind);
        steps.push(...r.steps);
        try { state.recordSetup({ kind: choice.kind, ...(r.info ? { info: r.info } : {}), ...(r.entry ? { entry: r.entry } : {}), addonInstalled: r.addonInstalled }); } catch (e) { steps.push({ step: 'save', ok: false, detail: `Could not save the setup result: ${e instanceof Error ? e.message : String(e)}` }); }
      }
    }
    if (target !== 'live' && cfg().sandbox !== 'off') {
      const a = sculptor();
      if (!sandbox || !a) steps.push({ step: 'sandbox', ok: false, detail: 'The sandbox needs the Sculptor agent and a boat.dev API key.' });
      else steps.push(...await sandbox.setup(a));
    }
    // a new entry or add-on means the old connection is stale
    const old = backend; backend = null; await old?.close().catch(() => undefined);
    const ok = steps.length > 0 && steps.every((s) => s.ok);
    if (!ok) lastError = steps.find((s) => !s.ok)?.detail;
    else lastError = undefined;
    const st = await status(true);
    deps.bus.emit({ type: 'blender.status', status: st });
    return { ok, steps, status: st };
  }

  async function runTest(): Promise<BlenderTestResult> {
    if (!cfg().enabled) return { ok: false, steps: [{ step: 'enabled', ok: false, detail: 'Turn the Blender bridge on first.' }], status: await status() };
    await detect(true);
    const r = await testConnection(probe, cfg(), getBackend);
    const sb = sandbox && sculptor() && cfg().sandbox !== 'off' ? sandbox.readiness(sculptor()!) : null;
    const steps = [...r.steps, ...(sb ? [{ step: 'sandbox', ok: sb.ready, detail: sb.note }] : [])];
    const live = r.ok;
    if (!live) lastError = r.steps.find((s) => !s.ok)?.detail; else lastError = undefined;
    const st = await status(true);
    deps.bus.emit({ type: 'blender.status', status: st });
    return { ok: live || (sb?.ready ?? false), steps, status: st };
  }

  return {
    id: 'blender',
    state, guard, status,
    mcpServers(agent: AgentProfile, job?: ModuleJob): Record<string, McpServerConfig> {
      if (!cfg().enabled || agent.id !== SCULPTOR_ID) return {};
      return { [BLENDER_SERVER_NAME]: guard.buildServer(agent, job, () => statusText(agent)) };
    },
    disallowedTools(agent: AgentProfile): string[] {
      if (!cfg().enabled) return [];
      const out = RAW_SERVER_GUESSES.map((n) => `mcp__${n}`);
      // any server the user configured that looks like a Blender MCP: its raw execute tool must not bypass the guard
      for (const [name, e] of Object.entries(deps.config.mcpServers ?? {})) {
        const text = `${name} ${'command' in e ? [e.command, ...(e.args ?? [])].join(' ') : e.url}`;
        if (/blender/i.test(text)) out.push(`mcp__${name}`);
      }
      if (agent.id !== SCULPTOR_ID) out.push(`mcp__${BLENDER_SERVER_NAME}`, BLENDER_EXEC_TOOL);
      return [...new Set(out)];
    },
    preamble(agent: AgentProfile) {
      if (agent.id !== SCULPTOR_ID) return '';
      return cfg().enabled ? SCULPTOR_PREAMBLE_ON : SCULPTOR_PREAMBLE_OFF;
    },
    routes(add) {
      add('GET', '/api/blender', ({ url }) => status(url.searchParams.get('refresh') === '1'));
      add('POST', '/api/blender/config', ({ body }) => exclusive(async () => {
        const patch = parsePatch(body);
        try { state.update(patch); } catch (e) { throw new HttpError(500, `Could not save the Blender settings: ${e instanceof Error ? e.message : String(e)}`); }
        if (patch.enabled === false || patch.backend !== undefined || patch.port !== undefined || patch.installPath !== undefined) { const old = backend; backend = null; await old?.close().catch(() => undefined); detectedAt = 0; }
        const st = await status(true);
        deps.bus.emit({ type: 'blender.status', status: st });
        return st;
      }));
      add('POST', '/api/blender/setup', ({ body }) => exclusive(() => {
        const t = isObj(body) && body.target !== undefined ? body.target : 'both';
        if (t !== 'live' && t !== 'sandbox' && t !== 'both') throw new HttpError(400, 'target must be live, sandbox or both');
        return runSetup(t);
      }));
      add('POST', '/api/blender/test', () => exclusive(runTest));
      add('POST', '/api/blender/launch', () => exclusive(async () => {
        if (!cfg().enabled) throw new HttpError(409, 'Turn the Blender bridge on first.');
        await detect(true);
        const step = launchBlender(io, cfg(), pickInstall(installs), choose().kind);
        return { ok: step.ok, steps: [step], status: await status(true) };
      }));
    },
    async dispose() { const b = backend; backend = null; await b?.close().catch(() => undefined); },
  };
}
