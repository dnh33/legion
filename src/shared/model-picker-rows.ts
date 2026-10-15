/**
 * The rows of the model picker, built from what is visible. Pure, with no UI imports, so the Node tests can read it.
 *
 * Three rules shape it. A query filters every row, Auto included, and the highlight goes to the first real match, so Enter picks
 * what was typed. The Older models head is not a row of the scrolling list: it is pinned under it, so it is never below the fold.
 * A head carries its count (every model, or the matches under a query) and its open state; no section label repeats a head's name.
 */

export interface PickerModel { value: string; displayName: string; description?: string }
export interface PickerGroup { id: string; label: string; providerId: string; models: string[] }

export interface PickerInput {
  query: string;
  /** The value the agent uses now; its row gets the check mark and opens its group. */
  selected: string;
  autoDescription: string;
  current: PickerModel[];
  older: PickerModel[];
  /** Creator groups of the switched-on providers (providerCreatorGroups). Model ids are the provider's own ids. */
  groups: PickerGroup[];
  /** `<provider>:<model>` values the owner has configured: a group holding one opens by default. */
  configured: string[];
  /** The owner's own open state for Older models and for each creator group (keyed by head id). */
  olderOpen: boolean;
  groupOpen: Record<string, boolean>;
}

export interface PickerItem { kind: 'item'; id: string; value: string; displayName: string; description?: string }
export interface PickerHead { kind: 'head'; id: string; label: string; count: number; open: boolean }
export interface PickerLabel { kind: 'label'; text: string }
export type PickerRow = PickerItem | PickerHead | PickerLabel;

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

export function buildPickerLayout(input: PickerInput): PickerLayout {
  const ql = input.query.trim().toLowerCase();
  const hit = (...xs: string[]) => !ql || xs.some((x) => x.toLowerCase().includes(ql));
  const rows: PickerRow[] = [];

  if (hit('Auto', 'auto')) rows.push({ kind: 'item', id: 'auto', value: 'auto', displayName: 'Auto', description: input.autoDescription });

  const currentHits = input.current.filter((m) => hit(m.displayName, m.value));
  if (currentHits.length) {
    rows.push({ kind: 'label', text: 'Current models' });
    for (const m of currentHits) rows.push({ kind: 'item', id: m.value, value: m.value, displayName: m.displayName, description: m.description });
  }

  let older: PickerLayout['older'];
  const olderHits = input.older.filter((m) => hit(m.displayName, m.value));
  if (olderHits.length) {
    // Under a query the head opens by itself and counts the matches; otherwise it counts every older model and follows the owner's state.
    const open = ql ? true : input.olderOpen;
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
    const open = ql ? true : (input.groupOpen[hid] ?? holdsChosen);
    rows.push({ kind: 'head', id: hid, label: g.label, count: ql ? models.length : g.models.length, open });
    if (open) for (const m of models) rows.push({ kind: 'item', id: `${g.providerId}:${m}`, value: `${g.providerId}:${m}`, displayName: m });
  }

  const nav: Array<PickerItem | PickerHead> = [];
  for (const r of rows) if (r.kind !== 'label') nav.push(r);
  if (older) {
    nav.push(older.head);
    nav.push(...older.rows);
  }
  return { rows, ...(older ? { older } : {}), nav };
}

/**
 * Where the highlight sits in `nav`. A query always starts on the first item (the first real match). Without a query the
 * highlight stays on the row the owner moved to, if it is still listed; otherwise it starts on the selected model, else on Auto.
 * -1 when nothing is listed.
 */
export function resolveHighlight(nav: Array<PickerItem | PickerHead>, hlId: string | undefined, query: string, selected: string): number {
  if (!nav.length) return -1;
  if (query.trim()) return Math.max(0, nav.findIndex((n) => n.kind === 'item'));
  const moved = hlId === undefined ? -1 : nav.findIndex((n) => n.id === hlId);
  if (moved >= 0) return moved;
  const sel = nav.findIndex((n) => n.kind === 'item' && n.value === selected);
  if (sel >= 0) return sel;
  return 0;
}
