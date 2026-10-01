/**
 * BSV mode v0: the optional BSV Dev Kit toggle. Knowledge and visibility only.
 * There is NO wallet here: no keys, no signing, no transactions, no network calls to any chain or wallet.
 * What the toggle does: shows the Assayer (the state filter in server.ts reads the flag), loads the bundled BSV
 * knowledge pack into the knowledge graph once, and gives the Assayer a four-line preamble. See docs/legion-bsv-kit.md.
 */
import { HttpError } from '../server.js';
import type { Handler } from '../server.js';
import type { CoreModule, ModuleDeps } from '../modules.js';
import type { AgentProfile } from '../../shared/types.js';
import { BsvState } from './state.js';
import type { BsvSeedResult, BsvStatus, BsvToggleResult } from './types.js';

export { BsvState, createBsvState } from './state.js';
export type { BsvSeedResult, BsvStatus, BsvToggleResult } from './types.js';

export const ASSAYER_ID = 'assayer';

/** Exactly four lines, appended only for the Assayer and only while BSV mode is on. */
export const BSV_PREAMBLE = [
  'BSV mode is on and the network is testnet.',
  'You have no wallet tools in this version: you can explain and draft, but nothing here can sign, send or hold funds.',
  'Use the knowledge graph for BSV lessons: call mcp__legion_kg__kg_recall with scope bsv before answering from recall.',
  'Never ask the user for keys, seed phrases or wallet secrets, and tell them not to paste any into chat.',
].join('\n');

export interface BsvModuleOptions {
  /** Shared with the composition root (bsvEnabled reads it). Created from deps when omitted. */
  state?: BsvState;
  /** The knowledge-graph module, when present: its HTTP route handlers are reused to load the seed and count nodes. */
  kg?: CoreModule;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createBsvModule(deps: ModuleDeps, opts: BsvModuleOptions = {}): CoreModule & { state: BsvState } {
  const state = opts.state ?? new BsvState({ dataDir: deps.dataDir, config: deps.config });

  // The kg module is reached through its own route semantics (no edits to src/core/kg): record its handlers.
  const kgHandlers = new Map<string, Handler>();
  opts.kg?.routes?.((method, pattern, handler) => { kgHandlers.set(`${method} ${pattern}`, handler); });
  const kgCall = async (method: string, pattern: string): Promise<any> => {
    const h = kgHandlers.get(`${method} ${pattern}`);
    if (!h) throw new Error(`knowledge graph route ${method} ${pattern} is not available`);
    return h({ req: undefined as never, res: undefined as never, url: new URL('http://127.0.0.1' + pattern), params: [], body: undefined });
  };

  async function bsvNodes(): Promise<number> {
    if (!kgHandlers.size || !state.enabled) return 0;
    try { return Number((await kgCall('GET', '/api/kg/stats')).byScope?.bsv ?? 0) || 0; } catch { return 0; }
  }

  async function status(): Promise<BsvStatus> {
    const nodes = await bsvNodes();
    return {
      enabled: state.enabled, network: state.network,
      assayerAvailable: !!deps.store.getAgent(ASSAYER_ID),
      knowledgeLoaded: nodes > 0, knowledgeNodes: nodes,
    };
  }

  /** Loads the bundled pack unless bsv nodes are already there. Never throws: a missing pack must not block the toggle. */
  async function ensureSeed(): Promise<BsvSeedResult> {
    if (!kgHandlers.size) return { status: 'no-kg' };
    try {
      const have = await bsvNodes();
      if (have > 0) return { status: 'already-loaded', nodes: have };
      const r = await kgCall('POST', '/api/kg/seed/bsv');
      return { status: 'loaded', nodes: r.nodes, created: r.created, updated: r.updated, edges: r.edges };
    } catch (e) {
      return { status: 'error', error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Toggles are serialised so two quick clicks cannot interleave a seed load with a flip.
  let lock: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  };

  return {
    id: 'bsv',
    state,
    preamble: (agent: AgentProfile) => (agent.id === ASSAYER_ID && state.enabled ? BSV_PREAMBLE : ''),
    routes: (add) => {
      add('GET', '/api/bsv', () => status());
      add('POST', '/api/bsv', ({ body }) => exclusive(async (): Promise<BsvToggleResult> => {
        if (!isObj(body) || typeof body.enabled !== 'boolean') throw new HttpError(400, 'body {enabled:boolean} required');
        let changed: boolean;
        try { changed = state.set(body.enabled); } catch (e) {
          throw new HttpError(500, `Could not save the BSV setting: ${e instanceof Error ? e.message : String(e)}`);
        }
        let seed: BsvSeedResult | undefined;
        if (body.enabled) {
          seed = await ensureSeed();
          const assayer = deps.store.getAgent(ASSAYER_ID);
          // Turning ON: tell open clients the Assayer exists now. Turning OFF has no event (the frozen event union
          // has no "hidden"), so clients simply refetch /api/state; agent.deleted would be wrong here.
          if (changed && assayer) deps.bus.emit({ type: 'agent.updated', agent: assayer });
        }
        return { ...(await status()), ...(seed ? { seed } : {}) };
      }));
    },
  };
}
