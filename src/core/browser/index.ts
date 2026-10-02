/**
 * The browser module (Lightpanda). OFF by default. When switched on in Settings every agent gets the in-process `legion_browser` tools; each run
 * gets its own Lightpanda process on 127.0.0.1, started on its first page and stopped when the run ends. Plan: claude/plan-browser.md.
 * Admin routes (default-deny, not in the MCP client list): GET /api/browser, POST /api/browser/{config,get,test,local}. "Allow local addresses"
 * needs the app's native confirmation and lives in memory only (it is off after every restart).
 */
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { basename } from 'node:path';
import { BROWSER_LIMITS, BROWSER_PINS } from '../../shared/browser.js';
import type { BrowserConfig, BrowserPin, BrowserStatusView } from '../../shared/browser.js';
import type { AgentProfile, Task } from '../../shared/types.js';
import { NATIVE_HEADER, safeEqual } from '../admin.js';
import { liveSecrets } from '../kg/index.js';
import type { CoreModule, ModuleDeps, ModuleJob, TaskEndOutcome } from '../modules.js';
import { HttpError } from '../server.js';
import { BrowserManager } from './manager.js';
import { BrowserSession } from './session.js';
import { getLightpanda, readManaged, verifyManaged, effectiveSha } from './get-lightpanda.js';
import type { GetPorts } from './get-lightpanda.js';
import { launchBrowser, LaunchError } from './launcher.js';
import type { BinaryRef, LaunchPorts } from './launcher.js';
import { lookupAll } from './resolve.js';
import type { Resolver } from './resolve.js';
import { BrowserState } from './state.js';
import { createGetPorts, createLaunchPorts, platformKey } from './system.js';
import { BROWSER_PREAMBLE_ON, buildBrowserServer } from './tools.js';
import type { GuardOptions } from './url-guard.js';

export { BrowserState } from './state.js';

export interface BrowserModuleOptions {
  state?: BrowserState;
  /** Test seams. Production passes none of them. */
  launchPorts?: LaunchPorts;
  getPorts?: GetPorts;
  resolve?: Resolver;
  pins?: BrowserPin[];
  limits?: Partial<typeof BROWSER_LIMITS>;
  nativeSecret?: string;
  log?: (m: string) => void;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createBrowserModule(deps: ModuleDeps, opts: BrowserModuleOptions = {}): CoreModule & { state: BrowserState; manager: BrowserManager } {
  const log = opts.log ?? (() => undefined);
  const state = opts.state ?? new BrowserState(deps.dataDir);
  const cfg = (): BrowserConfig => state.config;
  const ports = opts.launchPorts ?? createLaunchPorts();
  const getPorts = opts.getPorts ?? createGetPorts();
  const resolve = opts.resolve ?? lookupAll;
  const pins = opts.pins ?? BROWSER_PINS;
  // In memory only: not written anywhere, so a file edit cannot turn it on and a restart turns it off.
  let local: { allow: boolean; ports: number[] } = { allow: false, ports: [] };
  let getting = false;

  const guard = (): GuardOptions => ({ allowLocal: local.allow, localPorts: local.ports, allowDomains: cfg().allowDomains });

  /** The program to start, or null. The owner's own path wins; else the managed copy, which must still match its recorded hash. */
  async function binary(): Promise<{ ref: BinaryRef; kind: 'own' | 'managed' } | { error: string }> {
    const c = cfg();
    if (c.binaryPath) {
      const base = basename(c.binaryPath).toLowerCase();
      return { kind: 'own', ref: { file: c.binaryPath, prefixArgs: c.launcherArgs ?? [], wsl: base === 'wsl.exe' || base === 'wsl' } };
    }
    const m = readManaged(getPorts, deps.dataDir);
    if (!m) return { error: process.platform === 'win32' ? 'Lightpanda has no Windows build. Install it inside WSL and set the launcher in Settings, Browser.' : 'Lightpanda is not installed for Legion. Use Get Lightpanda in Settings, Browser, or point Legion at your own copy.' };
    // the file must match the hash in code (or the owner's recorded one), not only the record next to it
    const pin = pins.find((x) => x.platform === platformKey());
    const want = pin ? effectiveSha(pin, c.managedSha256) : '';
    if (!want || m.sha256 !== want || !(await verifyManaged(getPorts, m))) return { error: 'The Lightpanda file Legion fetched no longer matches its recorded hash, so it was not started. Fetch it again in Settings, Browser.' };
    return { kind: 'managed', ref: { file: m.path, prefixArgs: [], wsl: false } };
  }

  const manager: BrowserManager = new BrowserManager((taskId, reserve) => new BrowserSession({
    guard,
    resolve,
    limits: opts.limits,
    approveOrigin: async (o, u): Promise<boolean> => (await manager.peek(taskId)?.approveOrigin?.(o, u)) ?? false,
    async launch() {
      const b = await binary();
      if ('error' in b) throw new LaunchError(b.error);
      const free = (() => { try { return reserve(); } catch (e) { throw new LaunchError(e instanceof Error ? e.message : String(e)); } })();
      try {
        const run = await launchBrowser(ports, b.ref, { allowLocal: local.allow, ...(opts.limits?.wallMs ? { wallMs: opts.limits.wallMs } : {}), ...(opts.limits?.startTimeoutMs ? { startMs: opts.limits.startTimeoutMs } : {}) });
        const stop = run.stop.bind(run);
        void run.exited.then(() => free());
        return { ...run, stop: async () => { try { await stop(); } finally { free(); } } };
      } catch (e) { free(); throw e; }
    },
  }), opts.limits);

  const statusFor = (): BrowserStatusView => {
    const c = cfg();
    const m = readManaged(getPorts, deps.dataDir);
    const pin = pins.find((p) => p.platform === platformKey());
    const binaryKind = c.binaryPath ? 'own' : m ? 'managed' : 'none';
    return {
      enabled: c.enabled, binary: binaryKind, ...(c.binaryPath ? { binaryPath: c.binaryPath } : m ? { binaryPath: m.path } : {}),
      platform: platformKey(), needsLauncher: process.platform === 'win32',
      allowDomains: c.allowDomains, allowLocal: local.allow, running: manager.running(), getting,
      pin: pin ? { id: pin.id, url: pin.url, sha256Known: !!effectiveSha(pin, c.managedSha256), license: pin.license, approxMb: Math.round(pin.approxBytes / (1024 * 1024)) } : null,
      note: binaryKind === 'none'
        ? (process.platform === 'win32' ? 'Lightpanda has no Windows build: install it inside WSL and set the launcher (wsl.exe and its arguments) here.' : 'Lightpanda is not installed for Legion yet.')
        : 'Agents read pages as text only: no screenshots. Every page is treated as untrusted. The first page and each new site ask you first.',
    };
  };
  // No bus event on purpose: the Settings panel reads GET /api/browser, so nothing about this tool is pushed to non-admin event listeners.
  const emit = (): void => undefined;

  const needNative = (req: unknown): void => {
    const h = (req as { headers?: Record<string, string | string[] | undefined> }).headers?.[NATIVE_HEADER];
    if (!opts.nativeSecret) throw new HttpError(403, 'native_unavailable: this change needs the Legion app window (this core was not started by it)');
    if (typeof h !== 'string' || !safeEqual(h, opts.nativeSecret)) throw new HttpError(403, 'native_required: only the Legion app itself may do this, after its confirmation dialog');
  };

  return {
    id: 'browser', state, manager,
    mcpServers(agent: AgentProfile, job?: ModuleJob): Record<string, McpServerConfig> {
      if (!cfg().enabled) return {};
      return {
        legion_browser: buildBrowserServer(agent, job, {
          manager, guard, resolve, approvals: deps.approvals, secrets: () => liveSecrets(deps.config), modeOf: (id) => { try { return deps.store?.getAgent(id)?.approval; } catch { return undefined; } },
          statusLine: (taskId) => {
            const e = manager.peek(taskId);
            return `Browser tool: on. Page open: ${e?.session.started ? 'yes' : 'no'}. Reads text only (no screenshots). Redirect/request interception: ${e?.session.started ? (e.session.hasInterception ? 'on' : 'not available in this build (private addresses are still blocked by the browser\'s own option)') : 'unknown until a page is opened'}. Local addresses: ${local.allow ? 'allowed on listed ports' : 'refused'}. Allowed domains: ${cfg().allowDomains.length ? cfg().allowDomains.join(', ') : 'any public site'}.`;
          },
        }),
      };
    },
    preamble: () => (cfg().enabled ? BROWSER_PREAMBLE_ON : ''),
    onTaskEnd(task: Task, _agent: AgentProfile, _o: TaskEndOutcome) { void manager.end(task.id).catch(() => undefined); },
    routes(add) {
      add('GET', '/api/browser', () => statusFor());
      add('POST', '/api/browser/config', ({ req, body }) => {
        if (!isObj(body)) throw new HttpError(400, 'expected an object');
        // choosing which program Legion starts (or its launcher arguments, or the hash it trusts) is code execution: the app's confirmation dialog is required
        if ('binaryPath' in body || 'launcherArgs' in body || 'managedSha256' in body) needNative(req);
        const patch: Partial<BrowserConfig> = {};
        if ('enabled' in body) { if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false'); patch.enabled = body.enabled; }
        if ('binaryPath' in body) { if (body.binaryPath !== null && typeof body.binaryPath !== 'string') throw new HttpError(400, 'binaryPath must be text'); patch.binaryPath = body.binaryPath === null || body.binaryPath === '' ? undefined : body.binaryPath as string; }
        if ('launcherArgs' in body) { if (!Array.isArray(body.launcherArgs) || body.launcherArgs.some((x) => typeof x !== 'string')) throw new HttpError(400, 'launcherArgs must be a list of text'); patch.launcherArgs = body.launcherArgs as string[]; }
        if ('allowDomains' in body) { if (!Array.isArray(body.allowDomains) || body.allowDomains.some((x) => typeof x !== 'string')) throw new HttpError(400, 'allowDomains must be a list of text'); patch.allowDomains = body.allowDomains as string[]; }
        if ('managedSha256' in body) { if (typeof body.managedSha256 !== 'string') throw new HttpError(400, 'managedSha256 must be text'); patch.managedSha256 = body.managedSha256; }
        try { state.update(patch); } catch (e) { throw new HttpError(500, `Could not save the browser settings: ${e instanceof Error ? e.message : String(e)}`); }
        emit();
        return statusFor();
      });
      // Admin only by default-deny. Needs the owner's click AND an approval card; an agent has no way to call it.
      add('POST', '/api/browser/get', async () => {
        if (getting) throw new HttpError(409, 'A Lightpanda download is already waiting for approval or running.');
        getting = true; emit();
        try {
          const r = await getLightpanda(getPorts, {
            dataDir: deps.dataDir, ...(cfg().managedSha256 ? { cfgSha: cfg().managedSha256 } : {}), pins,
            approve: (a) => deps.approvals.request('browser-get', 'browser', 'browser_get_lightpanda', { ...a }, undefined, { summary: a.summary }),
          });
          getting = false;
          emit();
          return { ok: r.ok, steps: r.steps, status: statusFor() };
        } finally { if (getting) { getting = false; emit(); } }
      });
      // Starts the program, connects, asks for the list of pages, stops it. Shows the owner whether the build works with the options Legion needs.
      add('POST', '/api/browser/test', async () => {
        const b = await binary();
        if ('error' in b) return { ok: false, detail: b.error };
        let free: () => void;
        try { free = manager.reserve(); } catch (e) { return { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
        let run;
        try { run = await launchBrowser(ports, b.ref, { allowLocal: false }); } catch (e) { free(); return { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
        try { await run.cdp.send('Target.getTargets'); return { ok: true, detail: 'Lightpanda started with Legion\'s safety options and answered on 127.0.0.1.' }; }
        catch (e) { return { ok: false, detail: `It started but did not answer: ${e instanceof Error ? e.message : String(e)}` }; }
        finally { await run.stop().catch(() => undefined); free(); }
      });
      // Native only (the app's confirmation dialog): local addresses, on listed ports, until the next restart. Port-list entries are 1..65535.
      add('POST', '/api/browser/local', ({ req, body }) => {
        needNative(req);
        if (!isObj(body) || typeof body.allow !== 'boolean') throw new HttpError(400, 'allow must be true or false');
        const list = Array.isArray(body.ports) ? body.ports : [];
        if (list.length > 20 || list.some((x) => !Number.isInteger(x) || (x as number) < 1 || (x as number) > 65535)) throw new HttpError(400, 'ports must be a list of up to 20 port numbers');
        local = body.allow ? { allow: true, ports: list as number[] } : { allow: false, ports: [] };
        log(`browser: local addresses ${local.allow ? 'allowed' : 'refused'}`);
        emit();
        return statusFor();
      });
    },
    async dispose() { await manager.disposeAll(); },
  };
}
