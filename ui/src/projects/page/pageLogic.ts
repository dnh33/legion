/**
 * The project page's decisions, pure (no React, no store): every count and line the page shows comes from here, derived from one
 * `PageFacts` object, so the meta line, the tab pip, the digest, the strip, the groups, the units, the rail and the switcher cannot
 * disagree (spec 4.2). Tested in node (test/projects-page.test.ts).
 */
import type { BoardView, WorkItem } from '../../../../src/shared/board.js';
import { AWAY_COPY, queueReasonText } from '../../../../src/shared/away-copy.js';
import { countAsks, deriveAsks, sortAsks } from '../../../../src/shared/attention.js';
import type { Ask } from '../../../../src/shared/attention.js';
import { BUDGET_LIMIT_PREFIX, isBudgetPause, isLimitPause, isParkPause } from '../../../../src/shared/continue.js';
import type { Project } from '../../../../src/shared/projects.js';
import { CHOICE_HELP } from '../../gates/agentFollowLogic.js';
import { HERMES_MODE_CHIP, acpModelLabel, isAgentHostModel } from '../../../../src/shared/acp-copy.js';
import { AGENT_MODE_HELP, AGENT_MODE_LABEL } from '../../gates/presetsLogic.js';
import type { AgentProfile, ApprovalRequest, PendingQuestion, QueueSnapshot, Task, TaskProgress } from '../../../../src/shared/types.js';

export const DAY_MS = 86_400_000;

export interface PageFacts {
  project: Pick<Project, 'id' | 'name' | 'members' | 'status' | 'createdAt'>;
  projects: ReadonlyArray<Pick<Project, 'id' | 'name' | 'status'>>;
  agents: ReadonlyArray<Pick<AgentProfile, 'id' | 'name' | 'description' | 'model' | 'approval' | 'approvalSource'> & { emoji?: string; vm?: { enabled: boolean } }>;
  /** Every task the window knows (any project). */
  tasks: ReadonlyArray<Task>;
  approvals: ReadonlyArray<ApprovalRequest>;
  questions: ReadonlyArray<PendingQuestion>;
  queue: QueueSnapshot | null;
  progress?: Readonly<Record<string, TaskProgress>>;
  board?: Pick<BoardView, 'items' | 'inbox'>;
  nowMs: number;
}

/* ---------- small formatters ---------- */
export const money = (n: number): string => `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** A project's name where space is short (the rail, a unit's "also working in"): the part before a colon or a dash, else clipped. */
export function shortProjectName(name: string): string {
  const first = name.split(/\s*[:\u2013\u2014]\s*|\s+-\s+/)[0]?.trim() ?? '';
  return first ? clip(first, 19) : 'a project';
}
const ms = (iso: string | undefined): number => { const n = Date.parse(iso ?? ''); return Number.isFinite(n) ? n : 0; };

/** "now", "5 min", "3 h", "2 d": how long ago, in the mockup's words. */
export function ageText(nowMs: number, iso: string | undefined): string {
  const mins = Math.floor((nowMs - ms(iso)) / 60_000);
  if (mins < 2) return 'now';
  if (mins < 60) return `${mins} min`;
  if (mins < 2880) return `${Math.round(mins / 60)} h`;
  return `${Math.round(mins / 1440)} d`;
}
export function hhmm(msValue: number, nowMs: number): string {
  const d = new Date(msValue);
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date(nowMs);
  if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) return t;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${t}`;
}

/* ---------- tasks and agents ---------- */
export const projectTasks = (f: PageFacts): Task[] => f.tasks.filter((t) => t.projectId === f.project.id && !t.archived);
const nameOf = (f: PageFacts, id: string): string => f.agents.find((a) => a.id === id)?.name ?? id;
export const nameOfAgent = nameOf;

/** Every ask of this project, riskiest first, then oldest first. */
export function asksOf(f: PageFacts): Ask[] {
  const all = deriveAsks({ approvals: f.approvals, questions: f.questions, proposals: f.board?.inbox ?? [], tasks: f.tasks });
  return sortAsks(all.filter((a) => a.projectId === f.project.id));
}

export type PageStatus = 'working' | 'waiting' | 'queued' | 'stopped' | 'failed' | 'done' | 'cancelled';
/** A running task with an open ask shows as waiting on you, not as working. */
export function pageStatus(t: Task, waiting: ReadonlySet<string>): PageStatus {
  if (t.status === 'queued') return 'queued';
  if (t.status === 'running') return waiting.has(t.id) ? 'waiting' : 'working';
  if (t.status === 'error') return isParkPause(t) ? 'waiting' : isLimitPause(t) ? 'stopped' : 'failed';
  return t.status === 'done' ? 'done' : 'cancelled';
}
export const waitingTaskIds = (asks: readonly Ask[]): Set<string> => new Set(asks.map((a) => a.taskId).filter((x): x is string => !!x));

/** Agents with a working run in this project, most recently active first. */
export function workingAgents(f: PageFacts, asks: readonly Ask[] = asksOf(f)): string[] {
  const waiting = waitingTaskIds(asks);
  const seen = new Map<string, number>();
  for (const t of projectTasks(f)) if (pageStatus(t, waiting) === 'working') seen.set(t.agentId, Math.max(seen.get(t.agentId) ?? 0, ms(t.updatedAt)));
  return [...seen].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Runs of one agent that are running right now, in any project: the number on its bust and in the runs menu. */
export const liveRuns = (agentId: string, tasks: ReadonlyArray<Pick<Task, 'agentId' | 'status'>>): number => tasks.filter((t) => t.agentId === agentId && t.status === 'running').length;
/** Runs of one agent in this project that are running (the strip's "x2"). */
export const hereRuns = (f: PageFacts, agentId: string): number => projectTasks(f).filter((t) => t.agentId === agentId && t.status === 'running').length;

/* ---------- header ---------- */
export function metaParts(f: PageFacts, o: { asks: number; working: number; paused: boolean; weekUsd?: number }): string[] {
  const n = f.project.members.length;
  if (f.project.status === 'archived') return ['Archived', plural(n, 'member'), plural(projectTasks(f).length, 'task')];
  if (n === 0) return ['New project', 'no members yet'];
  const parts = [plural(n, 'member')];
  if (o.working) parts.push(`${o.working} working here`);
  if (o.asks) parts.push(`${o.asks} ${o.asks === 1 ? 'needs' : 'need'} you`);
  if (o.paused) parts.push('new starts paused');
  if (o.weekUsd && o.weekUsd > 0) parts.push(`${money(o.weekUsd)} this week`);
  return parts;
}

export type TabKey = 'overview' | 'board' | 'tasks' | 'rooms' | 'settings';
export interface TabDef { key: TabKey; label: string; pip: boolean; count?: number; pipText?: string }
export function tabDefs(o: { asks: number; board: number; tasks: number; rooms: number }): TabDef[] {
  const c = (n: number): { count?: number } => (n > 0 ? { count: n } : {});
  return [
    { key: 'overview', label: 'Overview', pip: o.asks > 0, ...(o.asks > 0 ? { pipText: `${o.asks} ${o.asks === 1 ? 'needs' : 'need'} you` } : {}) },
    { key: 'board', label: 'Board', pip: false, ...c(o.board) },
    { key: 'tasks', label: 'Tasks', pip: false, ...c(o.tasks) },
    { key: 'rooms', label: 'Rooms', pip: false, ...c(o.rooms) },
    { key: 'settings', label: 'Settings', pip: false },
  ];
}

/** Roving tabindex: the key a tab key press moves to (Arrow, Home, End); undefined for any other key. */
export function nextTab(keys: readonly TabKey[], current: TabKey, pressed: string): TabKey | undefined {
  const i = keys.indexOf(current);
  if (pressed === 'ArrowRight') return keys[(i + 1) % keys.length];
  if (pressed === 'ArrowLeft') return keys[(i - 1 + keys.length) % keys.length];
  if (pressed === 'Home') return keys[0];
  if (pressed === 'End') return keys[keys.length - 1];
  return undefined;
}

/* ---------- since you last looked ---------- */
/** Absent: max(project created, now - 24 h). Never longer than 7 days (spec 4.2). */
export function sinceFor(project: Pick<Project, 'createdAt'>, looked: string | undefined, nowMs: number): number {
  const floor = nowMs - 7 * DAY_MS;
  if (looked && Number.isFinite(Date.parse(looked))) return Math.max(Date.parse(looked), floor);
  return Math.max(ms(project.createdAt), nowMs - DAY_MS, floor);
}

export const foldedLine = (failed: number, stopped: number, finished: number, since: string): string | undefined => {
  const bits: string[] = [];
  if (failed) bits.push(`${failed} failed`);
  if (stopped) bits.push(`${stopped} stopped`);
  if (finished) bits.push(`${finished} finished or in review`);
  return bits.length ? `${bits.join(', ')} since ${since}` : undefined;
};

export function digestHeader(o: { needYou: number; hasNew: boolean; since: string; spendUsd: number }): { kind: 'new'; title: string; need: string; spent: string } | { kind: 'quiet'; text: string } {
  const need = o.needYou ? `${o.needYou} ${o.needYou === 1 ? 'needs' : 'need'} you` : 'Nothing needs you';
  if (o.hasNew) return { kind: 'new', title: `Since ${o.since}`, need, spent: `${money(o.spendUsd)} spent` };
  return { kind: 'quiet', text: `Nothing new since ${o.since}.${o.needYou ? ` ${o.needYou} still ${o.needYou === 1 ? 'waits' : 'wait'} on you.` : ' Nothing waits on you.'}` };
}

/* ---------- state groups ---------- */
export interface GroupItem {
  key: string; taskId?: string; boardId?: string; title: string; agentId: string; agentName: string;
  status: PageStatus | 'review'; detail: string; costUsd?: number; age: string; action?: 'continue' | 'retry';
}
export interface Group { key: 'working' | 'queue' | 'review' | 'stop' | 'done'; heading: string; total: number; cap: number; items: GroupItem[] }

export function stepOf(p: TaskProgress | undefined): string {
  if (!p) return '';
  const now = p.todos?.find((x) => x.status === 'in_progress');
  return now ? clip(now.activeForm || now.content, 80) : `Step ${p.turn}`;
}
const firstLine = (s: string | undefined): string => clip((s ?? '').split(/\r?\n/).find((l) => l.trim())?.trim() ?? '', 90);
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

export function queueText(f: PageFacts, t: Task): string {
  const item = f.queue?.items.find((i) => i.taskId === t.id);
  if (!item) return queueReasonText('slot', { running: f.queue?.running ?? 0, cap: f.queue?.cap ?? 0 });
  return queueReasonText(item.reason, { running: Math.min(f.queue!.running, f.queue!.cap), cap: f.queue!.cap, agentName: nameOf(f, t.agentId) });
}

export function stopDetail(t: Task): string {
  if (isBudgetPause(t)) return 'Stopped at the spend limit. Work kept.';
  return t.turns ? `Stopped after ${plural(t.turns, 'step')}. Work kept.` : 'Stopped at a limit. Work kept.';
}

export function taskItem(f: PageFacts, t: Task, st: PageStatus): GroupItem {
  const detail = st === 'working' ? stepOf(f.progress?.[t.id])
    : st === 'queued' ? queueText(f, t)
    : st === 'stopped' ? stopDetail(t)
    : st === 'failed' ? `Failed: ${lowerFirst(clip(t.error ?? 'the run ended with an error', 110))}`
    : st === 'waiting' ? 'Waiting on you'
    : st === 'done' ? firstLine(t.result) : '';
  return {
    key: `t:${t.id}`, taskId: t.id, title: t.title, agentId: t.agentId, agentName: nameOf(f, t.agentId), status: st, detail,
    ...(st === 'queued' ? { age: '' } : { costUsd: t.costUsd ?? 0, age: ageText(f.nowMs, t.updatedAt) }),
    ...(st === 'stopped' ? { action: 'continue' as const } : st === 'failed' ? { action: 'retry' as const } : {}),
  };
}

const sameLocalDay = (a: number, b: number): boolean => { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); };

export function reviewItems(f: PageFacts): WorkItem[] { return (f.board?.items ?? []).filter((i) => i.status === 'review'); }

/** Working, Waiting for a slot, In review, Stopped, Done today. Caps 5 (Done 3); the rest sits behind "N more". */
export function stateGroups(f: PageFacts, asks: readonly Ask[] = asksOf(f)): Group[] {
  const waiting = waitingTaskIds(asks);
  const tasks = projectTasks(f).slice().sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt));
  const by = (st: PageStatus): GroupItem[] => tasks.filter((t) => pageStatus(t, waiting) === st).map((t) => taskItem(f, t, st));
  const done = tasks.filter((t) => t.status === 'done' && sameLocalDay(ms(t.updatedAt), f.nowMs)).map((t) => taskItem(f, t, 'done'));
  const review: GroupItem[] = reviewItems(f).map((i) => {
    const agentId = i.assignee?.kind === 'agent' ? i.assignee.id : '';
    return { key: `b:${i.id}`, boardId: i.id, ...(i.lastRun ? { taskId: i.lastRun.taskId } : {}), title: i.title, agentId, agentName: agentId ? nameOf(f, agentId) : 'You', status: 'review' as const, detail: i.lastRun?.preview ? firstLine(i.lastRun.preview) : 'Waiting for you to mark it done', age: ageText(f.nowMs, i.updatedAt) };
  });
  const groups: Group[] = [
    { key: 'working', heading: 'Working', total: 0, cap: 5, items: by('working') },
    { key: 'queue', heading: AWAY_COPY.queue.group, total: 0, cap: 5, items: by('queued') },
    { key: 'review', heading: 'In review', total: 0, cap: 5, items: review },
    { key: 'stop', heading: 'Stopped', total: 0, cap: 5, items: [...by('stopped'), ...by('failed')].sort((a, b) => ms(tasks.find((t) => t.id === b.taskId)?.updatedAt) - ms(tasks.find((t) => t.id === a.taskId)?.updatedAt)) },
    { key: 'done', heading: 'Done today', total: 0, cap: 3, items: done },
  ];
  return groups.filter((g) => g.items.length).map((g) => ({ ...g, total: g.items.length }));
}

/* ---------- by agent ---------- */
export type UnitTone = 'warn' | 'live' | 'bad' | '';
export interface UnitLine { icon: 'hand' | 'run' | 'queue' | 'x' | 'pause' | 'review'; tone: UnitTone; text: string; taskId?: string; askId?: string }
export interface Unit {
  agentId: string; name: string; role: string; mode: string; cloud: boolean; model: string;
  lead: UnitLine; rest: UnitLine[]; also?: string; tail: string; runs: number; weekUsd: number;
}
export interface IdleMember { agentId: string; name: string; text: string; weekUsd: number }

/** The legend under the agent chips: the agent editor's words for each setting. */
export const MODE_HELP = (['ask', 'auto-edits', 'full'] as const).map((m) => `${AGENT_MODE_LABEL[m]}: ${AGENT_MODE_HELP[m]}`).join(' ') + ` Follow project: ${CHOICE_HELP.project}`;
/** What an agent's chip says: its own setting, or Follow project. */
const modeText = (a: { approval: 'ask' | 'auto-edits' | 'full'; approvalSource?: 'own' | 'project' }): string => (a.approvalSource === 'project' ? 'Follow project' : AGENT_MODE_LABEL[a.approval]);

const askTitle = (f: PageFacts, a: Ask): string => {
  const t = a.taskId ? f.tasks.find((x) => x.id === a.taskId) : undefined;
  if (t) return t.title;
  if (a.kind === 'proposal') return f.board?.inbox.find((i) => i.id === a.id)?.title ?? 'A board proposal';
  const ap = f.approvals.find((x) => x.id === a.id);
  return ap ? clip(ap.summary || ap.toolName, 60) : 'A question';
};
/** A short form of what an ask is about, for the rail and the unit lead ("publish the package"). */
export const askShort = (f: PageFacts, a: Ask): string => clip(askTitle(f, a), 32);

/** Priority for the lead line: needs you first, then working, queued, failed, stopped, review. */
const PRI: Record<string, number> = { waiting: 0, working: 1, queued: 2, failed: 3, stopped: 4, review: 5 };

export function unitModel(f: PageFacts, o: { weekByAgent?: Readonly<Record<string, number>>; /** Settings, Agent hosts, "Match Legion's mode". Off (the shipped default), an agent that runs on an agent host shows no Legion mode. */ modeMap?: boolean } = {}, asks: readonly Ask[] = asksOf(f)): { units: Unit[]; idle: IdleMember[]; noTasks: string[] } {
  const waiting = waitingTaskIds(asks);
  const tasks = projectTasks(f);
  const units: Array<Unit & { rank: number; at: number }> = [];
  const idle: IdleMember[] = [];
  const noTasks: string[] = [];
  const reviewIds = new Map<string, WorkItem[]>();
  for (const i of reviewItems(f)) if (i.assignee?.kind === 'agent') reviewIds.set(i.assignee.id, [...(reviewIds.get(i.assignee.id) ?? []), i]);
  for (const id of f.project.members) {
    const agent = f.agents.find((a) => a.id === id);
    const name = agent?.name ?? id;
    const mine = asks.filter((a) => a.agentId === id);
    const covered = new Set(mine.map((a) => a.taskId).filter(Boolean));
    const runs = tasks.filter((t) => t.agentId === id && !covered.has(t.id)).map((t) => ({ t, st: pageStatus(t, waiting) }))
      .filter((x) => x.st in PRI).sort((a, b) => PRI[a.st]! - PRI[b.st]! || ms(b.t.updatedAt) - ms(a.t.updatedAt));
    const lines: UnitLine[] = [
      ...mine.map((a): UnitLine => ({ icon: 'hand', tone: 'warn', text: `Needs you: ${askTitle(f, a)}`, askId: a.id, ...(a.taskId ? { taskId: a.taskId } : {}) })),
      ...runs.map(({ t, st }): UnitLine => {
        const it = taskItem(f, t, st);
        switch (st) {
          case 'waiting': return { icon: 'hand', tone: 'warn', text: `Needs you: ${t.title}`, taskId: t.id };
          case 'working': return { icon: 'run', tone: 'live', text: `${t.title}.${it.detail ? ` ${it.detail}` : ''}`, taskId: t.id };
          case 'queued': return { icon: 'queue', tone: '', text: `${t.title}. ${it.detail}`, taskId: t.id };
          case 'failed': return { icon: 'x', tone: 'bad', text: `Failed: ${t.title}. ${clip(t.error ?? '', 90)}`, taskId: t.id };
          default: return { icon: 'pause', tone: 'warn', text: `${stopDetail(t).replace(' Work kept.', '')}: ${t.title}`, taskId: t.id };
        }
      }),
      ...(reviewIds.get(id) ?? []).map((i): UnitLine => ({ icon: 'review', tone: '', text: `In review: ${i.title}`, ...(i.lastRun ? { taskId: i.lastRun.taskId } : {}) })),
    ];
    const weekUsd = o.weekByAgent?.[id] ?? 0;
    const lastWork = Math.max(0, ...tasks.filter((t) => t.agentId === id).map((t) => ms(t.updatedAt)));
    if (!lines.length) {
      if (lastWork) idle.push({ agentId: id, name, text: `Idle. Last worked ${ageText(f.nowMs, new Date(lastWork).toISOString())} ago.`, weekUsd });
      else noTasks.push(name);
      continue;
    }
    const away = f.tasks.filter((t) => t.agentId === id && t.projectId !== f.project.id && t.status === 'running' && f.projects.some((p) => p.id === t.projectId && p.status === 'active'));
    const revN = reviewIds.get(id)?.length ?? 0;
    const doneN = tasks.filter((t) => t.agentId === id && t.status === 'done' && sameLocalDay(ms(t.updatedAt), f.nowMs)).length;
    const tail = [revN ? `${revN} in review` : '', doneN ? `${doneN} done today` : ''].filter(Boolean).join(' / ');
    const firstAway = away[0];
    const rank = mine.length ? 0 : PRI[runs[0]?.st ?? 'review'] ?? 6;
    units.push({
      agentId: id, name, role: agent?.description ?? '', mode: agent ? (isAgentHostModel(agent.model) && o.modeMap !== true ? HERMES_MODE_CHIP : modeText(agent)) : '', cloud: !!agent?.vm?.enabled, model: acpModelLabel(agent?.model) ?? String(agent?.model ?? ''),
      lead: lines[0]!, rest: lines.slice(1),
      ...(firstAway ? { also: `Also working in ${shortProjectName(f.projects.find((p) => p.id === firstAway.projectId)?.name ?? 'another project')}: ${firstAway.title}${away.length > 1 ? ` (+${away.length - 1})` : ''}` } : {}),
      tail, runs: liveRuns(id, f.tasks), weekUsd, rank, at: lastWork,
    });
  }
  units.sort((a, b) => a.rank - b.rank || b.at - a.at || a.name.localeCompare(b.name));
  return { units: units.map(({ rank: _r, at: _a, ...u }) => u), idle: idle.sort((a, b) => a.name.localeCompare(b.name)), noTasks };
}

/* ---------- runs menu (spec 3.7) ---------- */
export interface RunRow { taskId: string; projectId: string | undefined; projectName: string; title: string; detail: string; costUsd: number; current: boolean; canStop: boolean; needsYou: boolean }
export function runsMenu(f: PageFacts, agentId: string): { header: string; groups: Array<{ projectName: string; rows: RunRow[] }> } {
  const waiting = waitingTaskIds(deriveAsks({ approvals: f.approvals, questions: f.questions, tasks: f.tasks }));
  const live = f.tasks.filter((t) => t.agentId === agentId && t.status === 'running');
  const rows: RunRow[] = live.map((t) => ({
    taskId: t.id, projectId: t.projectId, projectName: t.projectId ? f.projects.find((p) => p.id === t.projectId)?.name ?? 'A removed project' : 'No project',
    title: t.title, detail: waiting.has(t.id) ? 'Needs you' : stepOf(f.progress?.[t.id]) || 'Working', costUsd: t.costUsd ?? 0,
    current: t.projectId === f.project.id, canStop: !waiting.has(t.id), needsYou: waiting.has(t.id),
  }));
  const order = [...new Set(rows.map((r) => r.projectId))].sort((a, b) => Number(b === f.project.id) - Number(a === f.project.id));
  const cap = f.queue?.cap;
  const slots = cap ? ` ${Math.min(f.queue!.running, cap)} of ${cap} slots in use.` : '';
  return {
    header: `${nameOf(f, agentId)}: ${plural(live.length, 'live run')}.${slots}`,
    groups: order.map((p) => ({ projectName: rows.find((r) => r.projectId === p)!.projectName, rows: rows.filter((r) => r.projectId === p) })),
  };
}

/* ---------- budget and side column ---------- */
export interface BudgetVerdict { limited: boolean; reached: boolean; overridden: boolean; spent: number; limit?: number; period?: 'day' | 'week' | 'month'; periodEnd?: number }
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** `shortTitle` is the one-line form for a narrow page (the period is left out). */
/** `stopOff`: the project's "Stop at the budget" gate is off, so nothing waits at the budget and the banner must not say it does. */
export function budgetBanner(b: BudgetVerdict | undefined, stopOff = false): { title: string; text: string; shortTitle: string } | undefined {
  if (!b || !b.limited || !b.reached || !b.period || b.limit === undefined) return undefined;
  const noun = b.period === 'day' ? 'today' : b.period === 'week' ? 'this week' : 'this month';
  const until = b.periodEnd ? (b.period === 'day' ? 'tomorrow' : b.period === 'week' ? WEEKDAY[new Date(b.periodEnd).getDay()]! : `the 1st`) : 'the next period';
  return { title: `Budget reached: ${money(b.spent)} ${noun}.`, text: stopOff ? 'Runs still start, because Stop at the budget is off for this project.' : `New runs wait until ${until}.`, shortTitle: `Budget reached: ${money(b.spent)}.` };
}
export function spendBlock(weekUsd: number, b: BudgetVerdict | undefined, stopOff = false): { big: string; of?: string; pct: number; hi: boolean; foot: string } {
  if (b?.limited && b.limit) {
    const pct = Math.min(100, Math.round((b.spent / b.limit) * 100));
    return { big: money(b.spent), of: `of ${money(b.limit)}`, pct, hi: pct > 80, foot: b.reached ? '' : stopOff ? `${pct}%. Runs do not wait at ${money(b.limit)}, because Stop at the budget is off.` : `${pct}%. New runs wait at ${money(b.limit)}, you get one notification.` };
  }
  return { big: money(weekUsd), pct: 0, hi: false, foot: 'No budget set. Optional.' };
}

/* ---------- rail and switcher ---------- */
export interface RailLine { text: string; full: string; tone: 'attn' | 'work' | ''; runs: number }
/**
 * The member row's one sub-line, one priority (spec 3.5, Option A): this project's asks, then work here (with where else), then work in
 * another project, then the role. `projectId` null is "All projects": the asks of any project count.
 */
/** The asks of one agent (in one project, or any under null), riskiest first. The rail's sub-line and its click read the same list. */
export function agentAsks(f: Pick<PageFacts, 'tasks' | 'approvals' | 'questions' | 'board'>, agentId: string, projectId: string | null): Ask[] {
  return sortAsks(deriveAsks({ approvals: f.approvals, questions: f.questions, tasks: f.tasks, proposals: f.board?.inbox ?? [] }).filter((a) => a.agentId === agentId && (projectId === null || a.projectId === projectId)));
}
export function railLine(f: Pick<PageFacts, 'tasks' | 'projects' | 'agents' | 'approvals' | 'questions' | 'board'> & { project?: PageFacts['project'] }, agentId: string, projectId: string | null, role: string): RailLine {
  const runs = liveRuns(agentId, f.tasks);
  const mine = agentAsks(f, agentId, projectId);
  const facts = { ...f, nowMs: 0, queue: null } as unknown as PageFacts;
  const short = (t: Pick<Task, 'title'>): string => clip(t.title, 28);
  const projName = (id: string | undefined): string => (id ? shortProjectName(f.projects.find((p) => p.id === id)?.name ?? 'a removed project') : 'no project');
  if (mine.length) {
    const first = `Needs you: ${askShort(facts, mine[0]!)}`;
    const text = mine.length === 1 ? first : `${mine.length} things need you`;
    return { text, full: mine.length === 1 ? first : `${text}: ${mine.map((a) => askShort(facts, a)).join(', ')}`, tone: 'attn', runs };
  }
  const running = f.tasks.filter((t) => t.agentId === agentId && t.status === 'running');
  const here = projectId === null ? running : running.filter((t) => t.projectId === projectId);
  const away = projectId === null ? [] : running.filter((t) => t.projectId !== projectId && f.projects.some((p) => p.id === t.projectId && p.status === 'active'));
  if (here[0]) {
    const text = away[0] ? `${short(here[0])} · also ${projName(away[0].projectId)}` : `Working: ${short(here[0])}`;
    return { text, full: `Working: ${here[0].title}${away[0] ? `. Also working in ${projName(away[0].projectId)}: ${away[0].title}` : ''}`, tone: 'work', runs };
  }
  if (away[0]) { const text = `In ${projName(away[0].projectId)}: ${short(away[0])}`; return { text, full: text, tone: 'work', runs }; }
  return { text: role, full: role, tone: '', runs };
}

export interface MenuRow { id: string | null; label: string; needYou: number; current: boolean; archived: boolean }
/** The project menu's rows: All projects, active projects, archived ones, each with the asks waiting in it; and the count elsewhere. */
export function projectMenu(projects: ReadonlyArray<Pick<Project, 'id' | 'name' | 'status'>>, asks: readonly Ask[], current: string | null): { rows: MenuRow[]; elsewhere: number } {
  const counts = countAsks(asks).byProject;
  const sorted = [...projects].sort((a, b) => Number(a.status !== 'active') - Number(b.status !== 'active') || a.name.localeCompare(b.name));
  const total = countAsks(asks).total;
  const rows: MenuRow[] = [
    { id: null, label: 'All projects', needYou: total, current: current === null, archived: false },
    ...sorted.map((p) => ({ id: p.id, label: p.status === 'archived' ? `${p.name} (archived)` : p.name, needYou: counts[p.id] ?? 0, current: current === p.id, archived: p.status === 'archived' })),
  ];
  const elsewhere = current === null ? 0 : total - (counts[current] ?? 0);
  return { rows, elsewhere };
}
