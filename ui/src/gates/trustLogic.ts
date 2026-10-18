// The pure part of folder trust in the window (security finding H1): the exact change a Trust or a Remove sends, the words, and how a long list of held-back
// commands is shortened for a card. No store, no api: tests run it as it is.
//
// The window only ever names a folder path. The core scans the folder itself, works out the fingerprint, and the app's native dialog lists the commands.
import type { GatesChangeRequest } from './gatesAction.js';

export const TRUST_NOTE = "A folder's own Claude Code settings and skills can run commands. They run only in folders you trust, and only while they hold exactly what you saw when you trusted it. Change a hook, helper, variable or skill and Legion asks again. Trusting a folder asks you to confirm in a window.";
export const TRUST_EMPTY_LINE = "No folder is trusted. Agents still read a project's CLAUDE.md and rules as text. Its settings and skills that can run commands are held back.";
export const TRUST_CHANGED_LINE = 'Changed since you trusted it. Legion asks again at the next run.';

/** Trust: only the path. The core and the app's native dialog do the rest. */
export const trustChange = (folder: string): GatesChangeRequest => ({ kind: 'app', patch: { trustFolder: folder } });
/** Remove: no confirmation. */
export const untrustChange = (folder: string): GatesChangeRequest => ({ kind: 'app', patch: { untrustFolder: folder } });

export interface TrustedRow { folder: string; current: boolean; summary: string[]; more: number }

/** One short line for the list: how many items can run, and the first. */
export function trustSummary(row: Pick<TrustedRow, 'summary' | 'more'>): string {
  const n = row.summary.length + row.more;
  if (n === 0) return 'Nothing in it can run now.';
  const first = row.summary[0] ?? '';
  const cut = first.length > 110 ? `${first.slice(0, 109)}…` : first;
  return `${n} ${n === 1 ? 'item' : 'items'} can run. ${cut}`;
}

/** The lines a card shows: the first few, then a count. The whole list is in the native dialog when the owner trusts the folder. */
export function cardLines(lines: readonly string[], more: number, show = 6): { shown: string[]; hidden: number } {
  return { shown: lines.slice(0, show), hidden: Math.max(0, lines.length - show) + more };
}
