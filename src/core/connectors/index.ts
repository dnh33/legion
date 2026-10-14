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
import type { GithubActivityItem, GithubApp } from '../../shared/github-area.js';
import type { Project } from '../../shared/projects.js';
import { readRepoInfo } from '../ci/repo.js';
import type { RepoRef } from '../ci/repo.js';
import { HttpError } from '../server.js';
import type { CoreModule, ModuleDeps, ModuleJob } from '../modules.js';
import { CONNECTORS_PREAMBLE, CONNECTORS_SERVER_NAME, buildConnectorsServer } from './gateway.js';
import type { GatewayDeps, ReadTool } from './gateway.js';
import { GithubArea } from './github/area.js';
import { DeviceFlowError, getGitHubClient } from './github/client.js';
import type { GitHubClient } from './github/client.js';
import { GITHUB_APPS_SETTINGS_URL } from './github/hosts.js';
import { addRepoAdminRoutes } from './github/repo-admin-routes.js';
import type { KeySource, StoreStatus } from './store.js';

export { CONNECTORS_SERVER_NAME } from './gateway.js';

export type FlowView =
  | { phase: 'idle' }
  | { phase: 'pending'; userCode: string; verificationUri: string; expiresAt: number }
  | { phase: 'failed'; reason: string; message: string };

/** `{ on: boolean }` and nothing else. */
const onOf = (body: unknown): boolean => {
  const on = body && typeof body === 'object' ? (body as { on?: unknown }).on : undefined;
  if (typeof on !== 'boolean') throw new HttpError(400, 'on must be true or false');
  return on;
};

export interface ConnectorsOptions {
  /** The core's data key holder: the flow refuses to start without a key unless the caller said memoryOnly. */
  keys: Pick<KeySource, 'get'>;
  /** Defaults to the core's GitHub clients: read (the default) and write. */
  client?: (app?: GithubApp) => GitHubClient | undefined;
  /** The projects, for "which projects use this repo" and "let this project's agents read or write". Absent: no project is known. */
  projects?: { list(): Project[]; get(id: string): Project | undefined };
  /** The GitHub repo a project folder's git remote names. Default: read from the folder's .git. */
  repoOf?: (folder: string) => RepoRef | null;
  /** What agents did per repo through Legion, newest first. Default: nothing recorded yet. */
  activity?: () => GithubActivityItem[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Tests inject tool spies here (see GatewayDeps.tools). */
  tools?: Record<string, ReadTool>;
  /** The signed-in write app (plugged in by the writes unit); undefined means not signed in. */
  writeApp?: GatewayDeps['writeApp'];
  /** Tests inject write-tool spies here (see GatewayDeps.writeTools). */
  writeTools?: Record<string, ReadTool>;
}

export interface ConnectorsModule extends CoreModule {
  /** Test hook: the current sign-in flow as the window sees it. */
  flow(): FlowView;
}

export function createConnectorsModule(deps: ModuleDeps, opts: ConnectorsOptions): ConnectorsModule {
  const log = opts.log ?? (() => undefined);
  const clientOf = (app: GithubApp = 'read'): GitHubClient | undefined => (opts.client ? opts.client(app) : getGitHubClient(app));
  const client = (): GitHubClient | undefined => clientOf('read');
  // one sign-in flow per App; `view` and `abort` are the read App's, the one Settings shows
  let view: FlowView = { phase: 'idle' };
  let abort: AbortController | undefined;
  const writeFlow: { view: FlowView; abort: AbortController | undefined } = { view: { phase: 'idle' }, abort: undefined };
  const now = (): number => (opts.now ?? Date.now)();
  const area = new GithubArea({
    dataDir: deps.dataDir, client: clientOf, now, ...(deps.bus ? { bus: deps.bus } : {}),
    agents: {
      list: () => deps.store.listAgents(),
      save: (a) => { const saved = deps.store.upsertAgent({ ...a, updatedAt: new Date(now()).toISOString() }); deps.bus.emit({ type: 'agent.updated', agent: saved }); },
    },
    ...(opts.projects ? { projects: opts.projects } : {}),
    repoOf: opts.repoOf ?? ((folder) => readRepoInfo(folder).repo),
    activity: opts.activity ?? (() => []),
    log,
  });

  const gatewayDeps = (): GatewayDeps => ({
    agent: (id) => deps.store.getAgent(id),
    task: (id) => deps.store.getTask(id) as { status?: string; origin?: { viaMcpClient?: boolean } } | undefined,
    github: () => client(),
    dataDir: deps.dataDir,
    ...(opts.writeApp ? { writeApp: opts.writeApp } : {}),
    ...(opts.writeTools ? { writeTools: opts.writeTools } : {}),
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
      () => { if (abort === ac) { abort = undefined; view = { phase: 'idle' }; } area.invalidate(); log('connectors: github signed in'); },
      (e: unknown) => {
        if (abort !== ac) return; // cancelled or replaced: the newer state stands
        abort = undefined;
        view = e instanceof DeviceFlowError && e.kind !== 'cancelled' ? { phase: 'failed', reason: e.kind, message: e.message } : { phase: 'idle' };
      },
    );
    return mine;
  };

  /** The write App's sign-in: the same device flow, its own state. The area re-reads GitHub once it is done. */
  const startWriteFlow = async (memoryOnly: boolean): Promise<FlowView> => {
    const c = clientOf('write');
    if (!c || !c.deviceFlowAvailable()) throw new HttpError(409, 'not-available');
    if (!opts.keys.get() && !memoryOnly) throw new HttpError(409, 'needs-key');
    if (writeFlow.view.phase === 'pending' && writeFlow.view.expiresAt > now()) return writeFlow.view;
    writeFlow.abort?.abort();
    writeFlow.abort = undefined;
    let f: Awaited<ReturnType<GitHubClient['startDeviceFlow']>>;
    try { f = await c.startDeviceFlow(); } catch (e) {
      const kind = e instanceof DeviceFlowError ? e.kind : 'failed';
      writeFlow.view = { phase: 'failed', reason: kind, message: e instanceof DeviceFlowError ? e.message : 'GitHub did not accept the sign-in.' };
      return writeFlow.view;
    }
    const ac = new AbortController();
    writeFlow.abort = ac;
    writeFlow.view = { phase: 'pending', userCode: f.userCode, verificationUri: f.verificationUri, expiresAt: f.expiresAt };
    const mine = writeFlow.view;
    void f.poll(ac.signal).then(
      () => { if (writeFlow.abort === ac) { writeFlow.abort = undefined; writeFlow.view = { phase: 'idle' }; } area.invalidate(); log('connectors: github write signed in'); },
      (e: unknown) => {
        if (writeFlow.abort !== ac) return;
        writeFlow.abort = undefined;
        writeFlow.view = e instanceof DeviceFlowError && e.kind !== 'cancelled' ? { phase: 'failed', reason: e.kind, message: e.message } : { phase: 'idle' };
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
          writeAvailable: !!clientOf('write')?.deviceFlowAvailable(),
          key: opts.keys.get() ? 'installed' : 'missing',
          storage,
          signedIn: c ? await c.signedIn() : false,
          flow: view,
          writeFlow: writeFlow.view,
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
        area.invalidate();
        return { ok: true, revokeUrl: GITHUB_APPS_SETTINGS_URL };
      });

      // ---- the GitHub area (admin-only like the routes above; none is on the MCP client route list)
      add('GET', '/api/github/area', ({ url }) => area.view(url.searchParams.get('force') === '1'));
      add('PUT', '/api/github/repos/:owner/:name/tick', ({ params, body }) => area.tick(params[0] ?? '', params[1] ?? '', onOf(body)));
      add('PUT', '/api/github/agents-switch', ({ body }) => area.agentsSwitch(onOf(body)));
      add('POST', '/api/github/apps/write/connect', ({ body }) => startWriteFlow(!!body && typeof body === 'object' && (body as { memoryOnly?: unknown }).memoryOnly === true));
      add('POST', '/api/github/apps/write/cancel', () => {
        writeFlow.abort?.abort();
        writeFlow.abort = undefined;
        if (writeFlow.view.phase === 'pending') writeFlow.view = { phase: 'idle' };
        return { ok: true };
      });
      add('POST', '/api/github/apps/write/disconnect', async () => {
        writeFlow.abort?.abort();
        writeFlow.abort = undefined;
        writeFlow.view = { phase: 'idle' };
        await clientOf('write')?.disconnect();
        area.invalidate();
        return { ok: true, revokeUrl: GITHUB_APPS_SETTINGS_URL };
      });
      add('GET', '/api/github/projects-using/:owner/:name', ({ params }) => area.projectsUsing(params[0] ?? '', params[1] ?? ''));
      add('GET', '/api/github/projects/:id/repo', ({ params }) => area.projectRepo(params[0] ?? ''));
      add('PUT', '/api/github/projects/:id/access', ({ params, body }) => area.projectAccess(params[0] ?? '', (body as { level?: unknown } | null)?.level));
      addRepoAdminRoutes(add, { dataDir: deps.dataDir, client: clientOf, area });
    },

    dispose() { cancelFlow(); writeFlow.abort?.abort(); area.dispose(); },
  };
  return mod;
}
