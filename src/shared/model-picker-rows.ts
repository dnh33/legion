/**
 * The rows of the model picker, built from what is visible. Pure, with no UI imports, so the Node tests can read it.
 *
 * Three rules shape it. A query filters every row, Auto included, and the highlight starts on the first real match, so Enter picks
 * what was typed; after that the arrow keys and hover move it as usual. The Older models head is not a row of the scrolling list:
 * it is pinned under it, so it is never below the fold. A head carries its count (every model, or the matches under a query) and
 * its open state; a head toggles the same way with or without a query. No section label repeats a head's name.
 */

import { HERMES_GROUP, HERMES_ITEM_NOTE, HERMES_NOTE } from './acp-copy.js';

export interface PickerModel { value: string; displayName: string; description?: string; /** The model id the alias resolves to (claude-opus-5-5); a query matches it too. */ resolvedModel?: string }
export interface PickerGroup { id: string; label: string; providerId: string; models: string[] }

export interface PickerInput {
  query: string;
  /** The value the agent uses now; its row gets the check mark and opens its group. */
  selected: string;
  autoDescription: string;
  current: PickerModel[];
  older: PickerModel[];
  /** Agent hosts the catalog lists (Hermes when it is found and on). Their own group, never a provider group. */
  hosts?: Array<{ value: string; label: string; entryId: string }>;
  /** Creator groups of the switched-on providers (providerCreatorGroups). Model ids are the provider's own ids. */
  groups: PickerGroup[];
  /** `<provider>:<model>` values the owner has configured: a group holding one opens by default. */
  configured: string[];
  /** The owner's own open state for Older models and for each creator group (keyed by head id). */
  olderOpen: boolean;
  groupOpen: Record<string, boolean>;
  /** Open state set by the owner while a query is typed (keyed by head id). Heads start open under a query. */
  queryOpen?: Record<string, boolean>;
}

/** `title` is the full model id, for a tooltip, when the row's label is shorter than the id (a creator group drops its vendor). */
export interface PickerItem { kind: 'item'; id: string; value: string; displayName: string; description?: string; title?: string }
export interface PickerHead { kind: 'head'; id: string; label: string; count: number; open: boolean }
export interface PickerLabel { kind: 'label'; text: string }
/** Words under a label, not a stop for the keys. */
export interface PickerNote { kind: 'note'; text: string }
export type PickerRow = PickerItem | PickerHead | PickerLabel | PickerNote;

export interface PickerLayout {
  /** The scrolling list: Auto, the Current models label and rows, then the creator groups. */
  rows: PickerRow[];
  /** The pinned Older models head, and its rows when open (they scroll in their own panel, under the head). */
  older?: { head: PickerHead; rows: PickerItem[] };
  /** Keyboard order: list rows, then the Older head, then its rows. Only items and heads are reachable. */
  nav: Array<PickerItem | PickerHead>;
}

const OLDER_HEAD = 'older';
const groupHeadId = (g: PickerGroup) => `group-${g.id}`;
/** A creator group's head names the vendor, so its rows drop the `vendor/` prefix: the text before the first slash. */
const withoutVendor = (modelId: string) => { const i = modelId.indexOf('/'); return i >= 0 ? modelId.slice(i + 1) : modelId; };

export function buildPickerLayout(input: PickerInput): PickerLayout {
  const ql = input.query.trim().toLowerCase();
  const hit = (...xs: Array<string | undefined>) => !ql || xs.some((x) => x !== undefined && x.toLowerCase().includes(ql));
  const rows: PickerRow[] = [];

  if (hit('Auto', 'auto')) rows.push({ kind: 'item', id: 'auto', value: 'auto', displayName: 'Auto', description: input.autoDescription });

  const currentHits = input.current.filter((m) => hit(m.displayName, m.value, m.resolvedModel));
  if (currentHits.length) {
    rows.push({ kind: 'label', text: 'Current models' });
    for (const m of currentHits) rows.push({ kind: 'item', id: m.value, value: m.value, displayName: m.displayName, description: m.description });
  }

  // Hermes: its own group with the honest note. Built only from what the catalog lists as found and on; the model list of Hermes is never used.
  for (const h of input.hosts ?? []) {
    if (!hit(h.label, h.value, HERMES_GROUP)) continue;
    rows.push({ kind: 'label', text: h.label }, { kind: 'note', text: HERMES_NOTE });
    rows.push({ kind: 'item', id: h.value, value: h.value, displayName: h.label, description: HERMES_ITEM_NOTE });
  }

  let older: PickerLayout['older'];
  const olderHits = input.older.filter((m) => hit(m.displayName, m.value, m.resolvedModel));
  if (olderHits.length) {
    // Under a query the head opens by itself and counts the matches; otherwise it counts every older model and follows the owner's state.
    const open = ql ? (input.queryOpen?.[OLDER_HEAD] ?? true) : input.olderOpen;
    const head: PickerHead = { kind: 'head', id: OLDER_HEAD, label: 'Older models', count: ql ? olderHits.length : input.older.length, open };
    older = {
      head,
      rows: open ? olderHits.map((m): PickerItem => ({ kind: 'item', id: m.value, value: m.value, displayName: m.displayName, description: m.description })) : [],
    };
  }

  for (const g of input.groups) {
    const groupHit = hit(g.label);
    const models = g.models.filter((m) => groupHit || hit(m));
    if (!models.length) continue;
    const hid = groupHeadId(g);
    const holdsChosen = g.models.some((m) => input.configured.includes(`${g.providerId}:${m}`) || `${g.providerId}:${m}` === input.selected);
    const open = ql ? (input.queryOpen?.[hid] ?? true) : (input.groupOpen[hid] ?? holdsChosen);
    rows.push({ kind: 'head', id: hid, label: g.label, count: ql ? models.length : g.models.length, open });
    if (open) for (const m of models) rows.push({ kind: 'item', id: `${g.providerId}:${m}`, value: `${g.providerId}:${m}`, displayName: withoutVendor(m), title: m });
  }

  const nav: Array<PickerItem | PickerHead> = [];
  for (const r of rows) if (r.kind !== 'label' && r.kind !== 'note') nav.push(r);
  if (older) {
    nav.push(older.head);
    nav.push(...older.rows);
  }
  return { rows, ...(older ? { older } : {}), nav };
}

/** Two search texts are the same query when they match after trimming: a Space typed after a word changes nothing. */
export const sameQuery = (a: string, b: string): boolean => a.trim() === b.trim();

/**
 * Where the highlight sits in `nav`. The row the owner moved to (an arrow key or a hover) stays highlighted while it is still
 * listed. Otherwise a query starts on the first item (the first real match), and no query starts on the selected model,
 * else on Auto. -1 when nothing is listed.
 */
export function resolveHighlight(nav: Array<PickerItem | PickerHead>, hlId: string | undefined, query: string, selected: string): number {
  if (!nav.length) return -1;
  const moved = hlId === undefined ? -1 : nav.findIndex((n) => n.id === hlId);
  if (moved >= 0) return moved;
  if (query.trim()) return Math.max(0, nav.findIndex((n) => n.kind === 'item'));
  const sel = nav.findIndex((n) => n.kind === 'item' && n.value === selected);
  if (sel >= 0) return sel;
  return 0;
}

/** The id the highlight moves to by `d` rows (wrapping), from wherever resolveHighlight puts it now. undefined when nothing is listed. */
export function nextHighlightId(nav: Array<PickerItem | PickerHead>, hlId: string | undefined, query: string, selected: string, d: 1 | -1): string | undefined {
  if (!nav.length) return undefined;
  const at = resolveHighlight(nav, hlId, query, selected);
  return nav[(at + d + nav.length) % nav.length]!.id;
}
