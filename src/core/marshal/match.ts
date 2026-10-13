/**
 * The match pipeline (C4 council verdict): prose matching over the GENERATED per-bot catalog, decided by a
 * matcher the Marshal supplies (an LLM in the app, a fake in tests), then RE-VALIDATED in code. The matcher
 * recommends; the guards decide. Nothing here trusts the matcher's word over the deny table, the membership
 * list or the attempt ledger.
 *
 * The injection guard lives here too: an item whose text an agent wrote (trust: 'untrusted') never reaches
 * the matcher at all — untrusted board text cannot select a bot, so the pipeline blocks the item with the
 * reason the owner needs to lift the block (mark the text reviewed), and the loop moves on.
 */
import type { WorkItem } from '../../shared/board.js';
import { eligible, irreversibleVerbsIn, verbFit } from './catalog.js';
import type { BotCatalogEntry, Exclusion, IrreversibleVerb } from './catalog.js';

export type MatchOutcome = 'assigned' | 'no-fit' | 'blocked';

/** One assignment decision, kept as the council shaped it: who, why, what matched, what else was on the table. */
export interface AssignmentRecord {
  botId: string | null;
  /** One line the owner reads to see why this bot (or why none). */
  reason: string;
  /** The signals the match leaned on (role words, verbs). */
  matched: string[];
  /** The bots that were actually on the table when the choice was made. */
  considered: string[];
  /** How sure the matcher judged itself, 0..1. Never load-bearing: guards decide regardless. */
  confidence: number;
  outcome: MatchOutcome;
  /** Set when a code guard refused what the matcher answered. */
  refused?: string;
}

/** A record plus the exclusions the pipeline computed on the way. */
export interface AssignmentResult extends AssignmentRecord { excluded?: Exclusion[] }

/** What the matcher is shown. `task` carries owner-trusted text only — that is the pipeline's promise, not the matcher's. */
export interface MatchInput {
  task: { id: string; title: string; description: string };
  /** The eligible candidates, and only those. */
  catalog: BotCatalogEntry[];
  /** The irreversible verbs the owner's text names (a routing signal for the deny table). */
  verbs: IrreversibleVerb[];
  /** The project the item is on: the matching run is filed under it when the matcher may run there. */
  projectId?: string;
}

/** The prose matcher. It may answer synchronously or asynchronously; either way its answer is re-checked in code. */
export type ProseMatcher = (input: MatchInput) => AssignmentRecord | Promise<AssignmentRecord>;

/** Everything the pipeline needs that only the loop knows: the item, the roster, and the guards' context. */
export interface CandidateSetup {
  item: WorkItem;
  catalog: readonly BotCatalogEntry[];
  members: readonly string[];
  visible(id: string): boolean;
  busy(id: string): boolean;
  busyWhy?(id: string): string | undefined;
  reuse(id: string): { ok: true } | { ok: false; why: string };
}

const UNTRUSTED = 'This item was written by an agent and the owner has not reviewed it. Untrusted board text never selects a bot: mark the text reviewed and the Marshal will route it.';

/** The injection guard's own line, when an item's text an agent wrote must not select a bot. */
export const untrustedRefusal = (item: Pick<WorkItem, 'trust'>): string | undefined => (item.trust === 'human' ? undefined : UNTRUSTED);

const base = (outcome: MatchOutcome, reason: string, extra: Partial<AssignmentRecord> = {}): AssignmentRecord => ({
  botId: null, reason, matched: [], considered: [], confidence: 0, outcome, ...extra,
});

/** One assignment attempt: guards first, matcher second, guards again. Never throws — a failure blocks, visibly. */
export async function assignItem(s: CandidateSetup, matcher: ProseMatcher): Promise<AssignmentResult> {
  if (s.item.trust !== 'human') return { ...base('blocked', UNTRUSTED), excluded: [] };
  const verbs = irreversibleVerbsIn(`${s.item.title}\n${s.item.description}`);
  const { candidates, excluded } = eligible(s.catalog, { members: s.members, visible: s.visible, busy: s.busy, ...(s.busyWhy ? { busyWhy: s.busyWhy } : {}), reuse: s.reuse });
  if (!candidates.length) {
    const why = excluded.map((e) => `${e.id} (${e.why})`).join('; ') || 'this project has no agents';
    return { ...base('no-fit', `No eligible bot for this item: ${why}`), excluded };
  }
  let record: AssignmentRecord;
  try {
    record = await matcher({ task: { id: s.item.id, title: s.item.title, description: s.item.description }, catalog: candidates, verbs, projectId: s.item.projectId });
  } catch (e) {
    return { ...base('blocked', 'The matching could not run for this item.', { refused: e instanceof Error ? e.message : String(e) }), excluded };
  }
  if (!record || typeof record !== 'object') return { ...base('blocked', 'The matcher gave no answer the guards can read.'), excluded };
  const considered = (Array.isArray(record.considered) && record.considered.length ? record.considered : candidates.map((b) => b.id)).filter((x): x is string => typeof x === 'string');
  const shaped = { ...record, considered, matched: Array.isArray(record.matched) ? record.matched.filter((x): x is string => typeof x === 'string') : [], confidence: Number.isFinite(record.confidence) ? record.confidence : 0 };
  if (shaped.outcome !== 'assigned') return { ...shaped, botId: null, reason: shaped.reason || 'no fit', excluded };
  const bot = candidates.find((b) => b.id === shaped.botId);
  if (!bot) return { ...shaped, outcome: 'blocked', reason: shaped.reason, refused: `"${String(shaped.botId ?? '').slice(0, 40)}" is not an eligible bot for this item`, excluded };
  const fit = verbFit(bot, verbs);
  if (!fit.ok) return { ...shaped, outcome: 'blocked', botId: bot.id, reason: shaped.reason, refused: fit.why, excluded };
  return { ...shaped, outcome: 'assigned', botId: bot.id, excluded };
}
