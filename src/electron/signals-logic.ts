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
      const projectId = t.projectId ?? null;
      const sig: RunSignal = { key: `${t.status === 'error' ? 'f' : 'd'}:${t.id}`, agentName: sanitizeName(names.agent(t.agentId)), projectId, projectName: projectId ? sanitizeName(names.project(projectId)) || null : null, taskId: t.id };
      return t.status === 'error' ? { failed: [sig] } : { finished: [sig] };
    }
    case 'budget.reached':
      return { budget: [{ key: `b:${ev.projectId}:${ev.period}:${periodStart(ev.period, now)}`, projectId: ev.projectId, projectName: sanitizeName(names.project(ev.projectId)) || null, period: ev.period }] };
    default: return {};
  }
}
