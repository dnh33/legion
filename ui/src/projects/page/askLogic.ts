/**
 * The digest's ask rows, pure: one model per row, built from the same asks the counts come from. A row says what the agent wants, what it
 * would do (the consequence chip), how long it has waited, and which buttons it offers. Who gets an inline Allow is decided here, once
 * (spec 3.2, 5.4): only a certain effect, never a click-only card, never a card with no Remember.
 */
import type { WorkItem } from '../../../../src/shared/board.js';
import { isQuietAt } from '../../../../src/shared/ask-clock.js';
import type { QuietConfig } from '../../../../src/shared/ask-clock.js';
import { mergeReads } from '../../../../src/shared/attention.js';
import { clickOnly } from '../../../../src/shared/approval-keys.js';
import { AWAY_COPY } from '../../../../src/shared/away-copy.js';
import { classifySafe } from '../../../../src/shared/consequence.js';
import type { Consequence } from '../../../../src/shared/consequence.js';
import type { ApprovalRequest, PendingQuestion } from '../../../../src/shared/types.js';
import { holdMs } from '../hold.js';
import { ageText, clip } from './pageLogic.js';
import type { PageFacts } from './pageLogic.js';

/** The core's wait before an unanswered ask is denied (src/core/approvals.ts default), in minutes. */
export const DEFAULT_WAIT_MIN = 10;

export type RowAct = 'allow' | 'deny' | 'open' | 'allow-all' | 'review' | 'opt' | 'accept' | 'reject' | 'read';
export interface RowButton {
  act: RowAct; label: string; aria: string; strong?: boolean; sepBefore?: boolean;
  /** The answer goes through the hold (it makes something happen). Deny and Reject are sent at once. */
  held: boolean;
  /** For `opt`: the option label to send. */
  option?: string;
}
export interface AskRow {
  key: string; kind: 'command' | 'reads' | 'question' | 'proposal'; ids: string[];
  agentId: string; agentName: string; taskId?: string; boardId?: string;
  level: number; certain: boolean;
  what: string; code?: string; ctx?: string; chip: string; quiet: boolean; wait: string; trust?: string; untrusted: boolean;
  at: string; hold: number; ing: string; buttons: RowButton[];
}
export interface WaitPolicy { mode: 'deny' | 'park'; parkMinutes: number; quiet?: QuietConfig }

export function waitLine(atIso: string, nowMs: number, p: WaitPolicy): string {
  if (p.mode === 'deny' && p.quiet && isQuietAt(nowMs, p.quiet)) return AWAY_COPY.wait.quiet(p.quiet.to);
  const w = Math.max(0, Math.floor((nowMs - Date.parse(atIso)) / 60_000));
  const waited = w < 1 ? 'under 1 min' : `${w} min`;
  return p.mode === 'park' ? `Waiting ${waited}, parks at ${p.parkMinutes} min` : `Waiting ${waited}, denied at ${DEFAULT_WAIT_MIN} min`;
}

const FILE_WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const FILE_READ = new Set(['Read', 'Glob', 'Grep', 'LS']);
export function verbFor(toolName: string): string {
  if (toolName === 'Bash' || toolName === 'PowerShell') return 'wants to run a command';
  if (FILE_WRITE.has(toolName)) return 'wants to change a file';
  if (FILE_READ.has(toolName)) return 'wants to read a file';
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'wants to fetch from the web';
  const last = toolName.startsWith('mcp__') ? toolName.split('__').pop() : toolName;
  return `wants to use ${last}`;
}

const dirName = (dir: string): string => dir.split('/').filter(Boolean).pop() ?? dir;
const ms = (iso: string): number => { const n = Date.parse(iso); return Number.isFinite(n) ? n : 0; };

/** What is spoken after the first A on an irreversible ask. With the hold off there is no hold to promise. */
export const armAnnouncement = (holdMs: number, holdOff: boolean): string =>
  `This cannot be undone once sent. Press A again within 2 seconds to ${holdOff ? 'allow' : `start a ${holdMs / 1000} second hold`}.`;

export function buildAskRows(f: PageFacts, policy: WaitPolicy): AskRow[] {
  const pid = f.project.id;
  const projectOf = (taskId: string, own?: string): string | undefined => own ?? f.tasks.find((t) => t.id === taskId)?.projectId;
  const nameOf = (id: string): string => f.agents.find((a) => a.id === id)?.name ?? (id || 'An agent');
  const taskTitle = (id: string | undefined): string | undefined => (id ? f.tasks.find((t) => t.id === id)?.title : undefined);
  const btn = (b: Omit<RowButton, 'aria'>, who: string, item: string): RowButton => ({ ...b, aria: `${b.label}: ${who} ${item}` });
  const wait = (at: string): string => waitLine(at, f.nowMs, policy);
  const rows: AskRow[] = [];

  const approvals = f.approvals.filter((a) => projectOf(a.taskId, a.projectId) === pid);
  const { groups, singles } = mergeReads(approvals);
  const consequenceOf = (a: ApprovalRequest): Consequence => a.consequence ?? classifySafe({ kind: 'approval', toolName: a.toolName, input: a.input });

  for (const a of singles) {
    const c = consequenceOf(a);
    const who = nameOf(a.agentId);
    const item = clip(taskTitle(a.taskId) ?? a.summary ?? a.toolName, 40);
    const inline = c.certain && !clickOnly(a) && !a.noRemember;
    const buttons: RowButton[] = inline
      ? [btn({ act: 'allow', label: 'Allow', strong: true, held: true }, who, item), btn({ act: 'deny', label: 'Deny', sepBefore: true, held: false }, who, item), btn({ act: 'open', label: 'Open', held: false }, who, item)]
      : [btn({ act: 'open', label: 'Open', strong: true, held: false }, who, item), btn({ act: 'deny', label: 'Deny', held: false }, who, item)];
    rows.push({
      key: a.id, kind: 'command', ids: [a.id], agentId: a.agentId, agentName: who, taskId: a.taskId, level: c.level, certain: c.certain,
      what: verbFor(a.toolName), code: clip(a.summary || a.toolName, 400), chip: c.chip, quiet: c.level <= 1 && c.certain, wait: wait(a.at), untrusted: false,
      at: a.at, hold: holdMs(c), ing: c.ing ?? 'Allowing', buttons,
    });
  }

  for (const g of groups) {
    const who = nameOf(g.agentId);
    const first = approvals.find((a) => a.id === g.ids[0])!;
    const item = `${g.ids.length} file reads`;
    rows.push({
      key: g.ids[0]!, kind: 'reads', ids: g.ids, agentId: g.agentId, agentName: who, taskId: first.taskId, level: 1, certain: true,
      what: `asked ${g.ids.length} times to read files in ${dirName(g.dir)}`, chip: AWAY_COPY.chip.readOnly, quiet: true, wait: wait(g.at), untrusted: false,
      at: g.at, hold: holdMs({ level: 1, certain: true }), ing: 'Allowing',
      buttons: [btn({ act: 'allow-all', label: `Allow all ${g.ids.length}`, strong: true, held: true }, who, item), btn({ act: 'review', label: 'Review', held: false }, who, item)],
    });
  }

  for (const q of f.questions as readonly PendingQuestion[]) {
    if (projectOf(q.taskId, q.projectId) !== pid) continue;
    const who = nameOf(q.agentId);
    const spec = q.questions[0];
    const item = clip(spec?.question ?? taskTitle(q.taskId) ?? 'a question', 40);
    const single = q.questions.length === 1 && spec && !spec.multiSelect && spec.options.length >= 1 && spec.options.length <= 4;
    const opts: RowButton[] = single ? spec!.options.map((o) => btn({ act: 'opt', label: clip(o.label, 28), option: o.label, held: true }, who, `${item}, answer ${o.label}`)) : [];
    rows.push({
      key: q.id, kind: 'question', ids: [q.id], agentId: q.agentId, agentName: who, taskId: q.taskId, level: 0, certain: true,
      what: spec ? `asks: ${clip(spec.question, 110)}` : 'asks you something',
      ...(single ? { ctx: clip(spec!.options.map((o) => o.label).join(' or '), 140) } : {}),
      chip: AWAY_COPY.chip.decides, quiet: true, wait: wait(q.at), untrusted: false, at: q.at, hold: holdMs({ level: 0, certain: true }), ing: 'Sending',
      buttons: [...opts, btn({ act: 'open', label: 'Open', strong: !single, held: false }, who, item)],
    });
  }

  for (const i of (f.board?.inbox ?? []) as readonly WorkItem[]) {
    if (i.projectId !== pid) continue;
    const agentId = i.createdBy.kind === 'agent' ? i.createdBy.id : '';
    const who = nameOf(agentId);
    const item = clip(i.title, 40);
    rows.push({
      key: i.id, kind: 'proposal', ids: [i.id], agentId, agentName: who, boardId: i.id, level: 2, certain: true,
      what: 'proposes a board item', ctx: clip(i.title, 140), chip: AWAY_COPY.chip.proposal, quiet: false, wait: `${ageText(f.nowMs, i.createdAt) === 'now' ? 'just now' : `${ageText(f.nowMs, i.createdAt)} ago`}`, untrusted: true,
      trust: 'Accepting or editing keeps it marked untrusted. Only "Mark as reviewed" clears it.', at: i.createdAt, hold: holdMs({ level: 2, certain: true }), ing: 'Accepting',
      buttons: [btn({ act: 'read', label: 'Read it', strong: true, held: false }, who, item), btn({ act: 'accept', label: 'Accept, keep it marked', held: true }, who, item), btn({ act: 'reject', label: 'Reject', held: false }, who, item)],
    });
  }

  return rows.sort((a, b) => b.level - a.level || ms(a.at) - ms(b.at) || a.key.localeCompare(b.key));
}

/**
 * Which rows are on screen (spec 3.2): the top `cap` asks, or all of them when expanded. While the pointer or keyboard focus is inside
 * the digest (`frozen`) nothing is promoted and a row the owner answered keeps its slot, so nothing moves under the pointer. A row whose
 * ask is gone and was not answered here leaves at once. Never hides an ask: `more` is the exact number of live asks not shown.
 */
export function reconcileShown(o: { prev: readonly string[]; live: readonly string[]; answered: ReadonlySet<string>; cap: number; expanded: boolean; frozen: boolean; pin?: string }): { shown: string[]; more: number } {
  const live = new Set(o.live);
  let shown: string[];
  if (o.frozen && !o.expanded && o.prev.length) shown = o.prev.filter((k) => live.has(k) || o.answered.has(k));
  else {
    shown = o.expanded ? [...o.live] : o.live.slice(0, o.cap);
    for (const k of o.prev) if (o.answered.has(k) && !shown.includes(k)) shown.splice(Math.min(o.prev.indexOf(k), shown.length), 0, k);
  }
  // the row an open-ask landed for is shown even when it is past the cap
  if (o.pin && live.has(o.pin) && !shown.includes(o.pin)) shown = [...shown, o.pin];
  return { shown, more: o.live.filter((k) => !shown.includes(k)).length };
}
