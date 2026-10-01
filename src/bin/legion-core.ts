#!/usr/bin/env node
/** Legion Core composition root. */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { configPath, dataDir, loadConfig, scrubHostSessionEnv, VERSION } from '../shared/config.js';
import { ApprovalBroker } from '../core/approvals.js';
import { BoatClient } from '../core/boat.js';
import { EventBus } from '../core/bus.js';
import { getCatalog } from '../core/catalog.js';
import { runDoctor } from '../core/doctor.js';
import { Engine } from '../core/engine.js';
import { createServer } from '../core/server.js';
import { createBsvModule, createBsvState } from '../core/bsv/index.js';
import { createCommsModule } from '../core/comms/index.js';
import { createKnowledgeModule } from '../core/kg/index.js';
import type { ModuleDeps } from '../core/modules.js';
import { Store } from '../core/store.js';
import { VmManager } from '../core/vm-manager.js';

const logFile = join(dataDir(), 'core.log');
const log = (...a: unknown[]) => {
  const line = `[${new Date().toISOString()}] ${a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  process.stderr.write(line);
  try { appendFileSync(logFile, line); } catch { /* ignore */ }
};

async function main() {
  // Run standalone even if launched from inside a Claude host session.
  const clean = scrubHostSessionEnv(process.env);
  for (const k of Object.keys(process.env)) if (!(k in clean)) delete process.env[k];
  const config = loadConfig();
  const store = new Store(dataDir());
  store.seedDefaults(config.workspaceDir);
  const recovered = store.recoverInterrupted();
  if (recovered) log(`recovered ${recovered} interrupted task(s)`);

  const bus = new EventBus();
  let boat: BoatClient | null = null;
  const getBoat = () => {
    if (!config.boat.apiKey) return null;
    boat ??= new BoatClient({ apiKey: config.boat.apiKey, baseUrl: config.boat.baseUrl });
    return boat;
  };
  const boatConfigured = () => !!config.boat.apiKey;

  const vms = new VmManager({ store, bus, getBoat });
  const approvals = new ApprovalBroker(bus);
  const engine = new Engine({ store, bus, vms, approvals, config, boatConfigured });
  // BSV mode v0 (knowledge and visibility only; no wallet). The flag lives in config.json under "bsv".
  const bsvState = createBsvState({ dataDir: dataDir(), config });
  const bsvEnabled = () => bsvState.enabled;
  const moduleDeps: ModuleDeps = { config, store, bus, engine, approvals, dataDir: dataDir(), bsvEnabled };
  const kg = createKnowledgeModule(moduleDeps);
  const modules = [kg, createCommsModule(moduleDeps), createBsvModule(moduleDeps, { state: bsvState, kg })];
  engine.setModules(modules);
  const server = createServer({
    config, store, bus, engine, vms, approvals, boatConfigured, modules, bsvEnabled,
    doctor: () => runDoctor({ config, getBoat }),
    catalog: (force) => getCatalog({ config }, { force }),
  });

  const stopReaper = boatConfigured() ? vms.startReaper() : () => {};

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log(`port ${config.port} in use — is Legion Core already running? exiting.`);
      process.exit(3);
    }
    log('server error', err);
  });
  server.listen(config.port, '127.0.0.1', () => {
    log(`Legion Core ${VERSION} on http://127.0.0.1:${config.port}  (config: ${configPath()})`);
  });

  const shutdown = async (sig: string) => {
    log(`shutting down (${sig})`);
    stopReaper();
    for (const m of modules) { try { await m.dispose?.(); } catch { /* ignore */ } }
    for (const id of engine.running()) engine.cancel(id);
    server.close();
    await store.flush();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log('unhandledRejection', e));
  process.on('uncaughtException', (e) => log('uncaughtException', e));
}

main().catch((e) => { log('fatal', e); process.exit(1); });
