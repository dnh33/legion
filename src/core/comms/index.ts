/** Comms bridge module: rooms, bot-to-bot messages and guard rails. See docs/COMMS-BRIDGE.md. */
import type { CoreModule, ModuleDeps } from '../modules.js';
import { CommsHub } from './hub.js';
import { addCommsRoutes } from './routes.js';
import { buildCommsToolsServer, COMMS_PREAMBLE } from './tools.js';

export { CommsHub, CommsError } from './hub.js';
export { scrubSecrets } from './scrub.js';

export function createCommsModule(deps: ModuleDeps): CoreModule {
  // an agent that is switched off (the Assayer while BSV mode is off) is invisible to rooms and bot messaging
  const hub = new CommsHub({ engine: deps.engine, store: deps.store, bus: deps.bus, dataDir: deps.dataDir, isVisible: (a) => a.requires !== 'bsv' || deps.bsvEnabled() });
  return {
    id: 'comms',
    mcpServers: (agent, job) => ({ legion_comms: buildCommsToolsServer(agent.id, hub, job) }),
    preamble: () => COMMS_PREAMBLE,
    routes: (add) => addCommsRoutes(add, hub),
    dispose: () => hub.dispose(),
  };
}
