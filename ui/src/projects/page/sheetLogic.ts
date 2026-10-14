/**
 * The task sheet and the New task sheet, pure (no React, no store). What the second-run warning says, who "Best fit" picks, what Start
 * needs, what Esc does with a draft, how the sheet sits beside the list, and the card each task status gets. Spec 3.3, 3.4.
 */
import type { Task } from '../../../../src/shared/types.js';
import { asksOf, clip, money, nameOfAgent, pageStatus, projectTasks, queueText, stepOf, stopDetail, taskItem, waitingTaskIds } from './pageLogic.js';
import type { PageFacts } from './pageLogic.js';

/* ---------- New task ---------- */
export interface SecondRun { agentId: string; agentName: string; taskTitle: string }
export type RunChoice = 'run' | 'after';

/** The agent already has a live run in THIS project. A run elsewhere is only the composer's "Also working in" note, never a warning. */
export function secondRun(f: PageFacts, agentId: string): SecondRun | null {
  const live = projectTasks(f).filter((t) => t.agentId === agentId && t.status === 'running').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!live) return null;
  return { agentId, agentName: nameOfAgent(f, agentId), taskTitle: live.title };
}

/** "Best fit": the member with the fewest live runs in this project; ties keep the member order. */
export function bestFit(f: PageFacts): string | undefined {
  let best: string | undefined;
  let fewest = Infinity;
  for (const id of f.project.members) {
    const n = projectTasks(f).filter((t) => t.agentId === id && t.status === 'running').length;
    if (n < fewest) { fewest = n; best = id; }
  }
  return best;
}

export const DEFAULT_TASK_COST = 1.5;
/** The mean cost of this agent's finished tasks, else the default. A task with no usable cost is ignored. */
export function typicalCost(tasks: ReadonlyArray<Pick<Task, 'agentId' | 'status' | 'costUsd'>>, agentId: string): number {
  const xs = tasks.filter((t) => t.agentId === agentId && t.status === 'done' && typeof t.costUsd === 'number' && Number.isFinite(t.costUsd) && t.costUsd >= 0).map((t) => t.costUsd as number);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : DEFAULT_TASK_COST;
}
export const costLine = (usd: number): string => `About ${money(usd)} for a task like this.`;

/** Start needs text, and, when the agent is already working here, an answer to the warning. */
export function canStart(o: { text: string; warning: SecondRun | null; choice: RunChoice | undefined }): { ok: true } | { ok: false; why: 'empty' | 'choose' } {
  if (!o.text.trim()) return { ok: false, why: 'empty' };
  if (o.warning && !o.choice) return { ok: false, why: 'choose' };
  return { ok: true };
}

/** The request body. Queue after it is `startAfter`; it is sent only while the warning stands (nothing left to wait for means just start). */
export function newTaskBody(o: { agentId: string; projectId: string; text: string; warning: SecondRun | null; choice: RunChoice | undefined }): { agentId: string; projectId: string; prompt: string; startAfter?: true } {
  return { agentId: o.agentId, projectId: o.projectId, prompt: o.text.trim(), ...(o.warning && o.choice === 'after' ? { startAfter: true as const } : {}) };
}

/* ---------- the sheet itself ---------- */
export const ESC_NOTE = 'Press Esc again to close. Your draft is kept.';
/** Esc with an unsaved draft says so first and keeps the draft; the second Esc closes. */
export function escStep(o: { dirty: boolean; armed: boolean }): 'close' | 'arm' { return o.dirty && !o.armed ? 'arm' : 'close'; }

export const SHEET_W = 480;
export const LIST_MIN = 520;
/** Push the list aside when 520 px stay free beside the 480 px sheet; otherwise the sheet covers it. */
export const layoutFor = (areaWidth: number): 'push' | 'over' => (Number.isFinite(areaWidth) && areaWidth - SHEET_W >= LIST_MIN ? 'push' : 'over');

/* ---------- the card for one task ---------- */
export type CardKind = 'working' | 'waiting' | 'queued' | 'stopped' | 'failed' | 'review' | 'done' | 'cancelled';
export interface CardAction { act: 'stop' | 'stop-waiting' | 'continue' | 'retry' | 'mark-done'; label: string; itemId?: string }
export interface TaskCard {
  taskId: string; kind: CardKind; title: string; agentId: string; agentName: string;
  headline: string; detail?: string; lastMessage?: string; actions: CardAction[]; costUsd: number; updatedAt: string;
}

const firstLineOf = (s: string): string => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';

/** The card by status (spec 3.3). A task the window no longer knows has no card, so the sheet closes instead of throwing. */
export function taskCard(f: PageFacts, taskId: string): TaskCard | null {
  const t = f.tasks.find((x) => x.id === taskId);
  if (!t) return null;
  const who = nameOfAgent(f, t.agentId);
  const waiting = waitingTaskIds(asksOf(f));
  const st = pageStatus(t, waiting);
  const base = { taskId: t.id, title: t.title, agentId: t.agentId, agentName: who, costUsd: t.costUsd ?? 0, updatedAt: t.updatedAt };
  const review = (f.board?.items ?? []).find((i) => i.status === 'review' && (i.lastRun?.taskId === t.id || i.taskIds.includes(t.id)));
  if (review && t.status === 'done') {
    return { ...base, kind: 'review', headline: `${who} says it is done`, ...(t.result ? { lastMessage: clip(t.result, 1200) } : {}), actions: [{ act: 'mark-done', label: 'Mark done', itemId: review.id }] };
  }
  switch (st) {
    case 'working': {
      const step = stepOf(f.progress?.[t.id]);
      return { ...base, kind: 'working', headline: `${who} is working`, ...(step ? { detail: step } : {}), actions: [{ act: 'stop', label: 'Stop' }] };
    }
    case 'waiting': return { ...base, kind: 'waiting', headline: `${who} is waiting on you`, actions: [] };
    case 'queued': return { ...base, kind: 'queued', headline: queueText(f, t), lastMessage: 'Not started yet. It is waiting in line.', actions: [{ act: 'stop-waiting', label: 'Stop waiting' }] };
    case 'stopped': return { ...base, kind: 'stopped', headline: stopDetail(t), actions: [{ act: 'continue', label: 'Continue' }] };
    case 'failed': {
      const item = taskItem(f, t, 'failed');
      return { ...base, kind: 'failed', headline: item.detail, ...(t.error ? { lastMessage: t.error } : {}), actions: [{ act: 'retry', label: t.resumable ? 'Continue' : 'Retry' }] };
    }
    case 'done': return { ...base, kind: 'done', ...(t.result ? { lastMessage: clip(t.result, 1200) } : {}), headline: t.result ? firstLineOf(t.result) : `${who} finished`, actions: [] };
    default: return { ...base, kind: 'cancelled', headline: 'Stopped by you.', actions: [] };
  }
}
