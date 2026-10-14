/**
 * The pure parts of how main follows the core: reading the event stream, and turning core events into the fixed-field signals the
 * plan (attention.ts) uses. Nothing here keeps or forwards the text of an ask, a result or a command (spec 5.8).
 */
import { periodStart } from '../shared/spend-periods.js';
import type { LegionEvent } from '../shared/types.js';
import { askSignal, sanitizeName } from './attention.js';
import type { AskSignal, BudgetSignal, NameLookup, RunSignal } from './attention.js';

const MAX_BUFFER = 2_000_000;

/** Incremental reader for a text/event-stream body: feed it chunks, get the JSON events out. */
export class SseReader {
  private buf = '';
  private dropping = false;

  push(chunk: string): unknown[] {
    this.buf += chunk.replace(/\r\n/g, '\n');
    const out: unknown[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      if (this.dropping) { this.dropping = false; continue; } // the tail of a block that was too long
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue; // a comment or heartbeat
      try { out.push(JSON.parse(data)); } catch { /* not ours */ }
    }
    if (this.buf.length > MAX_BUFFER) { this.buf = ''; this.dropping = true; }
    return out;
  }
}

/** A run that failed or finished, reduced to ids and names. */
export function runSignal(t: { id: string; agentId: string; status: string; projectId?: string }, names: NameLookup): RunSignal {
  const projectId = t.projectId ?? null;
  return { key: `${t.status === 'error' ? 'f' : 'd'}:${t.id}`, agentName: sanitizeName(names.agent(t.agentId)), projectId, projectName: projectId ? sanitizeName(names.project(projectId)) || null : null, taskId: t.id };
}

export interface EventSignals { failed?: RunSignal[]; finished?: RunSignal[]; budget?: BudgetSignal[] }

/**
 * Folds one core event into the open asks (`open`, by key) and returns what is new. A run is news only when it changes from queued or
 * running to error or done while we watch (`statuses` remembers the last one): seeing an old failed task again changes nothing.
 */
export function eventSignals(ev: LegionEvent, open: Map<string, AskSignal>, names: NameLookup, statuses: Map<string, string>, now: number = Date.now()): EventSignals {
  switch (ev.type) {
    case 'approval.requested': { const s = askSignal('approval', ev.approval, names); open.set(s.key, s); return {}; }
    case 'question.requested': { const s = askSignal('question', ev.question, names); open.set(s.key, s); return {}; }
    case 'approval.resolved': open.delete(`a:${ev.approvalId}`); return {};
    case 'question.resolved': open.delete(`a:${ev.questionId}`); return {};
    case 'task.updated': {
      const t = ev.task;
      const before = statuses.get(t.id);
      statuses.set(t.id, t.status);
      if (statuses.size > 2000) statuses.delete(statuses.keys().next().value as string);
      const wasLive = before === 'queued' || before === 'running';
      if (!wasLive || (t.status !== 'error' && t.status !== 'done')) return {};
      const sig = runSignal(t, names);
      return t.status === 'error' ? { failed: [sig] } : { finished: [sig] };
    }
    case 'budget.reached':
      return { budget: [{ key: `b:${ev.projectId}:${ev.period}:${periodStart(ev.period, now)}`, projectId: ev.projectId, projectName: sanitizeName(names.project(ev.projectId)) || null, period: ev.period }] };
    default: return {};
  }
}

/* ---------- what main knows about the core ---------- */

export interface Snapshot {
  agents: Array<{ id: string; name: string }>;
  projects?: Array<{ id: string; name: string }>;
  tasks: Array<{ id: string; status: string; agentId: string; projectId?: string }>;
  approvals: Array<{ id: string; taskId: string; agentId: string; projectId?: string }>;
  questions?: Array<{ id: string; taskId: string; agentId: string; projectId?: string }>;
  parked?: Array<{ id: string; taskId: string; agentId: string; projectId?: string }>;
  attention: { total: number; working?: number; byProject: Record<string, number>; nextProposal?: { projectId: string; itemId: string } };
}
type Pending = { failed: RunSignal[]; finished: RunSignal[]; budget: BudgetSignal[] };
const LIVE = new Set(['queued', 'running']);

/** The facts the plan needs, kept from a snapshot and the event stream. Nothing here holds the text of an ask. */
export class Feed {
  readonly open = new Map<string, AskSignal>();
  total = 0;
  byProject: Record<string, number> = {};
  nextProposal: { projectId: string; itemId: string } | undefined;
  private readonly statuses = new Map<string, string>();
  private readonly agents = new Map<string, string>();
  private readonly projects = new Map<string, string>();
  private readonly taskProject = new Map<string, string>();
  private pending: Pending = { failed: [], finished: [], budget: [] };

  private readonly names: NameLookup = {
    agent: (id) => this.agents.get(id), project: (id) => this.projects.get(id), projectOfTask: (t) => this.taskProject.get(t),
  };

  /**
   * Takes a fresh look (at start, and after every reconnect). Returns the keys of the asks open now: the caller adopts them so they are
   * not announced. A run that was live in the last look and has failed or finished since is announced once.
   */
  reseed(s: Snapshot): string[] {
    this.agents.clear();
    for (const a of s.agents) this.agents.set(a.id, a.name);
    if (s.projects) { this.projects.clear(); for (const p of s.projects) this.projects.set(p.id, p.name); }
    for (const t of s.tasks) {
      if (t.projectId) this.taskProject.set(t.id, t.projectId);
      const before = this.statuses.get(t.id);
      if (before !== undefined && LIVE.has(before) && (t.status === 'error' || t.status === 'done')) {
        (t.status === 'error' ? this.pending.failed : this.pending.finished).push(runSignal(t, this.names));
      }
      this.statuses.set(t.id, t.status);
    }
    this.open.clear();
    const add = (kind: AskSignal['kind'], x: { id: string; taskId: string; agentId: string; projectId?: string }): void => {
      const sig = askSignal(kind, x, this.names);
      this.open.set(sig.key, sig);
    };
    for (const a of s.approvals) add('approval', a);
    for (const q of s.questions ?? []) add('question', q);
    for (const p of s.parked ?? []) add('parked', p);
    this.total = s.attention.total;
    this.byProject = { ...s.attention.byProject };
    this.nextProposal = s.attention.nextProposal;
    return [...this.open.keys()];
  }

  apply(ev: LegionEvent): void {
    switch (ev.type) {
      case 'attention.updated': this.total = ev.attention.total; this.byProject = { ...ev.attention.byProject }; this.nextProposal = ev.attention.nextProposal; break;
      case 'agent.updated': this.agents.set(ev.agent.id, ev.agent.name); break;
      case 'project.updated': this.projects.set(ev.project.id, ev.project.name); break;
      case 'task.updated': if (ev.task.projectId) this.taskProject.set(ev.task.id, ev.task.projectId); break;
      default: break;
    }
    const sig = eventSignals(ev, this.open, this.names, this.statuses);
    if (sig.failed) this.pending.failed.push(...sig.failed);
    if (sig.finished) this.pending.finished.push(...sig.finished);
    if (sig.budget) this.pending.budget.push(...sig.budget);
  }

  /** The count when only the poll is available. */
  setCount(total: number, byProject?: Record<string, number>): void { this.total = total; if (byProject) this.byProject = { ...byProject }; }

  takePending(): Pending { const p = this.pending; this.pending = { failed: [], finished: [], budget: [] }; return p; }

  /**
   * Where "open what needs you" goes: the first open ask; if only proposals wait (they count toward the number but have no pop-up,
   * spec 3.9), the oldest proposal (the core names it), else the project that holds them; else nothing in particular.
   */
  firstRef(): { projectId?: string; taskId?: string; itemId?: string } {
    const a = this.open.values().next().value as AskSignal | undefined;
    if (a) return { ...(a.projectId ? { projectId: a.projectId } : {}), ...(a.taskId ? { taskId: a.taskId } : {}) };
    if (this.nextProposal) return { projectId: this.nextProposal.projectId, itemId: this.nextProposal.itemId };
    const p = Object.entries(this.byProject).find(([id, n]) => id !== 'none' && n > 0);
    return p ? { projectId: p[0] } : {};
  }
}

/* ---------- following the core ---------- */

export interface FollowDeps {
  core(): { port: number; headers: Record<string, string> } | undefined;
  fetchFn: typeof fetch;
  stopped(): boolean;
  sleep(ms: number): Promise<void>;
  /** The stream is open: take a fresh look. Runs at the first connect and at every reconnect. */
  onConnected(): Promise<void>;
  onEvent(ev: LegionEvent): void;
  /** The stream is down: the count from GET /api/attention. */
  onPoll(a: { total: number; byProject: Record<string, number> }): Promise<void> | void;
}
export const POLL_MS = 3000;

/** The stream, forever: reconnects after a drop (and looks again), and polls the count while it is down. */
export async function follow(d: FollowDeps): Promise<void> {
  while (!d.stopped()) {
    const c = d.core();
    if (!c) { await d.sleep(POLL_MS); continue; }
    try {
      const res = await d.fetchFn(`http://127.0.0.1:${c.port}/api/events`, { headers: c.headers });
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      await d.onConnected();
      const reader = new SseReader();
      const dec = new TextDecoder();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (d.stopped()) return;
        for (const ev of reader.push(dec.decode(chunk, { stream: true }))) d.onEvent(ev as LegionEvent);
      }
    } catch { /* dropped: fall through to the poll */ }
    if (d.stopped()) return;
    try {
      const r = await d.fetchFn(`http://127.0.0.1:${c.port}/api/attention`, { headers: c.headers });
      if (r.ok) {
        const a = (await r.json()) as { total?: number; byProject?: Record<string, number> };
        if (typeof a.total === 'number') await d.onPoll({ total: a.total, byProject: a.byProject ?? {} });
      }
    } catch { /* still down */ }
    await d.sleep(POLL_MS);
  }
}
