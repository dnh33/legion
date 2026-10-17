/**
 * The attempt ledger (C4 robustness lens): the futility rule the lead's doctrine only PROSEd —
 * "at most two send-backs per task" — enforced in code the prose cannot talk past.
 *
 * The checks a dispatch is judged against share one bound, named here and used by the ledger, the
 * dispatch route and the panel that writes them: six lines a human can read at a glance.
 *
 * Four guards live here, all pure: a bot gets two tries and never a third; an item that leaves a bot for
 * another never comes back to the first (forward-only); an item whose attempts are spent everywhere stops
 * and waits for a human (the loop blocks it — it never forces a fit); and `done_when` must be written
 * before the first dispatch, so every run starts with the checks that decide it.
 *
 * The ledger is a value: `snapshot()` out and `AttemptLedger.from()` in round-trip it through the board's
 * per-item sidecar, so a restart does not hand a bot a third try.
 */

/** Two dispatches of one item to one bot; the third is refused (the doctrine's two send-backs, as a number). */
export const MAX_ATTEMPTS_PER_BOT = 2;
/** Two tries on every reasonable bot still does not make a fit: after this many dispatches the item needs a human. */
export const MAX_ATTEMPTS_PER_ITEM = 4;
/** The checks that decide one item: the most `done_when` lines the ledger keeps, the route accepts and the panel offers. */
export const MAX_DONE_WHEN = 6;

/** The two caps one dispatch is judged by. Infinity means no cap. */
export interface AttemptLimits { perBot: number; perItem: number }
const DEFAULT_LIMITS: AttemptLimits = { perBot: MAX_ATTEMPTS_PER_BOT, perItem: MAX_ATTEMPTS_PER_ITEM };

/**
 * The caps for one value of the `attempt-caps` gate. A limit is the per-item number and the per-bot number is half of it (at least 1);
 * off means no cap; a value that is not a usable number gives the defaults, so a damaged setting never removes the guard.
 */
export function attemptLimits(v: boolean | { on: true; limit: number }): AttemptLimits {
  if (v === false) return { perBot: Infinity, perItem: Infinity };
  if (typeof v === 'object' && Number.isFinite(v.limit) && v.limit >= 1) {
    const perItem = Math.floor(v.limit);
    return { perBot: Math.max(1, Math.floor(perItem / 2)), perItem };
  }
  return DEFAULT_LIMITS;
}
/** Where the ledger reads its caps, and for which project: read at every dispatch check, so a preset change takes the next one. */
export interface LedgerOptions { limits?: (projectId: string) => AttemptLimits; projectId?: string }

/** One item's dispatch history. Everything optional is dropped when unreadable: a damaged count is not a count. */
export interface ItemLedgerState {
  /** Dispatches per bot id. */
  attempts?: Record<string, number>;
  /** The bot whose run is live on this item (one owner at a time). */
  owner?: string;
  /** Bots the item was reassigned AWAY from: never routed back to them. */
  history?: string[];
  /** Stalls the owner saw: two stalls on one item stop the auto-retry ladder. */
  stalls?: number;
  /** The checks that decide this item, written before the first dispatch. */
  doneWhen?: string[];
}

export type MayDispatch = { ok: true } | { ok: false; why: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** One item's guarded history, with every guard answer phrased for a human to read in the STATUS. */
class ItemState {
  attempts = new Map<string, number>();
  owner: string | undefined;
  history = new Set<string>();
  stalls = 0;
  doneWhen: string[] | undefined;
  /** The task id of the live dispatch (runtime-only: the board's activeRun is the durable link). */
  lastTaskId: string | undefined;
}

/** Read one item's stored state, dropping anything unreadable rather than trusting it. */
function read(raw: unknown): ItemState {
  const s = new ItemState();
  if (!isObj(raw)) return s;
  if (isObj(raw.attempts)) for (const [bot, n] of Object.entries(raw.attempts)) if (count(n) > 0) s.attempts.set(bot, count(n));
  if (typeof raw.owner === 'string' && raw.owner) s.owner = raw.owner;
  if (Array.isArray(raw.history)) for (const b of raw.history) if (typeof b === 'string' && b) s.history.add(b);
  s.stalls = count(raw.stalls);
  if (Array.isArray(raw.doneWhen)) { const checks = raw.doneWhen.filter((c): c is string => typeof c === 'string' && !!c.trim()).slice(0, MAX_DONE_WHEN); if (checks.length) s.doneWhen = checks; }
  return s;
}

export class AttemptLedger {
  private readonly items = new Map<string, ItemState>();

  constructor(initial?: Record<string, ItemLedgerState>, private readonly opts: LedgerOptions = {}) { this.restore(initial); }
  /** The caps right now. A reader that throws gives the defaults: the guard never fails open. */
  private lim(): AttemptLimits {
    try { return this.opts.limits?.(this.opts.projectId ?? '') ?? DEFAULT_LIMITS; } catch { return DEFAULT_LIMITS; }
  }

  /** A ledger from a stored snapshot. A snapshot that cannot be read becomes an empty ledger, never a crash. */
  static from(snapshot: unknown, opts?: LedgerOptions): AttemptLedger { return new AttemptLedger(isObj(snapshot) ? (snapshot as Record<string, ItemLedgerState>) : undefined, opts); }

  private restore(initial?: Record<string, ItemLedgerState>): void {
    for (const [id, raw] of Object.entries(initial ?? {})) this.items.set(id, read(raw));
  }
  /** The whole ledger as plain data, ready for the board's sidecar. */
  snapshot(): Record<string, ItemLedgerState> {
    const out: Record<string, ItemLedgerState> = {};
    for (const [id, s] of this.items) {
      out[id] = {
        ...(s.attempts.size ? { attempts: Object.fromEntries(s.attempts) } : {}),
        ...(s.owner ? { owner: s.owner } : {}),
        ...(s.history.size ? { history: [...s.history] } : {}),
        ...(s.stalls ? { stalls: s.stalls } : {}),
        ...(s.doneWhen ? { doneWhen: s.doneWhen } : {}),
      };
    }
    return out;
  }

  private item(itemId: string): ItemState {
    let s = this.items.get(itemId);
    if (!s) { s = new ItemState(); this.items.set(itemId, s); }
    return s;
  }

  /** The checks that decide this item, or undefined when the owner has not written them. */
  doneWhen(itemId: string): string[] | undefined { return this.items.get(itemId)?.doneWhen; }
  /** The owner writes (or rewrites) the checks. A dispatch before this is refused by `mayDispatch`. */
  setDoneWhen(itemId: string, checks: readonly string[]): void {
    const clean = checks.map((c) => String(c).trim()).filter(Boolean).slice(0, MAX_DONE_WHEN);
    this.item(itemId).doneWhen = clean.length ? clean : undefined;
  }
  /** How many times the item was dispatched to this bot. */
  attempts(itemId: string, botId: string): number { return this.items.get(itemId)?.attempts.get(botId) ?? 0; }
  /** How many more dispatches this bot may still have on this item (Infinity with the caps off). */
  triesLeft(itemId: string, botId: string): number { return Math.max(0, this.lim().perBot - this.attempts(itemId, botId)); }
  /** The bot whose run is live on this item. */
  owner(itemId: string): string | undefined { return this.items.get(itemId)?.owner; }
  /** Stalls this item has seen across its runs. */
  stalls(itemId: string): number { return this.items.get(itemId)?.stalls ?? 0; }
  /** How many dispatches this item has consumed, across every bot. */
  totalAttempts(itemId: string): number { let n = 0; for (const v of this.items.get(itemId)?.attempts.values() ?? []) n += v; return n; }

  /** May this item go to this bot right now? Every refusal is one human line the STATUS can show. */
  mayDispatch(itemId: string, botId: string): MayDispatch {
    const s = this.items.get(itemId);
    if (!s?.doneWhen?.length) return { ok: false, why: 'no done-when: the checks that decide this item must be written before the Marshal dispatches it' };
    if (s.owner) return { ok: false, why: s.owner === botId ? `this item already has ${s.owner}'s run in progress` : `owned by ${s.owner}: one owner at a time` };
    const lim = this.lim();
    if (this.attempts(itemId, botId) >= lim.perBot) return { ok: false, why: lim.perBot === 2 ? `already tried twice: the ledger refuses a third dispatch to ${botId}` : `already tried ${lim.perBot} times: the ledger refuses another dispatch to ${botId}` };
    if (s.history.has(botId)) return { ok: false, why: 'already tried on this item: reassignment is forward-only' };
    if (this.totalAttempts(itemId) >= lim.perItem) return { ok: false, why: `out of attempts: this item has had ${lim.perItem} runs and needs the owner, not another try` };
    return { ok: true };
  }

  /**
   * A dispatch starts: this bot owns the item now, and one more attempt is on its tab. Giving the item to a
   * bot that is not its current owner is a reassignment, so every bot that already tried it goes into
   * history here — forward-only is enforced by the act of reassigning, not by the caller remembering to say so.
   */
  recordDispatch(itemId: string, botId: string, taskId: string): void {
    const s = this.item(itemId);
    for (const tried of s.attempts.keys()) if (tried !== botId) s.history.add(tried);
    s.attempts.set(botId, this.attempts(itemId, botId) + 1);
    s.owner = botId;
    s.lastTaskId = taskId;
  }
  /** The task id of the live dispatch, for the monitor. */
  liveTask(itemId: string): string | undefined { return this.items.get(itemId)?.lastTaskId; }

  /**
   * A run ended. `reassign` marks the owner's bot as history (the item is moving on: forward-only from
   * here). A failed or stalled run that does not reassign leaves the bot eligible for one send-back. A
   * finished run frees the item without scorning the bot: done is not a reassignment.
   */
  runEnded(itemId: string, outcome: 'done' | 'failed' | 'stalled' | 'cancelled', reassign = false): void {
    const s = this.items.get(itemId);
    if (!s) return;
    const was = s.owner;
    delete s.owner;
    if (outcome === 'stalled') s.stalls++;
    if (was && (reassign || this.attempts(itemId, was) >= this.lim().perBot)) s.history.add(was);
  }
}
