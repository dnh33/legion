/**
 * Learned gate suggestions. Every approval card the owner allows is counted under the rule its Remember would make
 * (gate-remember.ts); once the same rule has been earned SUGGEST_AFTER times, Settings, Gates offers it. Nothing is
 * added on its own: the owner adds or dismisses. Never counted: a call no allow can hold on, a rail, or a call an
 * enabled rule already allows. Counts and dismissals live in <dataDir>/gate-suggestions.json, capped at MAX_ENTRIES;
 * with gates.learn false nothing is counted and the file is deleted.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApprovalRequest, GateSuggestion, GateWhen } from '../shared/types.js';
import { gatesFor } from '../shared/config.js';
import { decideGate } from './gates.js';
import { SUGGEST_AFTER, canRememberAllow, rememberWhen, type RememberCall } from './gate-remember.js';
import type { CoreModule, ModuleDeps } from './modules.js';

export { SUGGEST_AFTER };
/** Cards waiting for an answer are held by id; a broker that never resolves one must not grow this without end. */
const MAX_PENDING = 500;
/** Shapes kept on disk (and dismissals): past it the least-seen go first, so the file stays a few tens of KB at most. */
export const MAX_ENTRIES = 200;

interface Entry { when: GateWhen; count: number; sample: RememberCall }
interface State { counts: Record<string, Entry>; dismissed: string[] }

function load(file: string): State {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<State>;
    return {
      counts: raw.counts && typeof raw.counts === 'object' ? raw.counts : {},
      dismissed: Array.isArray(raw.dismissed) ? raw.dismissed.filter((k): k is string => typeof k === 'string') : [],
    };
  } catch {
    return { counts: {}, dismissed: [] };
  }
}

export function createGateSuggestionsModule(deps: Pick<ModuleDeps, 'bus' | 'config' | 'dataDir'>): CoreModule {
  const file = join(deps.dataDir, 'gate-suggestions.json');
  const state = existsSync(file) ? load(file) : { counts: {}, dismissed: [] };
  const pending = new Map<string, RememberCall>();

  const learning = (): boolean => gatesFor(deps.config).learn !== false;
  /** Switched off: keep nothing, on disk or in memory. */
  const forget = (): void => {
    pending.clear();
    if (!Object.keys(state.counts).length && !state.dismissed.length && !existsSync(file)) return;
    state.counts = {}; state.dismissed = [];
    try { rmSync(file, { force: true }); } catch { /* removed on the next switch-off check */ }
  };

  const save = (): void => {
    const keys = Object.keys(state.counts);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => state.counts[a]!.count - state.counts[b]!.count);
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete state.counts[k];
    }
    if (state.dismissed.length > MAX_ENTRIES) state.dismissed = state.dismissed.slice(-MAX_ENTRIES);
    try {
      mkdirSync(deps.dataDir, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(state));
      renameSync(`${file}.tmp`, file);
    } catch { /* a lost count only delays a suggestion */ }
  };

  /** True when an enabled rule already allows this call for an owner-started run. */
  const alreadyAllowed = (c: RememberCall): boolean =>
    decideGate({ toolName: c.toolName, input: c.input, agentId: c.agentId }, gatesFor(deps.config).rules, 'ask', false).verdict === 'allow';

  const off = deps.bus.on((ev) => {
    if (ev.type !== 'approval.requested' && ev.type !== 'approval.resolved') return;
    if (!learning()) { forget(); return; }
    if (ev.type === 'approval.requested') {
      const a: ApprovalRequest = ev.approval;
      if (!a.agentId || !canRememberAllow(a)) return;
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
      pending.set(a.id, { agentId: a.agentId, toolName: a.toolName, input: (a.input ?? {}) as Record<string, unknown> });
    } else if (ev.type === 'approval.resolved') {
      const call = pending.get(ev.approvalId);
      pending.delete(ev.approvalId);
      if (!call || !ev.allowed || alreadyAllowed(call)) return;
      const when = rememberWhen(call);
      const key = JSON.stringify(when);
      if (state.dismissed.includes(key)) return;
      const e = state.counts[key];
      state.counts[key] = { when, count: (e?.count ?? 0) + 1, sample: call };
      save();
    }
  });

  const list = (): GateSuggestion[] => {
    if (!learning()) { forget(); return []; }
    return Object.entries(state.counts)
      .filter(([key, e]) => e.count >= SUGGEST_AFTER && !state.dismissed.includes(key) && !alreadyAllowed(e.sample))
      .sort((a, b) => b[1].count - a[1].count)
      .map(([key, e]) => ({ key, when: e.when, count: e.count, agentId: e.sample.agentId, toolName: e.sample.toolName, input: e.sample.input }));
  };

  return {
    id: 'gate-suggestions',
    routes(add) {
      add('GET', '/api/gates/suggestions', () => ({ suggestions: list() }));
      add('POST', '/api/gates/suggestions/dismiss', ({ body }) => {
        const key = (body as { key?: unknown } | undefined)?.key;
        if (typeof key !== 'string' || !key) return { ok: false };
        if (!state.dismissed.includes(key)) state.dismissed.push(key);
        delete state.counts[key];
        save();
        return { ok: true };
      });
    },
    dispose() { off(); },
  };
}
