/**
 * Library (inbox and Activity) helpers that hold real logic, kept free of React and the DOM so node tests can run
 * them: the before/after diff of an edit proposal, the bulk-accept plan (which rows an untrusted source holds back),
 * and why an Undo is unavailable.
 */
import type { KgActivityRow, KgInboxRow } from './kg.js';

export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }
export interface DiffSkip { kind: 'skip'; count: number }

/** Beyond this many lines per side the diff is not worth computing: show the old text removed and the new text added. */
export const DIFF_MAX_LINES = 400;

/** Line diff by longest common subsequence. Order of the output follows the new text; deletions come before additions of the same hunk. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.replace(/\r\n/g, '\n').split('\n');
  const b = after === '' ? [] : after.replace(/\r\n/g, '\n').split('\n');
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  }
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: 'del', text: a[i++]! });
    else out.push({ kind: 'add', text: b[j++]! });
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'add', text: b[j++]! });
  return out;
}

export const diffChanged = (d: readonly DiffLine[]): boolean => d.some((l) => l.kind !== 'same');
export const diffStats = (d: readonly DiffLine[]): { added: number; removed: number } => ({
  added: d.filter((l) => l.kind === 'add').length, removed: d.filter((l) => l.kind === 'del').length,
});

/** Keeps `context` unchanged lines around each change and folds the rest into one `skip` marker. */
export function collapseDiff(d: readonly DiffLine[], context = 2): Array<DiffLine | DiffSkip> {
  const keep = new Array<boolean>(d.length).fill(false);
  d.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(d.length - 1, i + context); k++) keep[k] = true;
  });
  const out: Array<DiffLine | DiffSkip> = [];
  let run = 0;
  d.forEach((l, i) => {
    if (keep[i]) { if (run) { out.push({ kind: 'skip', count: run }); run = 0; } out.push(l); } else run++;
  });
  if (run) out.push({ kind: 'skip', count: run });
  return out;
}

export interface BulkPlan {
  /** Selected rows that will be accepted. */
  accept: string[];
  /** Selected rows held back, with the reason shown to the owner. */
  skip: Array<{ id: string; reason: string }>;
  /** How many of the selected rows have an untrusted source (they are what the "include untrusted" tick is about). */
  untrusted: number;
}

/** What bulk accept will do with a selection. The core makes the same call (acceptMany); this is the preview. */
export function planBulk(rows: readonly Pick<KgInboxRow, 'id' | 'untrusted'>[], selected: Iterable<string>, includeUntrusted: boolean): BulkPlan {
  const want = new Set(selected);
  const plan: BulkPlan = { accept: [], skip: [], untrusted: 0 };
  for (const r of rows) {
    if (!want.has(r.id)) continue;
    if (r.untrusted) plan.untrusted++;
    if (r.untrusted && !includeUntrusted) plan.skip.push({ id: r.id, reason: 'untrusted source: accept it on its own, or tick "include untrusted"' });
    else plan.accept.push(r.id);
  }
  return plan;
}

/** One sentence for the result of a bulk accept. */
export function bulkSummary(r: { accepted: readonly string[]; skipped: ReadonlyArray<{ id: string; reason: string }> }): string {
  const n = r.accepted.length;
  const acc = n === 0 ? 'Nothing was accepted' : `Accepted ${n} note${n === 1 ? '' : 's'}`;
  if (!r.skipped.length) return `${acc}.`;
  const untrusted = r.skipped.filter((s) => /^untrusted source/.test(s.reason)).length;
  const other = r.skipped.length - untrusted;
  const parts = [];
  if (untrusted) parts.push(`${untrusted} held back for an untrusted source`);
  if (other) parts.push(`${other} skipped for another reason`);
  return `${acc}. ${parts.join(', ')}.`;
}

export type UndoState = { can: true } | { can: false; reason: string };

/** Whether the Undo button works, and if not, why (shown next to the disabled button, not only in a tooltip). */
export function undoState(row: Pick<KgActivityRow, 'undoable' | 'undone' | 'blocked'>): UndoState {
  if (row.undone) return { can: false, reason: 'Already undone.' };
  if (row.blocked === 'changed') return { can: false, reason: 'Changed since this write. Undo the later change first.' };
  if (row.blocked === 'expired') return { can: false, reason: 'Older than 7 days.' };
  if (row.blocked === 'too_large') return { can: false, reason: 'Too large to keep undo data for.' };
  if (!row.undoable) return { can: false, reason: 'No longer undoable.' };
  return { can: true };
}

const KIND_LABEL: Record<string, string> = {
  create: 'created', update: 'edited', proposal: 'proposed', forget: 'forgot', link: 'linked', unlink: 'unlinked',
  supersede: 'superseded', capture: 'captured', wm: 'wrote working memory', merge: 'merged', episode: 'recorded an episode',
};
export const activityVerb = (kind: string): string => KIND_LABEL[kind] ?? kind;

export const inboxKindLabel = (k: KgInboxRow['kind']): string =>
  k === 'edit' ? 'Edit of a human note' : k === 'supersede' ? 'Replace a note' : k === 'merge' ? 'Merge notes' : 'New note';

/** Agents that have pending rows, with counts, most first (feeds the "filter by bot" menu). */
export function agentCounts(rows: readonly Pick<KgInboxRow, 'agentId'>[]): Array<{ agentId: string; count: number }> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.agentId, (m.get(r.agentId) ?? 0) + 1);
  return [...m.entries()].map(([agentId, count]) => ({ agentId, count })).sort((a, b) => b.count - a.count || a.agentId.localeCompare(b.agentId));
}

/** First `n` characters of a body on word boundaries, one paragraph, for the inbox preview. */
export function previewText(body: string, n = 220): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= n) return flat;
  const cut = flat.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

export interface EditDraft { title: string; body: string; tags: string[] }

/**
 * What an "edit then accept" really changes. The core treats any edit as the human rewriting the note (trust becomes
 * 'human', taint cleared), so only fields that differ may be sent: a draft nobody touched must go as a plain accept.
 * Returns undefined when nothing changed.
 */
export function editDelta(node: { title: string; body: string; tags: readonly string[] }, draft: EditDraft): { title?: string; body?: string; tags?: string[] } | undefined {
  const out: { title?: string; body?: string; tags?: string[] } = {};
  if (draft.title.trim() !== node.title) out.title = draft.title.trim();
  if (draft.body !== node.body) out.body = draft.body;
  const tags = [...new Set(draft.tags.map((t) => t.trim().replace(/^#/, '')).filter(Boolean))];
  if (JSON.stringify(tags) !== JSON.stringify(node.tags)) out.tags = tags;
  return Object.keys(out).length ? out : undefined;
}

/** "a, #b  c" -> ['a','b','c'] for the tag inputs. */
export const parseTags = (text: string): string[] => [...new Set(text.split(/[,\s]+/).map((t) => t.trim().replace(/^#/, '')).filter(Boolean))];

/** Node ids look like n_8f3a9c12b0e4. Proposals and links carry them in their title: swap each known one for the note's title. */
export const NODE_ID_IN_TEXT = /\bn_[0-9a-f]{6,}\b/g;
export const idsIn = (text: string): string[] => [...new Set(text.match(NODE_ID_IN_TEXT) ?? [])];
export function humanizeIds(text: string, titleOf: (id: string) => string | undefined): string {
  return text.replace(NODE_ID_IN_TEXT, (id) => { const t = titleOf(id); return t && t !== id ? `“${t}”` : id; });
}
