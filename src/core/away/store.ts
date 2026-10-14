/**
 * The away store: per-project and app settings for the owner's absence (what happens to an unanswered ask, pause, budget,
 * notification level, quiet hours) and the "since you last looked" times. File: <dataDir>/away/policy.json.
 *
 * Why its own file in its own folder (spec 4.1): not config.json (a bot can edit it) and not projects.json. The folder is one
 * `protectedPaths()` entry, which stops the file tools, not Bash. The core keeps the policy in memory and treats the file as
 * persistence (read at start only), so a shell edit takes effect after the next core start. Be honest about what that allows:
 *
 *   - Nothing in this file can allow an ask. There is no setting that approves anything; allow-capable state is a gate rule.
 *   - It CAN undo the owner's own choices after a restart: turn a pause off, remove a budget, shorten a park time. That is the
 *     same exposure as config.json, and the reason a budget override is cut on load to the end of the current period (and dropped
 *     without a budget), so an edit cannot switch a budget off for years.
 *
 * Values are bounded on load (park 1 to 120 minutes, budget finite and above zero, times valid and from != to); an invalid value is
 * replaced by its default. Writes are debounced, tmp + rename, unknown fields are kept, a corrupt file is renamed aside.
 * In short: it can undo the owner's own pause or budget, it can never allow an ask.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { validQuiet } from '../../shared/ask-clock.js';
import type { QuietConfig } from '../../shared/ask-clock.js';
import { periodEnd } from '../../shared/spend-periods.js';

export class AwayError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'AwayError'; }
}

export type BudgetPeriod = 'day' | 'week' | 'month';
export type NotifyLevel = 'problems' | 'everything' | 'nothing';
export interface SilencePolicy { mode: 'deny' | 'park'; parkMinutes: number }
export interface ProjectAway {
  onSilence: SilencePolicy;
  paused: boolean;
  budget: { limit: number; period: BudgetPeriod } | null;
  /** ISO end of the period in which the owner chose "Run anyway". */
  budgetOverrideUntil?: string;
  notify: NotifyLevel;
}
export interface AppAway { quiet: QuietConfig; notify: { enabled: boolean; returnSummary: boolean } }
/** The settings an owner PATCH may carry. */
export type ProjectAwayPatch = Partial<Pick<ProjectAway, 'onSilence' | 'paused' | 'budget' | 'notify'>>;
export type AppAwayPatch = { quiet?: QuietConfig; notify?: Partial<AppAway['notify']> };

export const PARK_MIN = 1;
export const PARK_MAX = 120;
export const DEFAULT_QUIET: QuietConfig = { enabled: false, from: '22:00', to: '07:00' };
export const DEFAULT_PROJECT_AWAY: ProjectAway = { onSilence: { mode: 'deny', parkMinutes: 3 }, paused: false, budget: null, notify: 'problems' };
const DEFAULT_APP: AppAway = { quiet: DEFAULT_QUIET, notify: { enabled: true, returnSummary: true } };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const DEBOUNCE_MS = 400;

/** One field at a time: a value that is not valid is `undefined` (the caller decides between "default" and "refuse"). */
const parseSilence = (v: unknown): SilencePolicy | undefined => {
  if (!isObj(v) || (v.mode !== 'deny' && v.mode !== 'park')) return undefined;
  const m = v.parkMinutes;
  if (typeof m !== 'number' || !Number.isInteger(m) || m < PARK_MIN || m > PARK_MAX) return undefined;
  return { mode: v.mode, parkMinutes: m };
};
const parseBudget = (v: unknown): { limit: number; period: BudgetPeriod } | null | undefined => {
  if (v === null) return null;
  if (!isObj(v) || typeof v.limit !== 'number' || !Number.isFinite(v.limit) || v.limit <= 0) return undefined;
  if (v.period !== 'day' && v.period !== 'week' && v.period !== 'month') return undefined;
  return { limit: v.limit, period: v.period };
};
const parseNotify = (v: unknown): NotifyLevel | undefined => (v === 'problems' || v === 'everything' || v === 'nothing' ? v : undefined);
const parseQuiet = (v: unknown): QuietConfig | undefined => {
  if (!isObj(v) || typeof v.enabled !== 'boolean' || typeof v.from !== 'string' || typeof v.to !== 'string') return undefined;
  const q: QuietConfig = { enabled: v.enabled, from: v.from, to: v.to };
  // an enabled window must be a real one; a disabled one just has to be well formed
  if (q.enabled) return validQuiet(q) ? q : undefined;
  return validQuiet({ ...q, enabled: true }) ? q : undefined;
};

export class AwayStore {
  private readonly file: string;
  private appPolicy: AppAway = structuredClone(DEFAULT_APP);
  private readonly projects = new Map<string, ProjectAway>();
  private readonly lookedAt = new Map<string, string>();
  private readonly noted = new Map<string, string>();
  private topExtra: Record<string, unknown> = {};
  private appExtra: Record<string, unknown> = {};
  private readonly projectExtra = new Map<string, Record<string, unknown>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {
    this.file = join(dir, 'policy.json');
    this.load();
  }

  /** The folder the file tools must not change (a CoreModule `protectedPaths()` entry). */
  get folder(): string { return this.dir; }

  /* ---------- reads ---------- */
  app(): AppAway { return structuredClone(this.appPolicy); }
  project(id: string): ProjectAway { return structuredClone(this.projects.get(id) ?? DEFAULT_PROJECT_AWAY); }
  looked(id: string): string | undefined { return this.lookedAt.get(id); }
  budgetNoted(id: string): string | undefined { return this.noted.get(id); }
  /** Everything the app window shows, with defaults filled in for the given projects. */
  view(projectIds: readonly string[]): { app: AppAway; projects: Record<string, ProjectAway>; looked: Record<string, string> } {
    const projects: Record<string, ProjectAway> = {};
    for (const id of projectIds) projects[id] = this.project(id);
    return { app: this.app(), projects, looked: Object.fromEntries(this.lookedAt) };
  }

  /* ---------- writes (an owner's change; refused when invalid) ---------- */
  patchProject(id: string, patch: unknown): ProjectAway {
    if (!isObj(patch)) throw new AwayError(400, 'JSON object body required');
    const cur = this.project(id);
    const next: ProjectAway = { ...cur };
    if ('onSilence' in patch) {
      const v = parseSilence(patch.onSilence);
      if (!v) throw new AwayError(400, `onSilence must be {mode:'deny'|'park', parkMinutes: whole number ${PARK_MIN} to ${PARK_MAX}}`);
      next.onSilence = v;
    }
    if ('paused' in patch) {
      if (typeof patch.paused !== 'boolean') throw new AwayError(400, 'paused must be true or false');
      next.paused = patch.paused;
    }
    if ('budget' in patch) {
      const v = parseBudget(patch.budget);
      if (v === undefined) throw new AwayError(400, "budget must be null or {limit: number above 0, period: 'day'|'week'|'month'}");
      next.budget = v;
      // a new budget starts a fresh decision: an old "run anyway" no longer applies
      delete next.budgetOverrideUntil;
    }
    if ('notify' in patch) {
      const v = parseNotify(patch.notify);
      if (!v) throw new AwayError(400, "notify must be 'problems', 'everything' or 'nothing'");
      next.notify = v;
    }
    this.projects.set(id, next);
    this.touch();
    return structuredClone(next);
  }

  patchApp(patch: unknown): AppAway {
    if (!isObj(patch)) throw new AwayError(400, 'JSON object body required');
    const next = this.app();
    if ('quiet' in patch) {
      const v = parseQuiet(patch.quiet);
      if (!v) throw new AwayError(400, 'quiet must be {enabled, from:"HH:MM", to:"HH:MM"} with two different times');
      next.quiet = v;
    }
    if ('notify' in patch) {
      const n = patch.notify;
      if (!isObj(n)) throw new AwayError(400, 'notify must be an object');
      for (const k of ['enabled', 'returnSummary'] as const) {
        if (k in n) {
          if (typeof n[k] !== 'boolean') throw new AwayError(400, `notify.${k} must be true or false`);
          next.notify[k] = n[k] as boolean;
        }
      }
    }
    this.appPolicy = next;
    this.touch();
    return this.app();
  }

  /** "Mark as seen": the core's own clock, never the client's. */
  markSeen(id: string, atIso: string): void { this.lookedAt.set(id, atIso); this.touch(); }
  setBudgetOverride(id: string, untilIso: string | undefined): void {
    const p = this.project(id);
    if (untilIso) p.budgetOverrideUntil = untilIso; else delete p.budgetOverrideUntil;
    this.projects.set(id, p);
    this.touch();
  }
  noteBudget(id: string, periodStartIso: string): void { this.noted.set(id, periodStartIso); this.touch(); }

  /** Drops settings of projects that no longer exist. */
  prune(existingIds: readonly string[]): void {
    const keep = new Set(existingIds);
    let changed = false;
    for (const m of [this.projects, this.lookedAt, this.noted, this.projectExtra] as Array<Map<string, unknown>>) {
      for (const id of [...m.keys()]) if (!keep.has(id)) { m.delete(id); changed = true; }
    }
    if (changed) this.touch();
  }

  /* ---------- persistence ---------- */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.dirty) this.persist();
    await this.writing;
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.file, 'utf8')); } catch { raw = undefined; }
    if (!isObj(raw)) {
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* defaults are used either way */ }
      return;
    }
    const { version: _v, app, projects, looked, budgetNoted, ...top } = raw;
    this.topExtra = top;
    if (isObj(app)) {
      const { quiet, notify, ...appRest } = app;
      this.appExtra = appRest;
      this.appPolicy = {
        quiet: parseQuiet(quiet) ?? structuredClone(DEFAULT_QUIET),
        notify: {
          enabled: isObj(notify) && typeof notify.enabled === 'boolean' ? notify.enabled : DEFAULT_APP.notify.enabled,
          returnSummary: isObj(notify) && typeof notify.returnSummary === 'boolean' ? notify.returnSummary : DEFAULT_APP.notify.returnSummary,
        },
      };
    }
    if (isObj(projects)) {
      for (const [id, p] of Object.entries(projects)) {
        if (!isObj(p)) continue;
        const { onSilence, paused, budget, budgetOverrideUntil, notify, ...rest } = p;
        const parsedBudget = parseBudget(budget) ?? null;
        // an override ("run anyway") only ever lasts to the end of the current period, and needs a budget: a file that says later is cut
        let override: string | undefined;
        if (parsedBudget && isIso(budgetOverrideUntil)) {
          const cap = periodEnd(parsedBudget.period, Date.now());
          override = Date.parse(budgetOverrideUntil) > cap ? new Date(cap).toISOString() : budgetOverrideUntil;
        }
        const cur: ProjectAway = {
          onSilence: parseSilence(onSilence) ?? structuredClone(DEFAULT_PROJECT_AWAY.onSilence),
          paused: paused === true,
          budget: parsedBudget,
          notify: parseNotify(notify) ?? DEFAULT_PROJECT_AWAY.notify,
          ...(override ? { budgetOverrideUntil: override } : {}),
        };
        this.projects.set(id, cur);
        if (Object.keys(rest).length) this.projectExtra.set(id, rest);
      }
    }
    if (isObj(looked)) for (const [id, t] of Object.entries(looked)) if (isIso(t)) this.lookedAt.set(id, t);
    if (isObj(budgetNoted)) for (const [id, t] of Object.entries(budgetNoted)) if (isIso(t)) this.noted.set(id, t);
  }

  private touch(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.persist(); }, DEBOUNCE_MS);
    this.timer.unref?.();
  }

  private persist(): void {
    this.dirty = false;
    const projects: Record<string, unknown> = {};
    for (const [id, p] of this.projects) projects[id] = { ...(this.projectExtra.get(id) ?? {}), ...p };
    for (const [id, extra] of this.projectExtra) if (!(id in projects)) projects[id] = extra;
    const json = JSON.stringify({
      ...this.topExtra, version: 1,
      app: { ...this.appExtra, ...this.appPolicy },
      projects, looked: Object.fromEntries(this.lookedAt), budgetNoted: Object.fromEntries(this.noted),
    });
    this.writing = this.writing.then(async () => {
      const { writeFile, rename, unlink } = await import('node:fs/promises');
      mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      await writeFile(tmp, json, 'utf8');
      try { await rename(tmp, this.file); } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EEXIST') { await unlink(this.file).catch(() => undefined); await rename(tmp, this.file); } else throw e;
      }
    }).catch(() => { /* best effort: the policy stays in memory */ });
  }
}
