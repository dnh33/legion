/**
 * Harness core entry: the SAME composition as src/bin/legion-core.ts (copy it when that file changes; test/harness-smoke.test.ts checks the
 * module list still matches), with three differences, all on the outside of the product code:
 *   - the Engine gets a scripted model (fake-model.mjs) as `queryFn` instead of the Claude Agent SDK,
 *   - the catalog and the doctor are static fakes (the real ones start a Claude Code process),
 *   - a control channel to the supervisor (Node IPC) loads scripts into the model and reads its run log.
 * The two per-launch secrets are read from stdin by the product's own readLaunchSecrets(), exactly as in the Electron case.
 * Run only by stack.mjs. Requires `npm run build:ts` first (it imports from dist/).
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createFakeModel } from './fake-model.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'src');
const load = (p) => import(pathToFileURL(join(root, p)).href);

const [{ dataDir, configPath, loadConfig, VERSION }, { readLaunchSecrets }, { ApprovalBroker }, { EventBus }, { makeBoatGetter, SettingsService }, { Engine }, { createServer },
  { createBlenderModule }, { createBsvModule, createBsvState }, { createCommsModule }, { createKnowledgeModule }, { createHouseModule }, { createArmoryModule }, { Store }, { VmManager }, { ProviderRuntime }, { ProviderKeys, keyFileFor }, { createProvidersModule }, { createUpdaterModule }, { createProjectsModule, ProjectStore }, { BoardStore, createBoardModule, graphNotes }, { createBrowserModule }, { createCiModule }, { FakeGitHub }] = await Promise.all([
  load('shared/config.js'), load('core/admin.js'), load('core/approvals.js'), load('core/bus.js'), load('core/settings.js'), load('core/engine.js'), load('core/server.js'),
  load('core/blender/index.js'), load('core/bsv/index.js'), load('core/comms/index.js'), load('core/kg/index.js'), load('core/house/index.js'), load('core/armory/index.js'), load('core/store.js'), load('core/vm-manager.js'),
  load('core/providers/runtime.js'), load('core/providers/secrets.js'), load('core/providers/routes.js'), load('core/updater/index.js'), load('core/projects/index.js'), load('core/projects/board/index.js'), load('core/browser/index.js'), load('core/ci/index.js'), load('core/ci/fake-github.js'),
]);

const log = (...a) => process.stderr.write(`[harness-core] ${a.join(' ')}\n`);

const { admin: adminSecret, native: nativeSecret } = await readLaunchSecrets(process.env, process.stdin);
const config = loadConfig();
const store = new Store(dataDir());
store.seedDefaults(config.workspaceDir);
store.recoverInterrupted();

const bus = new EventBus();
const getBoat = makeBoatGetter(config);
const boatConfigured = () => !!config.boat.apiKey;
const vms = new VmManager({ store, bus, getBoat, boatConfig: () => config.boat });
const approvals = new ApprovalBroker(bus);
const model = createFakeModel();
const providerRuntime = config.features.providers ? new ProviderRuntime({ config, keys: new ProviderKeys(keyFileFor(dataDir())) }) : undefined;
const projects = new ProjectStore(dataDir(), config.workspaceDir);
const engine = new Engine({ store, bus, vms, approvals, config, boatConfigured, projects, ...(providerRuntime ? { providers: providerRuntime } : {}), queryFn: model.queryFn });
const fakeCatalog = async () => ({ commands: [{ name: 'cost', description: 'Show cost', argumentHint: '' }], models: [{ value: 'sonnet', displayName: 'Sonnet (harness)', description: 'fake' }, { value: 'opus', displayName: 'Opus (harness)', description: 'fake' }], fetchedAt: new Date().toISOString() });
engine.bridge.catalog = fakeCatalog;
let stopReaper = () => {};
const restartReaper = (keyChanged = false) => {
  stopReaper(); stopReaper = boatConfigured() ? vms.startReaper() : () => {};
  vms.health.reset();
  if (keyChanged && boatConfigured()) void vms.health.probe().catch(() => undefined);
};
const settings = new SettingsService({ config, bus, configPath: configPath(), dataDir: dataDir(), onBoatChange: () => restartReaper(true) });
const bsvState = createBsvState({ dataDir: dataDir(), config });
const bsvEnabled = () => bsvState.enabled;
const moduleDeps = { config, store, bus, engine, approvals, dataDir: dataDir(), bsvEnabled };
const kg = createKnowledgeModule(moduleDeps);
const house = createHouseModule(moduleDeps);
const armory = createArmoryModule(moduleDeps);
const bsv = createBsvModule(moduleDeps, { state: bsvState, kg, log, nativeSecret });
const blender = createBlenderModule(moduleDeps, { vms, boatConfigured, log });
// the updater has no signing key in this tree, so it stays off and makes no request
const updater = createUpdaterModule(moduleDeps, { root: join(dirname(fileURLToPath(import.meta.url)), '..', '..'), nativeSecret, log, probes: {} });
const providersModules = providerRuntime ? [createProvidersModule({ runtime: providerRuntime, configPath: configPath(), nativeSecret })] : [];
const board = config.features.projectBoard ? new BoardStore(join(dataDir(), 'board')) : undefined;
const boardModules = board ? [createBoardModule(moduleDeps, { projects, board, notes: graphNotes(() => kg.graph()) })] : [];
// the CI panel reads GitHub through a scriptable fake in the harness (runs, jobs, logs, refusals, 403/404, rate limit); no network
const fakeGithub = new FakeGitHub();
fakeGithub.scenario('mixed');
fakeGithub.setConnection({ auth: 'pat', login: 'octo', permissions: { actions: 'write', contents: 'read' }, rate: { limit: 5000, remaining: 5000, resetAt: new Date(Date.now() + 3600000).toISOString() } });
const ci = createCiModule(moduleDeps, { github: fakeGithub, projects, log });
const modules = [kg, house, armory, createCommsModule(moduleDeps, { projects }), createProjectsModule(moduleDeps, { projects, nativeSecret }), ...boardModules, bsv, blender, ...providersModules, updater, createBrowserModule(moduleDeps, { nativeSecret, log }), ci];
engine.setModules(modules);
const server = createServer({
  config, store, bus, engine, vms, approvals, boatConfigured, modules, bsvEnabled,
  doctor: async () => [{ id: 'harness', label: 'Harness', ok: true, detail: 'scripted model, fake boat.dev' }],
  catalog: fakeCatalog,
  settings, adminSecret, projects, ...(board ? { board } : {}),
});
restartReaper();
server.on('error', (err) => { log('server error', err.code ?? err); process.exit(err.code === 'EADDRINUSE' ? 3 : 1); });
server.listen(config.port, '127.0.0.1', () => {
  void bsv.start();
  process.send?.({ event: 'ready', port: config.port, version: VERSION, hasAdmin: !!adminSecret, hasNative: !!nativeSecret });
});

// control channel (supervisor only)
process.on('message', (m) => {
  if (!m || typeof m !== 'object' || typeof m.id !== 'number') return;
  const reply = (data) => process.send?.({ id: m.id, ok: true, data });
  try {
    if (m.op === 'script') reply({ index: model.addScript(m.match, m.steps) });
    else if (m.op === 'log') reply(model.log());
    else if (m.op === 'reset') { model.reset(); reply(true); }
    else if (m.op === 'ci') reply(fakeGithub.control(m.cmd ?? {}))
    else process.send?.({ id: m.id, ok: false, error: 'unknown op' });
  } catch (e) { process.send?.({ id: m.id, ok: false, error: String(e?.message ?? e) }); }
});

const shutdown = async () => {
  stopReaper();
  for (const m of modules) { try { await m.dispose?.(); } catch { /* ignore */ } }
  for (const id of engine.running()) engine.cancel(id);
  server.close();
  await store.flush();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('disconnect', () => void shutdown()); // supervisor gone: do not linger
process.on('unhandledRejection', (e) => log('unhandledRejection', String(e)));
