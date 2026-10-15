/**
 * The Lattice's Lint tab, Stale section: the pure view model. It turns the stale rows of GET /api/kg/lint into what the list shows
 * (plain-word labels, grouping, order). No React, no fetch; the UI and the tests import this same file.
 */
import type { KgNodeType, KgStaleRow } from './kg.js';
import type { TaskStatus } from './types.js';

export const AUDIT_EMPTY_TEXT = 'Nothing is stale.';

/** "4 months old", "1 year old". Plain words: a day count only while it is small enough to mean something. */
export function ageLabel(days: number): string {
  if (!Number.isFinite(days)) return 'Age unknown';
  if (days < 1) return 'Updated today';
  if (days < 60) return `${days} ${days === 1 ? 'day' : 'days'} old`;
  if (days < 365) return `${Math.min(11, Math.round(days / 30.44))} months old`;
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? 'year' : 'years'} old`;
}

/** Confidence is stored as 0..1; the list shows a word. */
export function confidenceLabel(c: number | undefined): string {
  if (typeof c !== 'number' || !Number.isFinite(c)) return 'Confidence not set';
  if (c < 0.4) return 'Low confidence';
  if (c < 0.7) return 'Medium confidence';
  return 'High confidence';
}

export function sourcesLabel(n: number | undefined): string {
  if (!n || n < 1) return 'No source';
  return `${n} ${n === 1 ? 'source' : 'sources'}`;
}

export interface AuditRow {
  id: string;
  title: string;
  type: KgNodeType | undefined;
  daysOld: number;
  age: string;
  sources: string;
  /** True when the note lists no source at all: the row shows a "No source" tag. */
  noSource: boolean;
  confidence: string;
  /** Built-in (system seed) notes are not the owner's to refresh. */
  builtIn: boolean;
  /** A Refresh button is shown and enabled. */
  canRefresh: boolean;
  /** "Still current" is offered: the owner checked the note and it holds. Never where the core refuses it (built-in, pending). */
  canMarkCurrent: boolean;
  /** Why there is no Refresh, in a few words (a proposal waits, the note needs a review, ...). */
  note: string | undefined;
  /** The Archivist run refreshing this note right now; the row then shows "Refreshing" and "Open the run". */
  refreshTaskId: string | undefined;
  /** The last refresh run of this note ended failed or cancelled; the row says so until the next refresh starts. */
  failedTaskId: string | undefined;
}

export interface AuditView {
  /** The owner's and the agents' notes, oldest first. */
  mine: AuditRow[];
  /** System seed notes, oldest first, in a collapsed group without Refresh. */
  builtIn: AuditRow[];
  /** What the Stale header counts: the rows under it. Built-in notes are counted in their own group. */
  count: number;
  /** True when both groups are empty. */
  empty: boolean;
  emptyText: string;
}

export const BLOCK_NOTES: Record<NonNullable<KgStaleRow['refreshBlock']>, string> = {
  proposal: 'Proposal in your Inbox',
  untrusted: 'Review it before refreshing',
  unreadable: 'Private to another agent',
  pending: 'Waiting in your Inbox',
};

/** The one rule for what a stale row offers, shared by the list and the detail panel and matching what the core accepts. */
export function refreshAvailability(s: Pick<KgStaleRow, 'createdBy' | 'refreshBlock' | 'refreshTaskId'>, archivist: boolean): { canRefresh: boolean; canMarkCurrent: boolean; note: string | undefined } {
  const builtIn = s.createdBy === 'system';
  const blocked = s.refreshBlock ? BLOCK_NOTES[s.refreshBlock] : undefined;
  const live = !!s.refreshTaskId;
  const noArchivist = !builtIn && !blocked && !live && !archivist;
  return {
    canRefresh: !builtIn && !live && !blocked && archivist,
    // touch refuses built-in and pending notes
    canMarkCurrent: !builtIn && s.refreshBlock !== 'pending',
    note: blocked ?? (noArchivist ? 'No Archivist' : undefined),
  };
}

/** The one Refresh button. Refresh and Refreshing are the same element with another label, so keyboard focus stays on it. */
export function refreshButtonFor(r: Pick<AuditRow, 'canRefresh' | 'refreshTaskId'>, busy: boolean): { label: 'Refresh' | 'Refreshing'; inert: boolean } | null {
  if (busy || r.refreshTaskId) return { label: 'Refreshing', inert: true };
  return r.canRefresh ? { label: 'Refresh', inert: false } : null;
}

/** A refresh run that did not finish its job. */
export const isFailedRun = (status: TaskStatus): boolean => status === 'error' || status === 'cancelled';

export function refreshFailureText(title: string): string {
  const t = title.length > 60 ? `${title.slice(0, 59)}…` : title;
  return `Refresh of ${t} failed.`;
}

function toRow(s: KgStaleRow, archivist: boolean, failed: Readonly<Record<string, string>>): AuditRow {
  const a = refreshAvailability(s, archivist);
  return {
    id: s.id, title: s.title || s.id, type: s.type, daysOld: s.daysOld,
    age: ageLabel(s.daysOld), sources: sourcesLabel(s.sourceCount), noSource: !s.sourceCount, confidence: confidenceLabel(s.confidence),
    builtIn: s.createdBy === 'system', ...a, refreshTaskId: s.refreshTaskId, failedTaskId: failed[s.id],
  };
}

const oldestFirst = (a: AuditRow, b: AuditRow): number => b.daysOld - a.daysOld || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

export interface AuditOptions {
  /** The roster has an Archivist. Default true. */
  archivist?: boolean;
  /** Note id -> the run that last failed or was cancelled while refreshing it. */
  failed?: Readonly<Record<string, string>>;
}

export function buildAuditView(stale: readonly KgStaleRow[], opts: AuditOptions = {}): AuditView {
  const rows = stale.map((r) => toRow(r, opts.archivist !== false, opts.failed ?? {}));
  const mine = rows.filter((r) => !r.builtIn).sort(oldestFirst);
  const builtIn = rows.filter((r) => r.builtIn).sort(oldestFirst);
  return { mine, builtIn, count: mine.length, empty: !mine.length && !builtIn.length, emptyText: AUDIT_EMPTY_TEXT };
}

/**
 * A task ended: should the Lint list be read again? Yes when any run ended while a Refresh click waits for its answer or a row shows a
 * live run. The ended task need not be one the list knows: the click or the list read can be a moment behind the run.
 */
export function shouldReloadOnTaskEnd(status: TaskStatus, stale: readonly KgStaleRow[], busyIds: readonly string[]): boolean {
  if (status === 'running' || status === 'queued') return false;
  return busyIds.length > 0 || stale.some((r) => !!r.refreshTaskId);
}
