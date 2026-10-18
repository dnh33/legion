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

/** The card's heading says what is true now: held back until you trust the folder, then trusted. */
export function trustHeading(total: number, trusted: number): string {
  if (total > 0 && trusted >= total) return total === 1 ? 'This folder is trusted' : 'These folders are trusted';
  return total === 1 ? "This folder's settings were held back" : "These folders' settings were held back";
}

/** The card was written when a run held a folder back. The folder may have been trusted since: this is what the window can read of that (the trusted list with its "still fits" flag). */
export type CardTrust = 'held' | 'trusted' | 'trusted-differs';

const tidy = (v: string): string => v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
// the list route cuts a line at 300 characters the way the core does; the card keeps the whole line
const sameLine = (card: string, now: string): boolean => {
  const a = tidy(card); const b = tidy(now);
  return a === b || (b.length >= 300 && b.endsWith('…') && a.startsWith(b.slice(0, -1)));
};
const pathKey = (p: string): string => { const q = p.replace(/\\/g, '/').replace(/\/+$/, ''); return /^[A-Za-z]:|^\/\//.test(q) ? q.toLowerCase() : q; };

/**
 * Is the folder this card names trusted now? Held: not on the list, or on it but its commands changed since it was trusted (Trust stays: it trusts what the folder holds now).
 * Trusted: on the list and it still fits what it holds. The card carries no fingerprint, so "the same commands" is read from its lines: when they still match what the
 * folder holds the card says it is trusted; when they do not, the folder is trusted at what it holds now, which the card says too. Trust is never offered for a trusted folder.
 */
export function cardTrust(f: { folder: string; lines: readonly string[]; more: number }, rows: readonly TrustedRow[] | null): CardTrust {
  const row = rows?.find((r) => pathKey(r.folder) === pathKey(f.folder));
  if (!row || !row.current) return 'held';
  const same = row.more === f.more && row.summary.length === f.lines.length && f.lines.every((l, i) => sameLine(l, row.summary[i] ?? ''));
  return same ? 'trusted' : 'trusted-differs';
}

export const TRUSTED_AFTER_LINE = 'Trusted. It applies from the next run.';
export const TRUSTED_CHANGED_AFTER_LINE = 'Trusted with what it holds now. It applies from the next run.';
/** The line above the commands once the folder is trusted (the card's own first sentence ends in "What was held back:" only while it is held back). */
export const TRUSTED_LEAD = 'From the next run these can run:';
export const TRUSTED_CHANGED_LEAD = 'This run held back:';
