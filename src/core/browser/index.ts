/**
 * The browser module. OFF by default. When switched on in Settings every agent gets the in-process `legion_browser` tools; each run gets its own
 * headless Chromium-family browser (Microsoft Edge, Google Chrome or Brave, already on this computer; nothing is downloaded), started on its first page
 * and stopped when the run ends. Every request passes Legion's own checks through the CDP Fetch domain. Plan: claude/plan-browser.md.
 * Admin routes (default-deny, not in the MCP client list): GET /api/browser, POST /api/browser/{config,check,local}. Choosing the browser program and
 * "allow local addresses" need the app's native confirmation; allow-local lives in memory only (it is off after every restart).
 */
import { randomBytes } from 'node:crypto';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { BROWSER_LIMITS, CHROMIUM_MIN_MAJOR } from '../../shared/browser.js';
import type { BrowserCheckResult, BrowserConfig, BrowserStatusView, ChromiumFound } from '../../shared/browser.js';
import type { AgentProfile, Task } from '../../shared/types.js';
import { NATIVE_HEADER, safeEqual } from '../admin.js';
import { liveSecrets } from '../kg/index.js';
import type { CoreModule, ModuleDeps, ModuleJob, TaskEndOutcome } from '../modules.js';
import { HttpError } from '../server.js';
import { chromiumEngine } from './chromium.js';
import type { ChromiumIo } from './chromium.js';
import type { BrowserEngineDef } from './engine.js';
import { LaunchError } from './launcher.js';
import type { LaunchPorts } from './launcher.js';
import { BrowserManager } from './manager.js';
import { lookupAll } from './resolve.js';
import type { Resolver } from './resolve.js';
import { BrowserSession, SessionRefusal } from './session.js';
import { BrowserState } from './state.js';
import { chromiumIo as realChromiumIo, createLaunchPorts } from './system.js';
import { BROWSER_PREAMBLE_ON, buildBrowserServer } from './tools.js';
import type { GuardOptions } from './url-guard.js';

export { BrowserState } from './state.js';

export interface BrowserModuleOptions {
  state?: BrowserState;
  /** Test seams. Production passes none of them. */
  launchPorts?: LaunchPorts;
  resolve?: Resolver;
  limits?: Partial<typeof BROWSER_LIMITS>;
  nativeSecret?: string;
  log?: (m: string) => void;
  /** The file system view, platform and environment used to look for Edge/Chrome. */
  chromiumIo?: ChromiumIo;
  platform?: NodeJS.Platform;
  hostEnv?: NodeJS.ProcessEnv;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ISOLATION_NOTE = 'The browser runs on this computer with your user rights, in a fresh empty profile. A cloud VM is the only isolated way to browse: use the VM live view when you need that.';

export function createBrowserModule(deps: ModuleDeps, opts: BrowserModuleOptions = {}): CoreModule & { state: BrowserState; manager: BrowserManager; engines: BrowserEngineDef[] } {
  const log = opts.log ?? (() => undefined);
  const state = opts.state ?? new BrowserState(deps.dataDir);
  const cfg = (): BrowserConfig => state.config;
  const ports = opts.launchPorts ?? createLaunchPorts();
  const resolve = opts.resolve ?? lookupAll;
  // In memory only: not written anywhere, so a file edit cannot turn it on and a restart turns it off.
  let local: { allow: boolean; ports: number[] } = { allow: false, ports: [] };
  let lastRun: BrowserStatusView['lastRun'];

  const guard = (): GuardOptions => ({ allowLocal: local.allow, localPorts: local.ports, allowDomains: cfg().allowDomains });

  // ---- the one engine
  const engine = chromiumEngine({ io: opts.chromiumIo ?? realChromiumIo(), platform: opts.platform ?? process.platform, env: opts.hostEnv ?? process.env, userPath: () => cfg().chromiumPath });
  const engines = [engine];
  let detected: { at: number; key: string; v: { found: ChromiumFound | null; tried: string[] } } | null = null;
  const detect = (): { found: ChromiumFound | null; tried: string[] } => {
    const key = cfg().chromiumPath ?? '';
    if (!detected || detected.key !== key || Date.now() - detected.at > 30_000) detected = { at: Date.now(), key, v: engine.detect() };
    return detected.v;
  };
  const labelOf = (f: ChromiumFound): string => `${f.name}${f.version ? ` ${f.version}` : ''} (headless)`;
  /** The browser to start, or a plain reason it cannot be. */
  const usable = (): { found: ChromiumFound } | { error: string } => {
    const { found, tried } = detect();
    if (!found) return { error: cfg().chromiumPath ? `The browser you chose (${cfg().chromiumPath}) was not found. Choose another path or clear it in Settings, Browser.` : `No Edge or Chrome found: install one or set a path in Settings, Browser. (Looked in: ${tried.slice(0, 4).join('; ')}.)` };
    if (found.tooOld) return { error: `${found.name} ${found.version} is too old for headless mode (it needs version ${CHROMIUM_MIN_MAJOR} or newer). Update it or choose another browser.` };
    return { found };
  };
  const noteRun = (ok: boolean, browser: string, note: string): void => { lastRun = { at: new Date().toISOString(), ok, browser, note: note.slice(0, 200) }; };

  const sessionDeps = (reserve: () => () => void) => ({
    guard,
    resolve,
    limits: opts.limits,
    async launch() {
      const u = usable();
      if ('error' in u) { noteRun(false, '', u.error); throw new LaunchError(u.error); }
      const free = (() => { try { return reserve(); } catch (e) { throw new LaunchError(e instanceof Error ? e.message : String(e)); } })();
      try {
        const run = await engine.launch(ports, u.found, { allowLocal: local.allow, label: labelOf(u.found), ...(opts.limits?.startTimeoutMs ? { startMs: opts.limits.startTimeoutMs } : {}) });
        noteRun(true, run.label ?? labelOf(u.found), 'Started for a task.');
        const stop = run.stop.bind(run);
        void run.exited.then(() => free());
        return { ...run, stop: async () => { try { await stop(); } finally { free(); } } };
      } catch (e) { free(); noteRun(false, labelOf(u.found), e instanceof Error ? e.message : String(e)); throw e; }
    },
  });

  const manager: BrowserManager = new BrowserManager((taskId, reserve) => new BrowserSession({
    ...sessionDeps(reserve),
    approveOrigin: async (o, u): Promise<boolean> => (await manager.peek(taskId)?.approveOrigin?.(o, u)) ?? false,
  }), opts.limits);

  /**
   * "Open test page": starts the browser, loads a harmless page that Legion answers itself through the interception (no server, no network), checks the
   * page loaded, its JavaScript ran, and that the guard refuses a deliberate request to a forbidden address. Always stops the browser.
   */
  async function check(): Promise<BrowserCheckResult> {
    const steps: BrowserCheckResult['steps'] = [];
    const at = new Date().toISOString();
    const done = (ok: boolean, browser?: string): BrowserCheckResult => { noteRun(ok, browser ?? '', steps.filter((s) => !s.ok).map((s) => s.detail).join(' ') || 'The check page worked.'); return { ok, at, ...(browser ? { browser } : {}), steps }; };
    const u = usable();
    if ('error' in u) { steps.push({ step: 'browser', ok: false, detail: u.error }); return done(false); }
    const label = labelOf(u.found);
    steps.push({ step: 'browser', ok: true, detail: `Found ${label} at ${u.found.path}.` });
    let free: () => void;
    try { free = manager.reserve(); } catch (e) { steps.push({ step: 'start', ok: false, detail: e instanceof Error ? e.message : String(e) }); return done(false, label); }
    const nonce = randomBytes(8).toString('hex');
    const url = `https://legion-check.invalid/${nonce}`;
    const probe = `http://169.254.169.254/legion-check-${nonce}`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Legion browser check</title></head><body><p>Legion browser check</p><p id="js">js-pending</p><script>document.getElementById('js').textContent='js-ok';</script><img src="${probe}" alt=""></body></html>`;
    const session = new BrowserSession({ ...sessionDeps(() => () => undefined), internal: { url, html, probe }, approveOrigin: async () => true });
    try {
      let view;
      try { view = await session.open(url); } catch (e) {
        steps.push({ step: 'start', ok: false, detail: e instanceof LaunchError || e instanceof SessionRefusal || e instanceof Error ? e.message : String(e) });
        return done(false, label);
      }
      steps.push({ step: 'start', ok: true, detail: 'The browser started and answered.' });
      steps.push({ step: 'load', ok: view.title === 'Legion browser check', detail: view.title === 'Legion browser check' ? 'The test page loaded.' : 'The test page did not load as expected.' });
      let js = false;
      try { js = (await session.text('#js')).text.trim() === 'js-ok'; } catch { js = false; }
      steps.push({ step: 'javascript', ok: js, detail: js ? 'JavaScript ran in the page.' : 'JavaScript did not run in the page.' });
      steps.push({ step: 'guard', ok: session.probeBlocked, detail: session.probeBlocked ? 'A request to a forbidden address (a cloud metadata address) was refused by Legion\'s guard and never sent.' : 'The guard did NOT refuse the forbidden request: do not use the browser tool.' });
    } finally { await session.close().catch(() => undefined); free(); }
    return done(steps.every((s) => s.ok), label);
  }

  const statusFor = (): BrowserStatusView => {
    const c = cfg();
    const d = detect();
    const note = !d.found
      ? (c.chromiumPath ? `The browser you chose (${c.chromiumPath}) was not found.` : 'No Edge or Chrome found: install one or set a path.')
      : d.found.tooOld ? `${d.found.name} ${d.found.version} is too old for headless mode (needs ${CHROMIUM_MIN_MAJOR} or newer).`
        : `Pages are read with ${labelOf(d.found)}. Nothing is downloaded. Every request is checked by Legion first, every page is treated as untrusted text, and the first page and each new site ask you first. ${ISOLATION_NOTE}`;
    return {
      enabled: c.enabled, engines: engines.map((e) => ({ id: e.id, label: e.label })), browser: d.found, tried: d.tried.slice(0, 8),
      ...(c.chromiumPath ? { chosenPath: c.chromiumPath } : {}),
      allowDomains: c.allowDomains, allowLocal: local.allow, running: manager.running(), platform: opts.platform ?? process.platform,
      ...(lastRun ? { lastRun } : {}), note,
    };
  };

  const needNative = (req: unknown): void => {
    const h = (req as { headers?: Record<string, string | string[] | undefined> }).headers?.[NATIVE_HEADER];
    if (!opts.nativeSecret) throw new HttpError(403, 'native_unavailable: this change needs the Legion app window (this core was not started by it)');
    if (typeof h !== 'string' || !safeEqual(h, opts.nativeSecret)) throw new HttpError(403, 'native_required: only the Legion app itself may do this, after its confirmation dialog');
  };

  return {
    id: 'browser', state, manager, engines,
    mcpServers(agent: AgentProfile, job?: ModuleJob): Record<string, McpServerConfig> {
      if (!cfg().enabled) return {};
      return {
        legion_browser: buildBrowserServer(agent, job, {
          manager, guard, resolve, approvals: deps.approvals, secrets: () => liveSecrets(deps.config), modeOf: (id) => { try { return deps.store?.getAgent(id)?.approval; } catch { return undefined; } },
          statusLine: (taskId) => {
            const e = manager.peek(taskId);
            const d = detect();
            return `Browser tool: on. Browser: ${e?.session.engineLabel || (d.found ? labelOf(d.found) : 'none found')}. Page open: ${e?.session.started ? 'yes' : 'no'}. Reads text only (no screenshots). Every request is checked by Legion before it is sent. Local addresses: ${local.allow ? 'allowed on listed ports' : 'refused'}. Allowed domains: ${cfg().allowDomains.length ? cfg().allowDomains.join(', ') : 'any public site'}.`;
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
        // choosing which program Legion starts is code execution: the app's confirmation dialog is required
        if ('chromiumPath' in body) needNative(req);
        const patch: Partial<BrowserConfig> = {};
        if ('enabled' in body) { if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false'); patch.enabled = body.enabled; }
        if ('chromiumPath' in body) { if (body.chromiumPath !== null && typeof body.chromiumPath !== 'string') throw new HttpError(400, 'chromiumPath must be text'); patch.chromiumPath = body.chromiumPath === null || body.chromiumPath === '' ? undefined : body.chromiumPath as string; }
        if ('allowDomains' in body) { if (!Array.isArray(body.allowDomains) || body.allowDomains.some((x) => typeof x !== 'string')) throw new HttpError(400, 'allowDomains must be a list of text'); patch.allowDomains = body.allowDomains as string[]; }
        try { state.update(patch); } catch (e) { throw new HttpError(500, `Could not save the browser settings: ${e instanceof Error ? e.message : String(e)}`); }
        detected = null;
        return statusFor();
      });
      // "Open test page": admin only, started by the owner's click.
      add('POST', '/api/browser/check', async () => ({ result: await check(), status: statusFor() }));
      // Native only (the app's confirmation dialog): local addresses, on listed ports, until the next restart. Port-list entries are 1..65535.
      add('POST', '/api/browser/local', ({ req, body }) => {
        needNative(req);
        if (!isObj(body) || typeof body.allow !== 'boolean') throw new HttpError(400, 'allow must be true or false');
        const list = Array.isArray(body.ports) ? body.ports : [];
        if (list.length > 20 || list.some((x) => !Number.isInteger(x) || (x as number) < 1 || (x as number) > 65535)) throw new HttpError(400, 'ports must be a list of up to 20 port numbers');
        local = body.allow ? { allow: true, ports: list as number[] } : { allow: false, ports: [] };
        log(`browser: local addresses ${local.allow ? 'allowed' : 'refused'}`);
        return statusFor();
      });
    },
    async dispose() { await manager.disposeAll(); },
  };
}
