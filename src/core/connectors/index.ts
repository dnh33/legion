/**
 * The connectors module: the gateway (in-process MCP server, ./gateway.ts) and the admin routes behind Settings, Connectors, GitHub.
 *
 * Routes are admin-only by the default-deny gate (none is on the MCP-client route list). The device flow runs in the core: the device code
 * stays inside the client's closure; the window gets only the user code and the fixed GitHub page. The flow cannot start before the core
 * holds the data key (so the sign-in is stored encrypted), unless the window says `memoryOnly` (the keystore is unusable and the owner
 * chose to sign in each launch): `needs-key` (409) otherwise.
 */
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { AgentProfile } from '../../shared/types.js';
import { HttpError } from '../server.js';
import type { CoreModule, ModuleDeps, ModuleJob } from '../modules.js';
import { CONNECTORS_PREAMBLE, CONNECTORS_SERVER_NAME, buildConnectorsServer } from './gateway.js';
import type { GatewayDeps, ReadTool } from './gateway.js';
import { DeviceFlowError, getGitHubClient } from './github/client.js';
import type { GitHubClient } from './github/client.js';
import { GITHUB_APPS_SETTINGS_URL } from './github/hosts.js';
import type { KeySource, StoreStatus } from './store.js';

export { CONNECTORS_SERVER_NAME } from './gateway.js';

export type FlowView =
  | { phase: 'idle' }
  | { phase: 'pending'; userCode: string; verificationUri: string; expiresAt: number }
  | { phase: 'failed'; reason: string; message: string };

export interface ConnectorsOptions {
  /** The core's data key holder: the flow refuses to start without a key unless the caller said memoryOnly. */
  keys: Pick<KeySource, 'get'>;
  /** Defaults to the core's one GitHub client. */
  client?: () => GitHubClient | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Tests inject tool spies here (see GatewayDeps.tools). */
  tools?: Record<string, ReadTool>;
}

export interface ConnectorsModule extends CoreModule {
  /** Test hook: the current sign-in flow as the window sees it. */
  flow(): FlowView;
}

export function createConnectorsModule(deps: ModuleDeps, opts: ConnectorsOptions): ConnectorsModule {
  const log = opts.log ?? (() => undefined);
  const client = (): GitHubClient | undefined => (opts.client ?? getGitHubClient)();
  let view: FlowView = { phase: 'idle' };
  let abort: AbortController | undefined;

  const gatewayDeps = (): GatewayDeps => ({
    agent: (id) => deps.store.getAgent(id),
    task: (id) => deps.store.getTask(id) as { status?: string; origin?: { viaMcpClient?: boolean } } | undefined,
    github: () => client(),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
  });

  const cancelFlow = (): void => { abort?.abort(); abort = undefined; if (view.phase === 'pending') view = { phase: 'idle' }; };

  const startFlow = async (memoryOnly: boolean): Promise<FlowView> => {
    const c = client();
    if (!c) throw new HttpError(409, 'not-available');
    if (!c.deviceFlowAvailable()) throw new HttpError(409, 'not-available');
    if (!opts.keys.get() && !memoryOnly) throw new HttpError(409, 'needs-key');
    if (view.phase === 'pending' && view.expiresAt > (opts.now ?? Date.now)()) return view;
    cancelFlow();
    let f: Awaited<ReturnType<GitHubClient['startDeviceFlow']>>;
    try { f = await c.startDeviceFlow(); } catch (e) {
      const kind = e instanceof DeviceFlowError ? e.kind : 'failed';
      view = { phase: 'failed', reason: kind, message: e instanceof DeviceFlowError ? e.message : 'GitHub did not accept the sign-in.' };
      return view;
    }
    const ac = new AbortController();
    abort = ac;
    view = { phase: 'pending', userCode: f.userCode, verificationUri: f.verificationUri, expiresAt: f.expiresAt };
    const mine = view;
    void f.poll(ac.signal).then(
      () => { if (abort === ac) { abort = undefined; view = { phase: 'idle' }; } log('connectors: github signed in'); },
      (e: unknown) => {
        if (abort !== ac) return; // cancelled or replaced: the newer state stands
        abort = undefined;
        view = e instanceof DeviceFlowError && e.kind !== 'cancelled' ? { phase: 'failed', reason: e.kind, message: e.message } : { phase: 'idle' };
      },
    );
    return mine;
  };

  const mod: ConnectorsModule = {
    id: 'connectors',
    flow: () => view,

    mcpServers(agent: AgentProfile, job?: ModuleJob): Record<string, McpServerConfig> {
      // No run context or no way to taint the run: no server at all (fail closed). Not opted in: no server.
      if (!job || typeof job.markTainted !== 'function') return {};
      if (!Array.isArray(agent.connectors) || !agent.connectors.includes('github')) return {};
      return { [CONNECTORS_SERVER_NAME]: buildConnectorsServer(agent, job, gatewayDeps()) };
    },

    preamble(agent: AgentProfile): string {
      return Array.isArray(agent.connectors) && agent.connectors.includes('github') ? CONNECTORS_PREAMBLE : '';
    },

    routes(add) {
      // Status without a network call: what the Settings page needs to draw itself and to decide whether Connect needs the key first.
      add('GET', '/api/connectors/github', async () => {
        const c = client();
        const storage: StoreStatus | 'unavailable' = c ? await c.storageStatus() : 'unavailable';
        return {
          available: !!c && c.deviceFlowAvailable(),
          key: opts.keys.get() ? 'installed' : 'missing',
          storage,
          signedIn: c ? await c.signedIn() : false,
          flow: view,
          revokeUrl: GITHUB_APPS_SETTINGS_URL,
        };
      });
      // Who is signed in, the permissions and the rate limit (one to three requests to GitHub).
      add('GET', '/api/connectors/github/connection', async () => {
        const c = client();
        if (!c) throw new HttpError(409, 'not-available');
        try { return await c.connection(); } catch (e) { throw new HttpError(502, e instanceof Error && e.name === 'GhError' ? e.message : 'Could not read the GitHub connection.'); }
      });
      add('POST', '/api/connectors/github/connect', async ({ body }) => {
        const memoryOnly = !!body && typeof body === 'object' && (body as { memoryOnly?: unknown }).memoryOnly === true;
        return startFlow(memoryOnly);
      });
      add('POST', '/api/connectors/github/cancel', () => { cancelFlow(); return { ok: true }; });
      add('POST', '/api/connectors/github/disconnect', async () => {
        cancelFlow();
        view = { phase: 'idle' };
        await client()?.disconnect();
        return { ok: true, revokeUrl: GITHUB_APPS_SETTINGS_URL };
      });
    },

    dispose() { cancelFlow(); },
  };
  return mod;
}
