#!/usr/bin/env node
/** Legion Core composition root. */
import { ProviderRuntime } from '../core/providers/runtime.js';
import { ProviderKeys, keyFileFor } from '../core/providers/secrets.js';
import { createProvidersModule } from '../core/providers/routes.js';
import { appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, dataDir, loadConfig, scrubHostSessionEnv, VERSION } from '../shared/config.js';
import { readLaunchSecrets } from '../core/admin.js';
import { ApprovalBroker } from '../core/approvals.js';
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
import { createKnowledgeModule } from '../core/kg/index.js';
import { createUpdaterModule } from '../core/updater/index.js';
import { createProjectsModule, ProjectStore } from '../core/projects/index.js';
import { BoardStore, createBoardModule, graphNotes } from '../core/projects/board/index.js';
import type { ModuleDeps } from '../core/modules.js';
import { Store } from '../core/store.js';
import { isPackageInstall } from '../electron/resolve-node.js';
import { VmManager } from '../core/vm-manager.js';

const logFile = join(dataDir(), 'core.log');
const log = (...a: unknown[]) => {
  const line = `[${new Date().toISOString()}] ${a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  process.stderr.write(line);
  try { appendFileSync(logFile, line); } catch { /* ignore */ }
};

async function main() {
  // Per-launch admin secret from the stdin pipe (Electron main only). None for a headless/bridge-started core: admin routes stay closed.
  // The second line is the NATIVE secret (main only, never the window): BSV policy changes need it as well.
  const { admin: adminSecret, native: nativeSecret } = await readLaunchSecrets(process.env, process.stdin);
  // Run standalone even if launched from inside a Claude host session.
  const clean = scrubHostSessionEnv(process.env);
  for (const k of Object.keys(process.env)) if (!(k in clean)) delete process.env[k];
  const config = loadConfig();
  const store = new Store(dataDir());
  store.seedDefaults(config.workspaceDir);
  const recovered = store.recoverInterrupted();
  if (recovered) log(`recovered ${recovered} interrupted task(s)`);

  const bus = new EventBus();
  // Follows live Settings edits of config.boat.
  const getBoat = makeBoatGetter(config);
  const boatConfigured = () => !!config.boat.apiKey;

  const vms = new VmManager({ store, bus, getBoat, boatConfig: () => config.boat });
  const approvals = new ApprovalBroker(bus);
  // other model providers (OpenAI-compatible endpoints); keys live in <dataDir>/providers/keys.json, never in config.json
  // providers ship (OpenRouter on by default); off only if config.json sets features.providers = false
  const providerRuntime = config.features.providers ? new ProviderRuntime({ config, keys: new ProviderKeys(keyFileFor(dataDir())) }) : undefined;
  // projects (owner-only groups of tasks, rooms, notes; own file <dataDir>/projects.json)
  const projects = new ProjectStore(dataDir(), config.workspaceDir);
  const engine = new Engine({ store, bus, vms, approvals, config, boatConfigured, projects, ...(providerRuntime ? { providers: providerRuntime } : {}) });
  // lets ask/tell check a per-task model against what the account offers
  engine.bridge.catalog = () => getCatalog({ config });
  let stopReaper: () => void = () => {};
  const restartReaper = (keyChanged = false) => {
    stopReaper(); stopReaper = boatConfigured() ? vms.startReaper() : () => {};
    // A new key knows nothing yet: forget the old key's findings. The permission probe (about 8 boat.dev calls) does NOT run at core start:
    // it runs when the user saves a key in Settings, on the first VM use, or when Settings, boat.dev opens (see BoatHealth.ensure).
    vms.health.reset();
    if (keyChanged && boatConfigured()) void vms.health.probe().catch(() => undefined);
  };
  const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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
  // In-app updates (plan: claude/plan-updater.md): checks and stages a signed release; main applies it when the core is idle. No overrides are passed here.
  const updater = createUpdaterModule(moduleDeps, {
    root: installRoot, nativeSecret, log,
    probes: { 'a Blender download or setup is running': async () => !!((await blender.status(false)) as { getting?: boolean }).getting },
  });
  const providersModules = providerRuntime ? [createProvidersModule({ runtime: providerRuntime, configPath: configPath(), nativeSecret })] : [];
  // project board: ON by default (owner decision 2026-10-03). Only the literal `false` under "features.projectBoard" in config.json turns it off; then none of it is built (no files, routes, tools or screen).
  const board = config.features.projectBoard ? new BoardStore(join(dataDir(), 'board')) : undefined;
  const boardModules = board ? [createBoardModule(moduleDeps, { projects, board, notes: graphNotes(() => kg.graph()) })] : [];
  const modules = [kg, house, armory, createCommsModule(moduleDeps, { projects }), createProjectsModule(moduleDeps, { projects, nativeSecret }), ...boardModules, bsv, blender, ...providersModules, updater, createBrowserModule(moduleDeps, { nativeSecret, log })];
  engine.setModules(modules);
  const server = createServer({
    config, store, bus, engine, vms, approvals, boatConfigured, modules, bsvEnabled,
    doctor: () => runDoctor({ config, getBoat, health: vms.health }),
    catalog: (force) => getCatalog({ config }, { force }),
    settings, adminSecret, projects, ...(board ? { board } : {}),
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
    // BSV mode already on: bring the pack up to the bundled version without anyone toggling (never blocks, never throws)
    void bsv.start();
  }, (addr) => { log('refusing to run: the server bound a non-loopback address', addr); process.exit(4); });

  const shutdown = async (sig: string) => {
    log(`shutting down (${sig})`);
    stopReaper();
    for (const m of modules) { try { await m.dispose?.(); } catch { /* ignore */ } }
    for (const id of engine.running()) engine.cancel(id);
    server.close();
    await store.flush();
    await projects.flush();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log('unhandledRejection', e));
  process.on('uncaughtException', (e) => log('uncaughtException', e));
}

main().catch((e) => { log('fatal', e); process.exit(1); });
