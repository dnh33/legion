/** Comms bridge module: rooms, bot-to-bot messages and guard rails. See docs/COMMS-BRIDGE.md. */
import { normalizeComms } from '../../shared/config.js';
import type { CoreModule, ModuleDeps } from '../modules.js';
import { CommsHub } from './hub.js';
import { addCommsRoutes } from './routes.js';
import { buildCommsToolsServer, COMMS_PREAMBLE } from './tools.js';

export { CommsHub, CommsError } from './hub.js';
export { scrubSecrets } from './scrub.js';

export function createCommsModule(deps: ModuleDeps): CoreModule {
  // an agent that is switched off (the Assayer while BSV mode is off) is invisible to rooms and bot messaging
  const hub = new CommsHub({
    engine: deps.engine, store: deps.store, bus: deps.bus, dataDir: deps.dataDir, isVisible: (a) => a.requires !== 'bsv' || deps.bsvEnabled(),
    comms: normalizeComms((deps.config as { comms?: unknown }).comms),
    // a bot's room request is a card the user answers in the app; the broker denies it after 10 minutes or when the task ends
    approve: (r) => deps.approvals.request(r.taskId, r.agentId, `mcp__legion_comms__${r.tool}`, r.input, r.origin, { summary: r.summary }),
  });
  return {
    id: 'comms',
    mcpServers: (agent, job) => ({ legion_comms: buildCommsToolsServer(agent.id, hub, job, (v) => deps.engine.bridge.resolveModel(v)) }),
    preamble: () => COMMS_PREAMBLE,
    routes: (add) => addCommsRoutes(add, hub),
    dispose: () => hub.dispose(),
  };
}
