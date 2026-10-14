/**
 * What the desktop tells the owner, decided in one pure place (spec 3.9, 4.6, 5.8): the taskbar number, the desktop notifications, the
 * tray text, quiet hours and the "while you were away" summary. `plan` takes what the core said and what the window is doing, and returns
 * what main should do. Main only performs the Electron calls (`signals.ts`), so every rule here is tested without Electron.
 *
 * Text rule (5.8): a notification carries fixed words, an agent name, a project name and a count. Nothing an agent wrote and no command
 * ever reaches it: the signals below have no field for such text, `askSignal` copies only ids and names, and every name is cleaned and
 * capped before it is shown.
 */
import { isQuietAt, nextQuietBoundary } from '../shared/ask-clock.js';
import type { QuietConfig } from '../shared/ask-clock.js';

/** Asks that arrive within this long of each other in one project are announced as one. */
export const BURST_MS = 1500;
/** Back at the window after this long away (hidden, minimised or in another app): one summary. */
export const AWAY_MS = 30 * 60_000;
const NAME_MAX = 40;
const KNOWN_MAX = 500;

export type NotifyLevel = 'problems' | 'everything' | 'nothing';

/** An open ask, reduced to the fixed fields a notification may use. */
export interface AskSignal {
  /** Stable per ask (`a:<id>`): one ask is announced once. */
  key: string;
  kind: 'approval' | 'question' | 'parked';
  agentName: string;
  projectId: string | null;
  projectName: string | null;
  taskId?: string;
}
/** A run that failed or finished. */
export interface RunSignal { key: string; agentName: string; projectId: string | null; projectName: string | null; taskId: string }
/** A project budget that was just reached. */
export interface BudgetSignal { key: string; projectId: string; projectName: string | null; period: 'day' | 'week' | 'month' }

/** The owner's choices (Settings, Notifications, and each project's level). */
export interface Prefs {
  enabled: boolean;
  returnSummary: boolean;
  quiet?: QuietConfig;
  /** By project id; a project without an entry is at `problems`. */
  levels: Record<string, NotifyLevel>;
}
/** What the window is doing. `pageProjectId` is set while a project page is shown, `threadTaskId` while a thread is. */
export interface FocusInfo { focused: boolean; pageProjectId: string | null; threadTaskId: string | null }

export interface PlanInput {
  /** Open asks, counted by the core (approvals, questions, parked asks and proposals): the number on the taskbar. */
  total: number;
  /** Open approvals, questions and parked asks, as fixed-field signals. A key already announced is never announced again. */
  asks: AskSignal[];
  /** Signals new since the last call. Dedup by key as well, so a repeat is harmless. */
  failed: RunSignal[];
  finished: RunSignal[];
  budget: BudgetSignal[];
  /** This week's spend across projects, for the summaries. */
  spentUsd: number;
  prefs: Prefs;
  focus: FocusInfo;
}

type Item =
  | { cls: 'ask'; s: AskSignal }
  | { cls: 'failed'; s: RunSignal }
  | { cls: 'done'; s: RunSignal }
  | { cls: 'budget'; s: BudgetSignal };

export interface PlanState {
  /** The key of the overlay icon now set (null: none). */
  overlayKey: string | null;
  known: string[];
  burst: Item[];
  burstSince: number | null;
  held: { asks: number; failed: number; budget: number };
  /** Spend when the current quiet window was first seen; null outside quiet hours. */
  quietSpent: number | null;
  unfocusedSince: number | null;
  awaySpent: number;
  awayFailed: number;
}

export interface Notif {
  /** Same tag, same toast: a repeat replaces instead of stacking. */
  tag: string;
  title: string;
  body: string;
  /** What a click opens. Empty: just show the window. */
  target: { projectId?: string; taskId?: string };
}
export interface PlanResult {
  state: PlanState;
  /** Set only when the number changed. `key` null clears the overlay. */
  overlay?: { key: string | null; description: string };
  notifications: Notif[];
  tray: { tooltip: string; hasAsks: boolean };
  /** When main should call `plan` again if nothing else happens first (burst window, quiet end). */
  wakeAt: number | null;
}

export function initialPlanState(): PlanState {
  return { overlayKey: null, known: [], burst: [], burstSince: null, held: { asks: 0, failed: 0, budget: 0 }, quietSpent: null, unfocusedSince: null, awaySpent: 0, awayFailed: 0 };
}

/* ---------- the taskbar number ---------- */

/** The icon for a count: '1' to '9', '9plus' above nine, null at zero. */
export function overlayKey(count: number): string | null {
  const n = Math.floor(count);
  if (!(n >= 1)) return null;
  return n > 9 ? '9plus' : String(n);
}
/** Spoken by a screen reader. */
export function overlayDescription(count: number): string {
  return count === 1 ? '1 thing needs you' : `${count} things need you`;
}
export function trayTooltip(count: number): string {
  return count < 1 ? 'Legion' : `Legion: ${count} ${count === 1 ? 'needs' : 'need'} you`;
}
/** Every file name the overlay can use (the script that draws them, and a test, read this). */
export const OVERLAY_KEYS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '9plus'];

/* ---------- names ---------- */

/** A name that may be shown: no control or direction characters, one line, at most 40 characters. */
export function sanitizeName(s: string | null | undefined): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[\t\n\r\f\v]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
}

export interface AskSource { id: string; taskId: string; agentId: string; projectId?: string }
export interface NameLookup {
  agent(agentId: string): string | undefined;
  project(projectId: string): string | undefined;
  projectOfTask(taskId: string): string | undefined;
}
/**
 * The only way an approval or a question becomes a signal. It copies ids and looks names up; it never reads `summary`, `input`,
 * `questions` or anything else the agent wrote, so none of it can reach a notification.
 */
export function askSignal(kind: AskSignal['kind'], src: AskSource, names: NameLookup): AskSignal {
  const projectId = src.projectId ?? names.projectOfTask(src.taskId) ?? null;
  const projectName = projectId ? sanitizeName(names.project(projectId)) || null : null;
  return { key: `a:${src.id}`, kind, agentName: sanitizeName(names.agent(src.agentId)), projectId, projectName, taskId: src.taskId };
}

/* ---------- the plan ---------- */

const levelOf = (prefs: Prefs, projectId: string | null): NotifyLevel => (projectId ? prefs.levels[projectId] : undefined) ?? 'problems';
const projectOf = (it: Item): string | null => it.s.projectId;

/** Whether the owner is already looking at what this is about. */
function seen(it: Item, f: FocusInfo): boolean {
  if (!f.focused) return false;
  const taskId = it.cls === 'budget' ? undefined : it.s.taskId;
  if (taskId && f.threadTaskId === taskId) return true;
  const p = projectOf(it);
  return !!p && f.pageProjectId === p;
}

function admitted(it: Item, prefs: Prefs): boolean {
  if (!prefs.enabled) return false;
  const level = levelOf(prefs, projectOf(it));
  if (level === 'nothing') return false;
  if (it.cls === 'done') return level === 'everything';
  return true;
}

const who = (name: string): string => sanitizeName(name) || 'An agent';
const inProject = (name: string | null): string | null => (name && sanitizeName(name)) || null;
const target = (projectId: string | null, taskId?: string): Notif['target'] => ({ ...(projectId ? { projectId } : {}), ...(taskId ? { taskId } : {}) });
const money = (usd: number): string => `$${usd.toFixed(2)}`;

function askTitle(kind: AskSignal['kind'], agent: string): string {
  return kind === 'question' ? `${agent} has a question for you` : kind === 'parked' ? `${agent} is waiting for you` : `${agent} needs your OK`;
}
const PERIOD_WAIT: Record<BudgetSignal['period'], string> = { day: 'tomorrow', week: 'Monday', month: 'next month' };

/** One notification per group of items in one project and class; a lone item gets its own wording. */
function announce(items: Item[]): Notif[] {
  const groups = new Map<string, Item[]>();
  for (const it of items) {
    if (it.cls === 'budget') { groups.set(`b|${it.s.key}`, [it]); continue; }
    const k = `${it.cls}|${projectOf(it) ?? ''}`;
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  const out: Notif[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const n = group.length;
    const projectId = projectOf(first);
    const project = inProject(first.s.projectName);
    const tag = `${first.cls}:${group.map((g) => g.s.key).join(',').slice(0, 120)}`;
    if (first.cls === 'budget') {
      out.push({ tag, title: project ? `Budget reached in ${project}` : 'Budget reached', body: `New runs wait until ${PERIOD_WAIT[first.s.period]}.`, target: target(projectId) });
    } else if (first.cls === 'ask') {
      if (n === 1) out.push({ tag, title: askTitle(first.s.kind, who(first.s.agentName)), body: project ? `In ${project}` : 'Open Legion to answer.', target: target(projectId, first.s.taskId) });
      else out.push({ tag, title: project ? `${n} things need you in ${project}` : `${n} things need you`, body: 'Open Legion to answer.', target: target(projectId) });
    } else if (first.cls === 'failed') {
      if (n === 1) out.push({ tag, title: `${who(first.s.agentName)}’s run failed`, body: project ? `In ${project}` : 'Open Legion for details.', target: target(projectId, first.s.taskId) });
      else out.push({ tag, title: project ? `${n} runs failed in ${project}` : `${n} runs failed`, body: 'Open Legion for details.', target: target(projectId) });
    } else {
      if (n === 1) out.push({ tag, title: `${who(first.s.agentName)} finished`, body: project ? `In ${project}` : 'Open Legion to see it.', target: target(projectId, first.s.taskId) });
      else out.push({ tag, title: project ? `${n} runs finished in ${project}` : `${n} runs finished`, body: 'Open Legion to see them.', target: target(projectId) });
    }
  }
  return out;
}

function summary(parts: { need: number; failed: number; budget: number; spent: number }): Notif | null {
  const text: string[] = [];
  if (parts.need > 0) text.push(`${parts.need} ${parts.need === 1 ? 'needs' : 'need'} you`);
  if (parts.failed > 0) text.push(`${parts.failed} failed`);
  if (parts.budget > 0) text.push(parts.budget === 1 ? '1 budget reached' : `${parts.budget} budgets reached`);
  if (parts.spent >= 0.005) text.push(`${money(parts.spent)} spent`);
  if (!text.length) return null;
  return { tag: 'summary', title: `While you were away: ${text.join(', ')}.`, body: 'Open Legion to see more.', target: {} };
}

/** Past the cap the oldest CLOSED keys go first; a key that is still open stays, or its ask would be announced again. */
const trim = (known: string[], open: ReadonlySet<string>): string[] => {
  let extra = known.length - KNOWN_MAX;
  if (extra <= 0) return known;
  return known.filter((k) => (extra > 0 && !open.has(k) ? (extra--, false) : true));
};

/** Asks that are already open when Legion starts or reconnects are known, not news: they get no pop-up (the number still shows). */
export function adoptOpen(state: PlanState, keys: readonly string[]): PlanState {
  const have = new Set(keys);
  return { ...state, known: trim([...state.known.filter((k) => !have.has(k)), ...keys], have) };
}

export function plan(prev: PlanState, inp: PlanInput, now: number): PlanResult {
  const state: PlanState = { ...prev, known: [...prev.known], burst: [...prev.burst], held: { ...prev.held } };
  const count = Math.max(0, Math.floor(Number.isFinite(inp.total) ? inp.total : 0));
  const notifications: Notif[] = [];

  // the number: one change per real change, and 10 or 11 are both "9+"
  const key = overlayKey(count);
  let overlay: PlanResult['overlay'];
  if (key !== state.overlayKey) { state.overlayKey = key; overlay = { key, description: key === null ? '' : overlayDescription(count) }; }

  const quiet = isQuietAt(now, inp.prefs.quiet);
  if (quiet && state.quietSpent === null) state.quietSpent = inp.spentUsd;
  const spentSince = (base: number): number => (inp.spentUsd >= base ? inp.spentUsd - base : inp.spentUsd);

  // away from the window (for the return summary)
  if (!inp.focus.focused && state.unfocusedSince === null) { state.unfocusedSince = now; state.awaySpent = inp.spentUsd; state.awayFailed = 0; }

  // new signals
  const incoming: Item[] = [
    ...inp.asks.map((s): Item => ({ cls: 'ask', s })),
    ...inp.failed.map((s): Item => ({ cls: 'failed', s })),
    ...inp.finished.map((s): Item => ({ cls: 'done', s })),
    ...inp.budget.map((s): Item => ({ cls: 'budget', s })),
  ];
  for (const it of incoming) {
    if (state.known.includes(it.s.key)) continue;
    state.known.push(it.s.key);
    if (it.cls === 'failed' && state.unfocusedSince !== null) state.awayFailed++;
    if (!admitted(it, inp.prefs) || seen(it, inp.focus)) continue;
    if (quiet) hold(state, it);
    else { state.burst.push(it); if (state.burstSince === null) state.burstSince = now; }
  }
  state.known = trim(state.known, new Set(inp.asks.map((a) => a.key)));

  // a burst is announced when its window has passed
  if (state.burst.length && state.burstSince !== null && now - state.burstSince >= BURST_MS) {
    const open = new Set(inp.asks.map((a) => a.key));
    const ready = state.burst.filter((it) => it.cls !== 'ask' || open.has(it.s.key)); // answered inside the window: never announced
    state.burst = []; state.burstSince = null;
    if (quiet) for (const it of ready) hold(state, it);
    else notifications.push(...announce(ready));
  }

  let summarised = false;
  // quiet hours ended: one summary of what happened inside them
  if (!quiet && state.quietSpent !== null) {
    const h = state.held;
    if (inp.prefs.enabled && (h.asks || h.failed || h.budget)) {
      const s = summary({ need: count, failed: h.failed, budget: h.budget, spent: spentSince(state.quietSpent) });
      if (s) { notifications.push(s); summarised = true; }
    }
    state.held = { asks: 0, failed: 0, budget: 0 };
    state.quietSpent = null;
  }

  // back at the window after a long time away: one summary
  if (inp.focus.focused && state.unfocusedSince !== null) {
    const away = now - state.unfocusedSince;
    if (away >= AWAY_MS && inp.prefs.enabled && inp.prefs.returnSummary && !quiet && !summarised) {
      const s = summary({ need: count, failed: state.awayFailed, budget: 0, spent: spentSince(state.awaySpent) });
      if (s) notifications.push(s);
    }
    state.unfocusedSince = null; state.awayFailed = 0;
  }

  const wakes: number[] = [];
  if (state.burstSince !== null && state.burst.length) wakes.push(state.burstSince + BURST_MS);
  if (quiet) { const edge = nextQuietBoundary(now, inp.prefs.quiet); if (edge !== null) wakes.push(edge); }

  return {
    state, ...(overlay ? { overlay } : {}), notifications,
    tray: { tooltip: trayTooltip(count), hasAsks: count > 0 },
    wakeAt: wakes.length ? Math.min(...wakes) : null,
  };
}

/** During quiet hours an item is only counted; the summary at the end reports it. */
function hold(state: PlanState, it: Item): void {
  if (it.cls === 'ask') state.held.asks++;
  else if (it.cls === 'failed') state.held.failed++;
  else if (it.cls === 'budget') state.held.budget++;
}
