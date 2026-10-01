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
  'You have no wallet or BSV tools in this version: explain, draft and review only. Nothing in Legion signs, sends or holds funds, so never attempt to. Lessons whose title starts with [Design] describe controls that do not exist yet.',
  'Use the knowledge graph for BSV lessons: call mcp__legion_kg__kg_recall with scope bsv before answering from recall.',
  'Never ask the user for keys, seed phrases or wallet secrets, and tell them not to paste any into chat.',
].join('\n');

export interface BsvModuleOptions {
  /** Where start() reports what it did (the core logs to stderr). Defaults to silent. */
  log?: (msg: string) => void;
  /** Shared with the composition root (bsvEnabled reads it). Created from deps when omitted. */
  state?: BsvState;
  /** The knowledge-graph module, when present: its HTTP route handlers are reused to load the seed and count nodes. */
  kg?: CoreModule;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createBsvModule(deps: ModuleDeps, opts: BsvModuleOptions = {}): CoreModule & { state: BsvState; ensureSeed: () => Promise<BsvSeedResult>; start: () => Promise<void> } {
  const state = opts.state ?? new BsvState({ dataDir: deps.dataDir, config: deps.config });
  const log = opts.log ?? (() => undefined);

  // The Assayer is hidden while BSV mode is off. The engine asks this before it starts a task and again when a queued job is about to run.
  const bridge = (deps.engine as { bridge?: { isVisible: (a: AgentProfile) => boolean } } | undefined)?.bridge;
  if (bridge) bridge.isVisible = (a) => a.requires !== 'bsv' || state.enabled;

  // The kg module is reached through its own route semantics (no edits to src/core/kg): record its handlers.
  const kgHandlers = new Map<string, Handler>();
  opts.kg?.routes?.((method, pattern, handler) => { kgHandlers.set(`${method} ${pattern}`, handler); });
  const kgCall = async (method: string, pattern: string): Promise<any> => {
    const h = kgHandlers.get(`${method} ${pattern}`);
    if (!h) throw new Error(`knowledge graph route ${method} ${pattern} is not available`);
    return h({ req: undefined as never, res: undefined as never, url: new URL('http://127.0.0.1' + pattern), params: [], body: undefined });
  };

  /** The agents behind the BSV gate (the seeded Assayer). Found by `requires`, not by id. */
  const gated = (): AgentProfile[] => deps.store.listAgents().filter((a) => a.requires === 'bsv');

  async function bsvNodes(): Promise<number> {
    if (!kgHandlers.size || !state.enabled) return 0;
    try { return Number((await kgCall('GET', '/api/kg/stats')).byScope?.bsv ?? 0) || 0; } catch { return 0; }
  }

  async function status(): Promise<BsvStatus> {
    const nodes = await bsvNodes();
    return {
      enabled: state.enabled, network: state.network,
      assayerAvailable: gated().length > 0,
      knowledgeLoaded: nodes > 0, knowledgeNodes: nodes,
    };
  }

  /**
   * Loads or upgrades the bundled pack through the kg seed route, which decides by the index node's recorded pack version (not by
   * "any bsv node exists", so a human note in scope bsv cannot block seeding). Human edits are never overwritten.
   * Never throws: a missing pack must not block the toggle.
   */
  async function ensureSeed(): Promise<BsvSeedResult> {
    if (!kgHandlers.size) return { status: 'no-kg' };
    try {
      const { ok: _ok, ...result } = await kgCall('POST', '/api/kg/seed/bsv');
      return result as BsvSeedResult;
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

  /**
   * Core startup: when BSV mode is already on, bring the pack up to the bundled version (idempotent: it does nothing at the same
   * version). Never blocks boot and never throws: a failure is logged and the next toggle or Load button tries again.
   */
  async function start(): Promise<void> {
    try {
      if (!state.enabled) return;
      const r = await exclusive(ensureSeed); // serialised with the toggle, so a click during start cannot interleave
      if (r.status === 'error') log(`BSV knowledge pack not loaded: ${r.error ?? 'unknown error'}`);
      else if (r.status === 'no-kg') log('BSV knowledge pack not loaded: the knowledge graph module is not present');
      else if (r.status === 'already-loaded') log(`BSV knowledge pack already at version ${r.to ?? '?'}`);
      else log(`BSV knowledge pack ${r.status} (v${r.from ?? 0} -> v${r.to ?? '?'}): ${r.created ?? 0} added, ${r.updated ?? 0} updated, ${r.edges ?? 0} links${r.skippedEdited?.length ? `, ${r.skippedEdited.length} edited by you left alone` : ''}${r.skippedRemoved?.length ? `, ${r.skippedRemoved.length} you deleted stay deleted` : ''}`);
    } catch (e) {
      try { log(`BSV knowledge pack not loaded: ${e instanceof Error ? e.message : String(e)}`); } catch { /* logging must not throw either */ }
    }
  }

  return {
    id: 'bsv',
    state,
    ensureSeed,
    start,
    // keyed on the gate, not on an id string: a bot a user happens to name "Assayer" is an ordinary bot
    preamble: (agent: AgentProfile) => (agent.requires === 'bsv' && state.enabled ? BSV_PREAMBLE : ''),
    routes: (add) => {
      add('GET', '/api/bsv', () => status());
      add('POST', '/api/bsv', ({ body }) => exclusive(async (): Promise<BsvToggleResult> => {
        if (!isObj(body) || typeof body.enabled !== 'boolean') throw new HttpError(400, 'body {enabled:boolean} required');
        let changed: boolean;
        try { changed = state.set(body.enabled); } catch (e) {
          throw new HttpError(500, `Could not save the BSV setting: ${e instanceof Error ? e.message : String(e)}`);
        }
        let seed: BsvSeedResult | undefined;
        // Turning OFF: jobs of the Assayer that are still waiting in the queue are cancelled now (the engine also re-checks when a job starts).
        if (!body.enabled) { try { (deps.engine as { cancelHiddenQueued?: () => string[] }).cancelHiddenQueued?.(); } catch { /* the start-time check still holds */ } }
        if (body.enabled) {
          seed = await ensureSeed();
          // Turning ON: tell open clients the gated agent(s) exist now. Turning OFF has no event (the frozen event union
          // has no "hidden"), so clients simply refetch /api/state; agent.deleted would be wrong here.
          if (changed) for (const a of gated()) deps.bus.emit({ type: 'agent.updated', agent: a });
        }
        return { ...(await status()), ...(seed ? { seed } : {}) };
      }));
    },
  };
}
