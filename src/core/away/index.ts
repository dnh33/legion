/**
 * The away module (0.3.0 "Runs without you"): the owner's absence settings, the spend ledger and budget, the attention counts.
 * Routes are admin-only by the gate's default deny (none is a client route): a bearer token gets 403.
 *
 * What it can do to an ask: nothing but lengthen or end a wait with a "no" (see policy.ts). It cannot allow anything.
 */
import { join } from 'node:path';
import type { WorkItem } from '../../shared/board.js';
import { periodEnd } from '../../shared/spend-periods.js';
import type { AttentionView, CoreCaps, LegionEvent, ParkedAsk } from '../../shared/types.js';
import type { EventBus } from '../bus.js';
import type { AwayHooks } from '../engine.js';
import type { CoreModule, ModuleDeps } from '../modules.js';
import { HttpError } from '../server.js';
import type { Ctx } from '../server.js';
import type { ProjectStore } from '../projects/store.js';
import { AttentionTracker } from './attention.js';
import { budgetStatus, SpendLedger } from './ledger.js';
import type { BudgetStatus } from './ledger.js';
import type { AskPolicy } from './policy.js';
import { AwayError, AwayStore } from './store.js';
import { validQuiet } from '../../shared/ask-clock.js';

export { AwayStore, AwayError } from './store.js';
export { SpendLedger, budgetStatus } from './ledger.js';
export { AttentionTracker } from './attention.js';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The pieces together: what the engine, the brokers and the Marshal ask of the away features. */
export class AwayService implements AwayHooks {
  constructor(private readonly d: {
    store: AwayStore; ledger: SpendLedger; bus: EventBus; now?: () => number;
    /** The project a task belongs to (the task's own project, not whether it can run there). */
    projectOfTask?: (taskId: string) => string | undefined;
    /** Whether "Stop at the budget" is on for a project (the gates module's answer). Absent or unreadable reads as on. */
    stopsAtBudget?: (projectId: string) => boolean;
  }) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  isPaused(projectId: string): boolean { return this.d.store.project(projectId).paused; }

  status(projectId: string): BudgetStatus { return budgetStatus(this.d.ledger, this.d.store.project(projectId), projectId, this.now()); }

  /** Pure: reading it (the queue snapshot, a state request) never sends a notice. Notices come from `recordSpend` and `checkBudget`. */
  budgetBlocked(projectId: string): boolean { return this.status(projectId).reached; }

  /** When the period that holds this project's starts ends, or undefined when no budget holds it. */
  budgetRollsAt(projectId: string): number | undefined {
    const st = this.status(projectId);
    return st.reached ? st.periodEnd : undefined;
  }

  /** The owner changed a budget: tell once if it is already reached. */
  checkBudget(projectId: string): void {
    const st = this.status(projectId);
    if (st.reached) this.noteReached(projectId, st);
  }

  recordSpend(e: { taskId: string; agentId: string; projectId?: string; usd: number }): void {
    this.d.ledger.record({ at: new Date(this.now()).toISOString(), ...e });
    if (e.projectId) {
      const st = this.status(e.projectId);
      if (st.reached) this.noteReached(e.projectId, st);
    }
  }

  /** One `budget.reached` per project and period. */
  private noteReached(projectId: string, st: BudgetStatus): void {
    if (st.periodStart === undefined || !st.period) return;
    const key = new Date(st.periodStart).toISOString();
    if (this.d.store.budgetNoted(projectId) === key) return;
    this.d.store.noteBudget(projectId, key);
    let stops = true;
    try { stops = this.d.stopsAtBudget?.(projectId) !== false; } catch { /* unreadable: on */ }
    try { this.d.bus.emit({ type: 'budget.reached', projectId, period: st.period, stops }); } catch { /* advisory */ }
  }

  /** "Run anyway this week": lifts the budget to the end of its period. */
  overrideBudget(projectId: string): void {
    const st = this.status(projectId);
    if (!st.limited || st.periodStart === undefined || !st.period) throw new AwayError(409, 'This project has no budget to run past.');
    this.d.store.setBudgetOverride(projectId, new Date(periodEnd(st.period, this.now())).toISOString());
  }

  /** What the brokers read per ask. */
  policy(): AskPolicy {
    return {
      policyFor: (projectId) => (projectId ? this.d.store.project(projectId).onSilence : { onSilence: 'deny' as const, parkMinutes: 3 }) as { onSilence: 'deny' | 'park'; parkMinutes: number },
      quiet: () => validQuiet(this.d.store.app().quiet),
      ...(this.d.projectOfTask ? { projectOf: this.d.projectOfTask } : {}),
    };
  }

  /** What this build can do; a setting for a missing feature stays hidden. Park ships in a later step. */
  caps(): CoreCaps { return {}; }
  parked(): ParkedAsk[] { return []; }
}

/** The part the engine and the brokers need before the module exists: the settings, the ledger and the service over them. */
export interface AwayCore { store: AwayStore; ledger: SpendLedger; service: AwayService }
export function createAwayCore(o: {
  dataDir: string; bus: EventBus; now?: () => number;
  /** Used to find a task's project for an ask a module raised without one. */
  tasks: { getTask(id: string): { projectId?: string } | undefined };
  projects?: ProjectStore;
  /** See AwayService: whether "Stop at the budget" is on for a project, so the one notice says the truth. */
  stopsAtBudget?: (projectId: string) => boolean;
}): AwayCore {
  const dir = join(o.dataDir, 'away');
  const store = new AwayStore(dir);
  try { if (o.projects) store.prune(o.projects.list().map((p) => p.id)); } catch { /* the settings stay as they are */ }
  const ledger = new SpendLedger(dir, o.now);
  const service = new AwayService({ store, ledger, bus: o.bus, ...(o.now ? { now: o.now } : {}), projectOfTask: (id) => o.tasks.getTask(id)?.projectId, ...(o.stopsAtBudget ? { stopsAtBudget: o.stopsAtBudget } : {}) });
  return { store, ledger, service };
}

export interface AwayModuleOpts {
  projects: ProjectStore;
  /** Built earlier when the engine needs it at construction (the composition root). Absent: built here. */
  core?: AwayCore;
  /** Proposals waiting in the project Inboxes (board items with a `proposal`). */
  inbox?: () => Array<Pick<WorkItem, 'id' | 'projectId' | 'createdAt' | 'createdBy'>>;
  /** The structured-question broker, so a waiting question counts as an ask. */
  questions?: { pending(): import('../../shared/types.js').PendingQuestion[] };
  agentOk?: (agentId: string) => boolean;
  now?: () => number;
}
export interface AwayModule extends CoreModule { service: AwayService; store: AwayStore; ledger: SpendLedger; attention: AttentionTracker }

export function createAwayModule(deps: ModuleDeps, opts: AwayModuleOpts): AwayModule {
  const core = opts.core ?? createAwayCore({ dataDir: deps.dataDir, bus: deps.bus, tasks: deps.store, projects: opts.projects, ...(opts.now ? { now: opts.now } : {}) });
  const { store, ledger, service } = core;
  const attention = new AttentionTracker({
    bus: deps.bus, approvals: deps.approvals, store: deps.store,
    ...(opts.questions ? { questions: opts.questions } : {}),
    working: () => deps.engine.running().length,
    ...(opts.inbox ? { inbox: opts.inbox } : {}), parked: () => service.parked(), ...(opts.agentOk ? { agentOk: opts.agentOk } : {}),
    projectActive: (id) => opts.projects.get(id)?.status !== 'archived',
  });
  const now = (): number => (opts.now ?? Date.now)();
  const wrap = <T>(fn: () => T): T => {
    try { return fn(); } catch (e) {
      if (e instanceof AwayError) throw new HttpError(e.status, e.message);
      throw e;
    }
  };
  const emit = (): void => { try { deps.bus.emit({ type: 'away.updated' } as LegionEvent); } catch { /* advisory */ } };
  const must = (id: string | undefined): string => {
    if (!id || !opts.projects.get(id)) throw new HttpError(404, `Unknown project "${String(id).slice(0, 40)}"`);
    return id;
  };
  const body = (c: Ctx): Record<string, unknown> => { if (!isObj(c.body)) throw new HttpError(400, 'JSON object body required'); return c.body; };

  return {
    id: 'away', service, store, ledger, attention,
    protectedPaths: () => [store.folder],
    routes: (add) => {
      add('GET', '/api/away', () => store.view(opts.projects.list().map((p) => p.id)));
      add('PATCH', '/api/away/app', (c) => { const r = wrap(() => store.patchApp(body(c))); emit(); return r; });
      add('PATCH', '/api/away/projects/:id', (c) => { const id = must(c.params[0]); const r = wrap(() => store.patchProject(id, body(c))); service.checkBudget(id); emit(); return r; });
      add('POST', '/api/away/projects/:id/seen', (c) => { const id = must(c.params[0]); const at = new Date(now()).toISOString(); store.markSeen(id, at); emit(); return { looked: at }; });
      add('POST', '/api/away/projects/:id/budget-override', (c) => { const id = must(c.params[0]); wrap(() => service.overrideBudget(id)); emit(); return { ok: true }; });
      add('GET', '/api/attention', (): AttentionView => attention.get());
      add('GET', '/api/spend', ({ url }) => {
        const scope = url.searchParams.get('scope') ?? 'app';
        if (scope === 'app') return ledger.summary(now());
        if (scope === 'project') {
          const id = must(url.searchParams.get('project') ?? undefined);
          // the page needs the verdict (reached, overridden, when the period rolls over), not only the week's sum
          const { limited, reached, overridden, spent, limit, period, periodEnd } = service.status(id);
          const sinceRaw = url.searchParams.get('since');
          let sinceUsd: number | undefined;
          if (sinceRaw !== null) {
            const t = Date.parse(sinceRaw);
            if (!Number.isFinite(t)) throw new HttpError(400, 'since must be a time');
            sinceUsd = ledger.since(t, now(), id);
          }
          return { ...ledger.summary(now(), id), ...(sinceUsd !== undefined ? { sinceUsd } : {}), budget: { limited, reached, overridden, spent, ...(limit !== undefined ? { limit } : {}), ...(period ? { period } : {}), ...(periodEnd !== undefined ? { periodEnd } : {}) } };
        }
        throw new HttpError(400, "scope must be 'app' or 'project'");
      });
    },
    dispose: async () => { attention.dispose(); await store.flush(); },
  };
}
