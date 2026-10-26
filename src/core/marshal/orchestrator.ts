/**
 * The Marshal's proactive orchestration (C2 + C3): the loop that works the board without being asked.
 *
 * One pass (`step`) walks the dispatchable items in C1's score order and dispatches up to a wave of them,
 * each to a bot the C4 pipeline matched and the code guards approved, on that bot's OWN model — the run
 * port has no model field, so a dispatch structurally cannot reroute a bot's model. `monitor` settles the
 * runs that ended and bounds the ones that stalled (stop, then forward, then — after the second stall on
 * one item — stop entirely and hand it to the human). `status` is the human-visible picture: what runs,
 * why that bot, what is blocked and what is next.
 *
 * Everything time-shaped takes `now` as an argument: nothing here reads a clock. The only effects are the
 * ports (`startRun`, `runState`, `cancelRun`, the board), so the whole loop is testable over a real board
 * store with fakes at the edges.
 */
import type { AgentProfile } from '../../shared/types.js';
import type { WorkItem } from '../../shared/board.js';
import type { ProjectRef } from '../projects/board/store.js';
import { BoardStore } from '../projects/board/store.js';
import { AttemptLedger, type AttemptLimits } from './ledger.js';
import { catalogOfAll, eligible, irreversibleVerbsIn, verbFit } from './catalog.js';
import type { BotCatalogEntry, IrreversibleVerb } from './catalog.js';
import { assignItem, untrustedRefusal } from './match.js';
import type { AssignmentResult, ProseMatcher } from './match.js';
import { dispatchable, dispatchPrompt } from './dispatch.js';
import { GATES } from '../../shared/gates-registry.js';
import type { DispatchCandidate } from './dispatch.js';

/** Items one pass may dispatch: a wave, wide enough to parallelise and narrow enough to stay accountable. */
export const WAVE_SIZE = 3;
/** A run whose owner has reported no progress for this long is stalled (the plan's 8-minute transcript freeze). */
export const STALL_MS = 8 * 60_000;
/** Two stalls on one item end the ladder: the item waits for the owner, who decides what changes. */
export const ESCALATE_AFTER_STALLS = 2;

/** What a monitor sees about one run. `progressAt` is when the run last said anything (its task's updatedAt). */
export interface RunState {
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'unknown'; progressAt?: number; error?: string;
  /** An approval card or a question waits on the owner: the run is paused on a person, not stalled. */
  waitingOnOwner?: boolean;
  /** The run read outside text. Absent means the engine could not say, which counts as marked. */
  tainted?: boolean;
}

/**
 * The effects the loop needs, and the only ones. Deliberately, `startRun` has no model field: a dispatch
 * starts a run on the target bot's own configured model (engine.startTask with no override), and the
 * interface makes honouring that the path of least resistance — there is no slot to put a model in.
 */
export interface MarshalPorts {
  board: BoardStore;
  agents(): AgentProfile[];
  visible(id: string): boolean;
  matcher: ProseMatcher;
  startRun(input: { agentId: string; prompt: string; itemId: string }): { taskId: string };
  runState(taskId: string): RunState;
  cancelRun(taskId: string): boolean;
  /** A bot already working outside the Marshal (a run the owner or another bot started) is busy too. Optional: absent, only the Marshal's own runs count. */
  botBusy?(id: string): boolean | string;
}

export interface DispatchedItem {
  itemId: string; title: string; botId: string; botName: string;
  /** The bot's own chosen model, as its settings hold it: the run asks for no other. */
  model: string;
  /** The bot's access tier: `full` acts (pre-authorized), anything else gates at run time. */
  tier: AgentProfile['approval'];
  /** Irreversible verbs the owner's text named: why the deny table was consulted at all. */
  irreversible: IrreversibleVerb[];
  /** True when an irreversible verb is going to a tier that shows the card before it acts. */
  gated: boolean;
  /** Why this bot: the matcher's own line, kept with the dispatch. */
  why: string;
  score: number;
  rankWhy: string;
  taskId: string;
}
export interface BlockedItem { itemId: string; title: string; reason: string }
/** An item that waits for its bot to be free: it stays in the backlog and the next pass tries again (not Blocked). */
export interface WaitingItem { itemId: string; title: string; reason: string }
export interface StepReport { dispatched: DispatchedItem[]; blocked: BlockedItem[]; waiting: WaitingItem[]; candidates: number }
/** `stallsKept`: runs that passed the stall limit and were left running because the `stall-ladder` gate is off for this project. */
export interface MonitorReport { finished: string[]; failed: string[]; stalled: string[]; escalated: string[]; stallsKept: string[] }

/** A stalled run the ladder did not stop (the `stall-ladder` gate is off): what the activity line is built from. */
export interface StallKept { itemId: string; title: string; taskId: string; botId: string; minutes: number }
/** The activity line for it, in plain words. */
export function stallKeptText(a: StallKept): string {
  const label = GATES.find((g) => g.id === 'stall-ladder')?.label ?? 'Stop runs that stall';
  return `The run on "${a.title}" has made no progress for ${a.minutes} minutes. It was not stopped, because ${label} is off.`;
}

/** The picture the owner reads: what runs and why, what is blocked and why, what comes next and why. */
export interface MarshalStatus {
  running: Array<DispatchedItem & { startedAt: number; attempts: number }>;
  blocked: BlockedItem[];
  next: Array<{ itemId: string; title: string; score: number; why: string }>;
}

interface Live { itemId: string; taskId: string; botId: string; startedAt: number; dispatch: DispatchedItem; /** The "not stopped" line for this run has been written. */ stallNoted?: boolean }

export class Marshal {
  readonly ledger: AttemptLedger;
  private readonly live = new Map<string, Live>();
  /** The last block reason per item, so `status` can show it even after the board dropped the item. */
  private readonly blocked = new Map<string, BlockedItem>();
  /** Items the last wave held back for their busy bot, with why: shown in the status text (review #6). */
  private waiting: WaitingItem[] = [];

  constructor(private readonly ports: MarshalPorts, private project: ProjectRef, options: {
    ledger?: AttemptLedger; limits?: (projectId: string) => AttemptLimits; waveSize?: number; stallMs?: number; escalateAfterStalls?: number;
    /** The `stall-ladder` gate for a project, read on every pass. False: a stalled run is left running and one line says so. Absent: on. */
    stallLadder?: (projectId: string) => boolean;
    /** Told once per run when the ladder is off and the run passed the stall limit. */
    onStallKept?: (a: StallKept) => void;
  } = {}) {
    this.ledger = options.ledger ?? Marshal.loadLedger(ports.board, project, options.limits);
    this.waveSize = Math.max(1, options.waveSize ?? WAVE_SIZE);
    this.stallMs = Math.max(1, options.stallMs ?? STALL_MS);
    this.escalateAfterStalls = Math.max(1, options.escalateAfterStalls ?? ESCALATE_AFTER_STALLS);
    this.stallLadder = options.stallLadder;
    this.onStallKept = options.onStallKept;
  }
  private readonly stallLadder?: (projectId: string) => boolean;
  private readonly onStallKept?: (a: StallKept) => void;
  /** The gate is read with this project on every pass. A gate that cannot be read is on. */
  private ladderOn(): boolean {
    try { return this.stallLadder?.(this.project.id) !== false; } catch { return true; }
  }
  waveSize: number;
  stallMs: number;
  readonly escalateAfterStalls: number;

  /**
   * The owner changed the config, or the project's shape changed (a member joined or left), while the loop
   * runs: the next pass takes both. Only the bounds and the roster move — the ledger and the runs in flight
   * are untouched, so a settings change never restarts, forgets or double-books anything.
   */
  reconfigure(o: { waveSize?: number; stallMs?: number; project?: ProjectRef }): void {
    if (o.waveSize !== undefined) this.waveSize = Math.max(1, Math.round(o.waveSize));
    if (o.stallMs !== undefined) this.stallMs = Math.max(1, Math.round(o.stallMs));
    if (o.project) this.project = o.project;
  }

  /** The ledger as the board holds it: every item's sidecar, read once at construction. */
  private static loadLedger(board: BoardStore, project: ProjectRef, limits?: (projectId: string) => AttemptLimits): AttemptLedger {
    const snapshot: Record<string, never> = {};
    for (const item of board.view(project).items) {
      const side = board.sidecar(project.id, item.id);
      if (side && side.dispatch) (snapshot as Record<string, unknown>)[item.id] = side.dispatch;
    }
    return AttemptLedger.from(snapshot, { projectId: project.id, ...(limits ? { limits } : {}) });
  }
  /** The note on an item the Marshal puts back in the backlog after a failed run. */
  private retryNote(itemId: string, botId: string): string {
    const left = this.ledger.triesLeft(itemId, botId);
    return Number.isFinite(left) ? `The run failed. The Marshal will try again (the ledger allows ${left} more ${left === 1 ? 'try' : 'tries'} on this bot).` : 'The run failed. The Marshal will try again.';
  }
  /** One item's ledger state, written back to its sidecar the moment anything about it changes. */
  private persist(itemId: string): void {
    const state = this.ledger.snapshot()[itemId];
    this.ports.board.setSidecar(this.project.id, itemId, { dispatch: state });
  }

  /** The owner (through the board's dispatch route) writes the checks that decide an item. Nothing dispatches without them. */
  writeDoneWhen(itemId: string, checks: readonly string[]): void {
    this.ledger.setDoneWhen(itemId, checks);
    this.persist(itemId);
  }

  private context(): { catalog: BotCatalogEntry[]; visible(id: string): boolean; busy(id: string): boolean; busyWhy(id: string): string | undefined; depsOf(id: string): readonly string[]; isDone(id: string): boolean } {
    const { board, project } = { board: this.ports.board, project: this.project };
    return {
      catalog: catalogOfAll(this.ports.agents(), (a) => this.ports.visible(a.id)),
      visible: (id: string) => this.ports.visible(id),
      // a string from the port is a busy bot with the place it works named (C3); any project counts: the Marshal never double-books a bot
      busy: (id: string) => [...this.live.values()].some((l) => l.botId === id) || !!this.ports.botBusy?.(id),
      busyWhy: (id: string) => { if ([...this.live.values()].some((l) => l.botId === id)) return undefined; const b = this.ports.botBusy?.(id); return typeof b === 'string' ? b : undefined; },
      depsOf: (id: string) => (board.sidecar(project.id, id)?.deps as string[] | undefined) ?? [],
      isDone: (id: string) => board.get(project.id, id)?.status === 'done',
    };
  }

  /**
   * One wave: walk the dispatchable items in score order and dispatch up to `max` of them. An item the
   * pipeline blocks is moved to the Blocked column with the reason (never forced onto a bot), and the walk
   * continues — one unworkable item never stalls the wave.
   */
  async step(now: number, max = this.waveSize): Promise<StepReport> {
    const ctx = this.context();
    const candidates: DispatchCandidate[] = dispatchable(this.ports.board.view(this.project), ctx);
    const dispatched: DispatchedItem[] = [];
    const blocked: BlockedItem[] = [];
    const waiting: WaitingItem[] = [];
    for (const candidate of candidates) {
      if (dispatched.length >= max) break;
      const item = candidate.item;
      // the injection guard comes first: an agent-writable text is never routed, however eligible the roster is
      const untrusted = untrustedRefusal(item);
      if (untrusted) { blocked.push(this.block(item.id, item.title, untrusted)); continue; }
      let record: AssignmentResult;
      if (candidate.assignedTo && ctx.busy(candidate.assignedTo)) {
        // the owner's bot is merely busy: that passes with time, so the item waits for it (never Blocked for it)
        const where = ctx.busyWhy(candidate.assignedTo);
        waiting.push({ itemId: item.id, title: item.title, reason: `waiting for ${candidate.assignedTo}${where ? ` (${where})` : ' (it is working on another item)'}` });
        continue;
      }
      if (candidate.assignedTo) {
        // the owner named the bot: a routing DECISION, honoured directly — still through every code guard
        record = this.assignFromOwner(item, candidate.assignedTo, ctx);
      } else {
        // capacity before matching: if everyone who could take it is merely busy, that is this wave's shape
        // (come back next pass), not a no-fit. Nobody able to take it ever is a no-fit the owner must see.
        const reuse = (id: string) => this.ledger.mayDispatch(item.id, id);
        const prelim = eligible(ctx.catalog, { members: this.project.members, visible: ctx.visible, busy: ctx.busy, busyWhy: ctx.busyWhy, reuse });
        if (!prelim.candidates.length) {
          const capacity = eligible(ctx.catalog, { members: this.project.members, visible: ctx.visible, busy: () => false, reuse }).candidates.length > 0;
          if (capacity) continue;
          blocked.push(this.block(item.id, item.title, `No eligible bot for this item: ${prelim.excluded.map((e) => `${e.id} (${e.why})`).join('; ') || 'this project has no agents'}`));
          continue;
        }
        record = await assignItem(
          { item, catalog: ctx.catalog, members: this.project.members, visible: ctx.visible, busy: ctx.busy, busyWhy: ctx.busyWhy, reuse },
          this.ports.matcher,
        );
      }
      if (record.outcome !== 'assigned' || !record.botId) {
        const why = record.outcome === 'assigned' ? (record.refused ?? 'no bot') : `${record.reason}${record.refused ? ` (${record.refused})` : ''}`;
        blocked.push(this.block(item.id, item.title, why));
        continue;
      }
      const bot = ctx.catalog.find((b) => b.id === record.botId)!;
      const doneWhen = this.ledger.doneWhen(item.id)!;
      const irreversible = this.irreversibleVerbsOf(item);
      let taskId: string;
      try {
        taskId = this.ports.startRun({ agentId: bot.id, prompt: dispatchPrompt(item, doneWhen), itemId: item.id }).taskId;
      } catch (e) {
        blocked.push(this.block(item.id, item.title, `the run would not start: ${e instanceof Error ? e.message : String(e)}`));
        continue;
      }
      const fit = { gated: bot.approval !== 'full' && irreversible.length > 0 };
      const dispatch: DispatchedItem = {
        itemId: item.id, title: item.title, botId: bot.id, botName: bot.name, model: bot.model, tier: bot.approval,
        irreversible, gated: fit.gated, why: record.reason, score: candidate.score, rankWhy: candidate.why, taskId,
      };
      this.ledger.recordDispatch(item.id, bot.id, taskId);
      this.persist(item.id);
      this.ports.board.beginRun(this.project, item.id, taskId);
      this.live.set(item.id, { itemId: item.id, taskId, botId: bot.id, startedAt: now, dispatch });
      dispatched.push(dispatch);
      this.blocked.delete(item.id);
    }
    this.waiting = waiting;
    return { dispatched, blocked, waiting, candidates: candidates.length };
  }

  /** A wave, by name: the batch view of `step`. */
  wave(now: number, max = this.waveSize): Promise<StepReport> { return this.step(now, max); }

  /**
   * The owner assigned this item to a bot. That is a routing decision, not prose to match, so it is honoured
   * directly — and still through every code guard: membership, visibility, one owner at a time, the attempt
   * ledger, and the deny table for any irreversible verb the item names.
   */
  private assignFromOwner(item: WorkItem, botId: string, ctx: ReturnType<Marshal['context']>): AssignmentResult {
    const refuse = (why: string): AssignmentResult => ({ botId: null, outcome: 'blocked', reason: `the owner assigned this item to ${botId}`, refused: why, matched: ['owner-assignment'], considered: [botId], confidence: 1 });
    const bot = ctx.catalog.find((b) => b.id === botId);
    if (!bot) return refuse(this.project.members.includes(botId) ? 'that bot is switched off (its feature is off)' : 'that bot is not a member of this project');
    if (ctx.busy(botId)) return refuse('that bot already owns a live run');
    const reuse = this.ledger.mayDispatch(item.id, botId);
    if (!reuse.ok) return refuse(reuse.why);
    const fit = verbFit(bot, irreversibleVerbsIn(`${item.title}\n${item.description}`));
    if (!fit.ok) return refuse(fit.why);
    return { botId, outcome: 'assigned', reason: 'the owner assigned this item to it', matched: ['owner-assignment'], considered: [botId], confidence: 1 };
  }

  private block(itemId: string, title: string, reason: string): BlockedItem {
    const entry = { itemId, title, reason };
    this.blocked.set(itemId, entry);
    try { this.ports.board.systemMove(this.project, itemId, 'blocked', `The Marshal did not dispatch this: ${reason}`); } catch { /* a read-only board still reports through status */ }
    return entry;
  }

  /** The irreversible verbs the owner's text names — the same clause scan the deny table is keyed off. Runs on owner-trusted text only: the pipeline blocks untrusted items before dispatch. */
  private irreversibleVerbsOf(item: { title: string; description: string }): IrreversibleVerb[] {
    return irreversibleVerbsIn(`${item.title}\n${item.description}`);
  }

  /**
   * Look at every run in flight: settle the ones that ended, and bound the stalled ones — cancel the run,
   * count the stall, and put the item back for the next bot (forward-only). The second stall on one item
   * ends the ladder: it goes to the owner, who decides what changes.
   */
  monitor(now: number): MonitorReport {
    const report: MonitorReport = { finished: [], failed: [], stalled: [], escalated: [], stallsKept: [] };
    for (const [itemId, live] of [...this.live]) {
      const state = this.ports.runState(live.taskId);
      if (state.status === 'running' || state.status === 'queued') {
        // queued behind the engine cap, or waiting on the owner's card or answer: nobody's fault, never a stall
        if (state.status === 'queued' || state.waitingOnOwner) continue;
        const progressAt = state.progressAt ?? live.startedAt;
        if (now - progressAt < this.stallMs) continue;
        if (!this.ladderOn()) {
          // the owner switched "Stop runs that stall" off for this project: the run keeps going, and one line says it passed the limit
          report.stallsKept.push(itemId);
          if (!live.stallNoted) {
            live.stallNoted = true;
            try { this.onStallKept?.({ itemId, title: live.dispatch.title, taskId: live.taskId, botId: live.botId, minutes: Math.round(this.stallMs / 60_000) }); } catch { /* advisory */ }
          }
          continue;
        }
        this.ports.cancelRun(live.taskId);
        // the item's run is over: end it on the board too (the same call the module makes when the engine
        // reports the cancel), so the stale activeRun never keeps it out of the next wave
        this.ports.board.endRun(this.project.id, live.taskId, { status: 'cancelled', isError: true, text: 'The Marshal stopped this run: it stalled without progress.', tainted: state.tainted !== false });
        this.live.delete(itemId);
        this.ledger.runEnded(itemId, 'stalled');
        this.persist(itemId);
        report.stalled.push(itemId);
        if (this.ledger.stalls(itemId) >= this.escalateAfterStalls) {
          report.escalated.push(itemId);
          this.block(itemId, live.dispatch.title, `this item stalled ${this.ledger.stalls(itemId)} times (the last run made no progress for ${Math.round(this.stallMs / 60_000)} minutes). It needs the owner, not another try.`);
        } else {
          try { this.ports.board.systemMove(this.project, itemId, 'backlog', `The run stalled and was stopped after ${Math.round(this.stallMs / 60_000)} minutes without progress. The Marshal will try again with another bot.`); } catch { /* status still shows it */ }
        }
        continue;
      }
      this.live.delete(itemId);
      if (state.status === 'done') {
        this.ledger.runEnded(itemId, 'done');
        report.finished.push(itemId);
      } else {
        this.ledger.runEnded(itemId, state.status === 'cancelled' ? 'cancelled' : 'failed');
        report.failed.push(itemId);
        // a failed run the board put in Blocked gets one more pass if the ledger still allows it
        if (state.status !== 'cancelled' && this.ledger.mayDispatch(itemId, live.botId).ok) {
          try { this.ports.board.systemMove(this.project, itemId, 'backlog', this.retryNote(itemId, live.botId)); } catch { /* status still shows it */ }
        }
      }
      this.persist(itemId);
    }
    return report;
  }

  /** The human-visible picture: what is running and why that bot, what is blocked and why, what is next and why. `now` is taken for interface symmetry with `step`/`monitor`: this read is timeless. */
  status(_now: number): MarshalStatus {
    const running = [...this.live.values()].map((l) => ({ ...l.dispatch, startedAt: l.startedAt, attempts: this.ledger.attempts(l.itemId, l.botId) }));
    const blocked = [...this.blocked.values()];
    const ctx = this.context();
    const next = dispatchable(this.ports.board.view(this.project), ctx).slice(0, 5).map((c) => ({ itemId: c.item.id, title: c.item.title, score: c.score, why: c.why }));
    return { running, blocked, next };
  }

  /** The STATUS the Marshal's own doctrine asks for, as plain lines. */
  statusText(now: number): string {
    const s = this.status(now);
    const lines: string[] = [`STATUS ${s.running.length} running, ${s.blocked.length} blocked, ${s.next.length} next`];
    for (const r of s.running) lines.push(`Running: ${r.title} → ${r.botName} (${r.model}, ${r.tier}${r.irreversible.length ? `, irreversible: ${r.irreversible.join(', ')}${r.gated ? ' — the card will gate it' : ''}` : ''}). Why: ${r.why} Rank: ${r.rankWhy}`);
    for (const b of s.blocked) lines.push(`Blocked: ${b.title}. ${b.reason}`);
    for (const w of this.waiting) lines.push(`Waiting: ${w.title}. ${w.reason}`);
    for (const n of s.next) lines.push(`Next: ${n.title} (score ${n.score}). ${n.why}`);
    return lines.join('\n');
  }
}
