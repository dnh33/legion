#!/usr/bin/env node
/** Legion Core composition root. */
// FIRST import, on purpose: it wraps stdout and stderr in the redactor before any other module can write (test/log-wiring.test.ts).
import { describeError, setFatalSink } from '../core/log/install.js';
// SECOND import, on purpose: refuses TLS chains through the compromised eMudhra CA keys before any module can connect (test/tls-blocklist.test.ts).
import '../core/tls-blocklist-install.js';
import { ProviderRuntime } from '../core/providers/runtime.js';
import { ProviderKeys, keyFileFor } from '../core/providers/secrets.js';
import { ProviderKeyring } from '../core/providers/keyring.js';
import { updateCommitted } from '../core/updater/committed.js';
import { createProvidersModule } from '../core/providers/routes.js';
import { WebSearchService } from '../core/web-search/index.js';
import { createWebSearchModule } from '../core/web-search/routes.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, dataDir, loadConfig, scrubHostSessionEnv, VERSION } from '../shared/config.js';
import { ADMIN_STDIN_FLAG, readLaunchSecrets } from '../core/admin.js';
import { killAllAgentsSync, registerLegionSecrets, sweepStaleAgents } from '../core/acp/process.js';
import { revokeAllRunTokens } from '../core/acp/run-tokens.js';
import { hostWaitSeams, warmHermes as hermesWarmUp, type AgentHostDeps } from '../core/acp/detect.js';
import { BUILTIN_HERMES, type AcpEntry } from '../shared/acp-view.js';
import { usesAgentHost } from '../shared/runtime.js';
import { ConnectorKeyring } from '../core/connectors/keyring.js';
import { TokenStore } from '../core/connectors/store.js';
import { createGitHubClient } from '../core/connectors/github/client.js';
import { createConnectorsModule } from '../core/connectors/index.js';
import { ApprovalBroker } from '../core/approvals.js';
import { QuestionBroker } from '../core/questions.js';
import { EventBus } from '../core/bus.js';
import { getCatalog } from '../core/catalog.js';
import { makeBoatGetter, SettingsService } from '../core/settings.js';
import { runDoctor } from '../core/doctor.js';
import { Engine } from '../core/engine.js';
import { createServer } from '../core/server.js';
import { listenLoopback } from '../core/net-guard.js';
import { createBlenderModule } from '../core/blender/index.js';
import { createBrowserModule } from '../core/browser/index.js';
import { createBsvModule, createBsvState } from '../core/bsv/index.js';
import { createCommsModule } from '../core/comms/index.js';
import { createHouseModule } from '../core/house/index.js';
import { createArmoryModule } from '../core/armory/index.js';
import { createCiModule } from '../core/ci/index.js';
import { createLogsModule, openLogSink } from '../core/log/index.js';
import { createGateSuggestionsModule } from '../core/gate-suggestions.js';
import { createWritesResolver, resolveGitHub } from '../core/ci/wiring.js';
import { createKnowledgeModule } from '../core/kg/index.js';
import { createUpdaterModule } from '../core/updater/index.js';
import { createProjectsModule, ProjectStore } from '../core/projects/index.js';
import { createAwayCore, createAwayModule } from '../core/away/index.js';
import { createGatesCore, createGatesModule } from '../core/gates-settings/index.js';
import { createActivityLog, createActivityModule } from '../core/activity/index.js';
import { GatesKeyring } from '../core/gates-settings/keyring.js';
import { agentIdVisible } from '../core/visibility.js';
import { BoardStore, createBoardModule, graphNotes } from '../core/projects/board/index.js';
import { attemptLimits } from '../core/marshal/ledger.js';
import type { ModuleDeps } from '../core/modules.js';
import { Store } from '../core/store.js';
import { isPackageInstall } from '../electron/resolve-node.js';
import { installFolderTargets } from '../core/exec/canonical-path.js';
import { VmManager } from '../core/vm-manager.js';

// One sink: <dataDir>/logs. log() is a thin call into it (component 'core') and writes nothing else: core.log (the raw stream file
// Electron main keeps) holds only what other code prints, crashes and the ready line. There is no second writer.
const sink = openLogSink(dataDir());
const clog = sink.logger('core');
const log = (...a: unknown[]) => {
  const text = a.map((x) => (x instanceof Error ? x.stack ?? x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  if (a.some((x) => x instanceof Error)) clog.error('core.error', { message: text }); else clog.info('core.message', { message: text });
};
/** Writes what is queued and closes the files: exit and fatal paths. */
const closeLogs = () => { try { sink.flushSync(); sink.closeAll(); } catch { /* nothing more to do */ } };
// From here a fatal error is logged and flushed, and the process stays up (until now install.ts prints it and exits).
setFatalSink((event, e) => {
  const message = describeError(e);
  clog.error(event, { message });
  process.stderr.write(`[${new Date().toISOString()}] ${event} ${message}
`);
  sink.flushSync();
});

async function main() {
  // Per-launch admin secret from the stdin pipe (Electron main only). None for a headless/bridge-started core: admin routes stay closed.
  // The second line is the NATIVE secret (main only, never the window): BSV policy changes need it as well.
  // The later lines (gates, provider and connectors keys, memory only) come from the same pipe. With the callback the answer waits until Electron main has ended the pipe
  // (it always does, right after writing), so every keyring below is complete before the key stores are built; a 5 s cap keeps a stuck pipe from holding the start.
  const connectorKeyring = new ConnectorKeyring();
  const gatesKeyring = new GatesKeyring();
  // the provider keys' data key (PKEY <hex>, or PKEY - unavailable / unreadable): memory only, like the other two
  const providerKeyring = new ProviderKeyring();
  // read BEFORE readLaunchSecrets, which clears the flag: an app-started core with no PKEY line is "no key", not "no app"
  const launchedByApp = process.env[ADMIN_STDIN_FLAG] === '1';
  const { admin: adminSecret, native: nativeSecret } = await readLaunchSecrets(process.env, process.stdin, (line) => { connectorKeyring.installLine(line); gatesKeyring.installLine(line); providerKeyring.installLine(line); });
  // Run standalone even if launched from inside a Claude host session.
  const clean = scrubHostSessionEnv(process.env);
  for (const k of Object.keys(process.env)) if (!(k in clean)) delete process.env[k];
  const config = loadConfig({ log: (l) => log(l) });
  // an agent host child never gets these two values in its environment; agents a crashed earlier core left behind are cleaned up
  registerLegionSecrets([config.authToken, adminSecret, nativeSecret]);
  try { sweepStaleAgents(dataDir()); } catch (e) { log('agent sweep failed', e); }
  const store = new Store(dataDir());
  // The one GitHub client (no network until something asks). Everyone else reaches it through getGitHubClient().
  createGitHubClient({ tokens: new TokenStore(join(dataDir(), 'connectors'), connectorKeyring), log: (l) => log(l) });
  store.seedDefaults(config.workspaceDir);
  const recovered = store.recoverInterrupted();
  if (recovered) log(`recovered ${recovered} interrupted task(s)`);

  const bus = new EventBus();
  // Follows live Settings edits of config.boat.
  const getBoat = makeBoatGetter(config);
  const boatConfigured = () => !!config.boat.apiKey;

  const vms = new VmManager({ store, bus, getBoat, boatConfig: () => config.boat });
  const approvals = new ApprovalBroker(bus);
  // structured questions (the agent's ask_user_question -> a card in the thread); the same lifetime and bus as approvals
  const questions = new QuestionBroker(bus);
  // other model providers (OpenAI-compatible endpoints); keys live in <dataDir>/providers/keys.json, never in config.json
  // providers ship (OpenRouter on by default); off only if config.json sets features.providers = false
  // ONE key store for the model providers and the web providers: a second instance on the same file would write its own copy back over the other's keys
  // With the data key from the launch line the keys are encrypted in providers/keys.enc; without it this is today's keys.json.
  const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const dataKey = providerKeyring.get();
  const noKey = providerKeyring.noKey();
  const providerKeys = new ProviderKeys(keyFileFor(dataDir()), { ...(dataKey ? { dataKey } : {}), ...(noKey ? { noKey } : {}), launchedByApp, committed: () => updateCommitted(installRoot) });
  // the optional web search and page read providers (off by default: both choices are the built-in tools); the service reads the live config.webSearch
  const webSearch = new WebSearchService({ config: () => config.webSearch, keys: providerKeys });
  const providerRuntime = config.features.providers ? new ProviderRuntime({ config, keys: providerKeys, cacheFile: join(dataDir(), 'provider-models.json') }) : undefined;
  // projects (owner-only groups of tasks, rooms, notes; own file <dataDir>/projects.json)
  const projects = new ProjectStore(dataDir(), config.workspaceDir);
  // the away features (0.3.0): the owner's absence settings, the spend ledger, pause and budget. The brokers and the engine read them; with no settings they behave as before
  // gatesCore is made just below; the notice for a reached budget asks it, when the budget is reached, whether the stop is on
  const awayCore = createAwayCore({ dataDir: dataDir(), bus, tasks: store, projects, stopsAtBudget: (pid) => gatesCore.gate('budget-stop', pid) !== false });
  approvals.setPolicy(awayCore.service.policy());
  questions.setPolicy(awayCore.service.policy());
  // gate presets (spec 2026-10-14 goals and gates): signed files, a key of their own (gates-key.bin), no looser preset without the key
  const gatesCore = createGatesCore({ dataDir: dataDir(), projects, keyring: gatesKeyring, inheritMcp: () => config.claude.inheritMcp === true });
  // the activity log is made before the engine: the engine writes its would-have-asked lines, the gates module its gate changes, the module its card and run lines
  const activity = createActivityLog({ dataDir: dataDir() });
  // Hermes detection: the Doctor and the model list read it, and the two waits below come from what it read in Hermes's own settings (cached, so a card never waits on a probe)
  const agentHost: AgentHostDeps = { dataDir: dataDir(), entries: () => config.acp.entries, envKeep: () => gatesCore.envKeep() };
  const seams = hostWaitSeams(() => config.acp.entries.find((e) => e.id === BUILTIN_HERMES.id));
  // R58: the model list and the Doctor at app start or after a settings save never start Hermes. The full check runs when the window opens or re-runs the Doctor,
  // at core start only when an agent uses Hermes (R62: answering the first-use card starts nothing), and at a Hermes run start (which at least reads Hermes's own two waits). A switched-off Hermes is never warmed.
  const warmHermes = (e: AcpEntry | undefined, runStart: boolean): void => {
    if (e) void hermesWarmUp(e, agentHost, { inUse: usesAgentHost(store.listAgents(), e.id), runStart }).catch((err) => log('hermes detection failed', err));
  };
  const engine = new Engine({ store, bus, vms, approvals, questions, config, boatConfigured, projects, agentHost: { dataDir: dataDir(), port: config.port, permissionWaitMs: seams.permissionWaitMs, toolWaitMs: seams.toolWaitMs, onRunStart: (e) => warmHermes(e, true) }, away: awayCore.service, modes: gatesCore.resolver, gates: gatesCore, activity, webSearch, ...(providerRuntime ? { providers: providerRuntime } : {}) });
  // lets ask/tell check a per-task model against what the account offers
  engine.bridge.catalog = () => getCatalog({ config, trustedFolders: () => gatesCore.trustedFolders() });
  let stopReaper: () => void = () => {};
  const restartReaper = (keyChanged = false) => {
    stopReaper(); stopReaper = boatConfigured() ? vms.startReaper() : () => {};
    // A new key knows nothing yet: forget the old key's findings. The permission probe (about 8 boat.dev calls) does NOT run at core start:
    // it runs when the user saves a key in Settings, on the first VM use, or when Settings, boat.dev opens (see BoatHealth.ensure).
    vms.health.reset();
    if (keyChanged && boatConfigured()) void vms.health.probe().catch(() => undefined);
  };
  const settings = new SettingsService({ config, bus, configPath: configPath(), dataDir: dataDir(), install: { dir: installRoot, packaged: isPackageInstall(installRoot) }, onBoatChange: () => restartReaper(true) });
  // BSV mode v0 (knowledge and visibility only; no wallet). The flag lives in config.json under "bsv".
  const bsvState = createBsvState({ dataDir: dataDir(), config });
  const bsvEnabled = () => bsvState.enabled;
  const moduleDeps: ModuleDeps = { config, store, bus, engine, approvals, dataDir: dataDir(), bsvEnabled };
  const kg = createKnowledgeModule(moduleDeps);
  // the house context layer (AGENTS.md, ADRs, glossary, lessons) copied into the data dir and served to every agent
  const house = createHouseModule(moduleDeps, { log, catalog: () => armory.catalog() });
  // the Armory: skills agents can pick up (own skills, imported ones, Claude Code's), and the per-run skills list
  const armory = createArmoryModule(moduleDeps, { log });
  // (creating the BSV module also tells the engine's agent bridge to hide agents that are switched off)
  const bsv = createBsvModule(moduleDeps, { state: bsvState, kg, log, nativeSecret });
  const blender = createBlenderModule(moduleDeps, { vms, boatConfigured, log });
  // In-app updates (plan: docs/design/plan-updater.md): checks and stages a signed release; main applies it when the core is idle. No overrides are passed here.
  const updater = createUpdaterModule(moduleDeps, {
    root: installRoot, nativeSecret, log,
    probes: { 'a Blender download or setup is running': async () => !!((await blender.status(false)) as { getting?: boolean }).getting },
  });
  const providersModules = providerRuntime ? [createProvidersModule({ runtime: providerRuntime, configPath: configPath(), nativeSecret })] : [];
  const webSearchModule = createWebSearchModule({ config: () => config.webSearch, keys: providerKeys, service: webSearch, configPath: configPath(), nativeSecret });
  // project board: ON by default (owner decision 2026-10-03). Only the literal `false` under "features.projectBoard" in config.json turns it off; then none of it is built (no files, routes, tools or screen).
  const board = config.features.projectBoard ? new BoardStore(join(dataDir(), 'board')) : undefined;
  const boardModules = board ? [createBoardModule(moduleDeps, { projects, board, notes: graphNotes(() => kg.graph()), away: awayCore.service, limits: (pid) => attemptLimits(gatesCore.gate('attempt-caps', pid)), stallLadder: (pid) => gatesCore.gate('stall-ladder', pid) !== false, activity })] : [];
  const away = createAwayModule(moduleDeps, {
    projects, core: awayCore, questions,
    agentOk: (id) => agentIdVisible({ bsvEnabled, store }, id),
    // proposals waiting in the project Inboxes count as asks
    ...(board ? { inbox: () => projects.list().filter((p) => p.status === 'active').flatMap((p) => { try { return board.view(p).inbox; } catch { return []; } }) } : {}),
  });
  // connectors: the gateway tools (an agent must opt in) and the Settings routes; GitHub reads only in this build
  const connectors = createConnectorsModule(moduleDeps, { keys: connectorKeyring, log, projects });
  // CI panel: runs of the current repo's GitHub Actions. The GitHub client comes from the connectors work; without it the panel says so.
  const ci = createCiModule(moduleDeps, { github: () => resolveGitHub(), writes: createWritesResolver(log).get, projects, log });
  const logs = createLogsModule(moduleDeps, { sink });
  // Legion's own program folder is protected like the data folder, but only for an installed Legion (a dev checkout stays editable)
  const gates = createGatesModule(moduleDeps, { projects, core: gatesCore, activity, dataDir: dataDir(), installTargets: installFolderTargets(installRoot, isPackageInstall(installRoot)), ...(nativeSecret ? { nativeSecret } : {}) });
  const modules = [kg, house, armory, createCommsModule(moduleDeps, { projects }), createProjectsModule(moduleDeps, { projects, nativeSecret }), ...boardModules, away, gates, createActivityModule(moduleDeps, activity), bsv, blender, ...providersModules, webSearchModule, updater, createBrowserModule(moduleDeps, { nativeSecret, log }), connectors, ci, logs, createGateSuggestionsModule(moduleDeps)];
  engine.setModules(modules);
  const server = createServer({
    config, store, bus, engine, vms, approvals, questions, boatConfigured, modules, bsvEnabled,
    doctor: (probeAgents) => runDoctor({ config, getBoat, health: vms.health, keys: providerKeys, agentHost, probeAgents: probeAgents === true }),
    catalog: (force) => getCatalog({ config, trustedFolders: () => gatesCore.trustedFolders(), hosts: agentHost }, { force }),
    settings, adminSecret, projects, agentMode: gates.agentMode, away: awayCore.service, ...(board ? { board } : {}),
  });

  restartReaper();

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log(`port ${config.port} in use — is Legion Core already running? exiting.`);
      process.exit(3);
    }
    log('server error', err);
  });
  listenLoopback(server, config.port, () => {
    log(`Legion Core ${VERSION} on http://127.0.0.1:${config.port}  (config: ${configPath()})`);
    process.stderr.write(`[${new Date().toISOString()}] Legion Core ${VERSION} on http://127.0.0.1:${config.port}
`); // the one ready line in core.log (nothing parses it)
    // BSV mode already on: bring the pack up to the bundled version without anyone toggling (never blocks, never throws)
    void bsv.start();
    // a roster with an agent on Hermes gets its own waits read now, in the background, so the first card already closes when Hermes denies it
    warmHermes(config.acp.entries.find((e) => e.id === BUILTIN_HERMES.id), false);
  }, (addr) => { log('refusing to run: the server bound a non-loopback address', addr); process.exit(4); });

  const shutdown = async (sig: string) => {
    log(`shutting down (${sig})`);
    stopReaper();
    for (const m of modules) { try { await m.dispose?.(); } catch { /* ignore */ } }
    for (const id of engine.running()) engine.cancel(id);
    revokeAllRunTokens(); // no agent host run key outlives the core
    killAllAgentsSync();
    server.close();
    await store.flush();
    await projects.flush();
    closeLogs();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('beforeExit', closeLogs);
  process.on('exit', closeLogs);
}

main().catch((e) => { log('fatal', e); closeLogs(); process.exit(1); });
