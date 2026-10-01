/** Store for the Lattice view: own state (useSyncExternalStore), talks to /api/kg through the shared `request`. */
import { useSyncExternalStore } from 'react';
import type { LegionEvent } from '../../../src/shared/types';
import type { KgEdge, KgLintReport, KgNode, KgNodeType, KgSearchHit, KgSource, KgSubgraph } from '../../../src/shared/kg';
import { ApiError, request, subscribe } from '../api';

export const MAX_VIEW_NODES = 400;
const RECENT_KEY = 'legion.lattice.recent';

/** `bsvAvailable` is optional: today's core does not send it, so the UI learns it from the 409 on seeding (see docs/LATTICE-UI-NOTES.md). */
export interface Stats { nodes: number; edges: number; byType: Record<string, number>; byScope: Record<string, number>; bsvAvailable?: boolean }
export interface Detail { node: KgNode; out: KgEdge[]; in: KgEdge[] }
export interface Lite { id: string; title: string; type: KgNodeType; scope: string }
export interface PathResult { found: boolean; nodes: KgNode[]; edges: KgEdge[] }
export interface ImportReport { files: number; created: number; updated: number; unchanged: number; edges: number; stubs: number; skipped: Array<{ path: string; reason: string }> }
export interface ExportReport { dir: string; written: number; removedStale: number }
export type Dialog =
  | null
  | { kind: 'node'; id: string | null }
  | { kind: 'link'; from: string }
  | { kind: 'delete'; id: string }
  | { kind: 'import' }
  | { kind: 'export' };
export type Cam = { n: number; kind: 'fit' | 'focus' | 'fitIds'; ids?: string[] };

export interface NodeDraft {
  id?: string; title: string; type: KgNodeType; body: string; tags: string[]; scope: string;
  sources: KgSource[]; confidence?: number; reviewed?: boolean;
}

export interface GState {
  boot: 'loading' | 'ready' | 'error';
  bootError: string | null;
  offline: boolean;
  stats: Stats | null;
  graph: { nodes: KgNode[]; edges: KgEdge[]; rev: number };
  truncated: boolean;
  evicted: number;
  graphLoading: boolean;
  noSeeds: boolean;
  selectedId: string | null;
  hoverId: string | null;
  detail: Detail | null;
  detailLoading: boolean;
  detailError: string | null;
  known: Map<string, Lite>;
  kv: number;
  q: string; scope: string; type: string; tag: string;
  hits: KgSearchHit[] | null;
  searching: boolean;
  searchError: string | null;
  tab: 'explore' | 'lint';
  path: { from: string | null; to: string | null; picking: null | 'from' | 'to'; result: PathResult | null; loading: boolean; error: string | null; open: boolean };
  lint: KgLintReport | null;
  lintLoading: boolean;
  lintError: string | null;
  bsv: 'maybe' | 'off';
  bsvMsg: string;
  dialog: Dialog;
  notice: { text: string; kind: 'info' | 'error'; n: number } | null;
  cam: Cam;
  frozen: boolean;
}

const emptyPath = (): GState['path'] => ({ from: null, to: null, picking: null, result: null, loading: false, error: null, open: false });

let s: GState = {
  boot: 'loading', bootError: null, offline: false, stats: null,
  graph: { nodes: [], edges: [], rev: 0 }, truncated: false, evicted: 0, graphLoading: false, noSeeds: false,
  selectedId: null, hoverId: null, detail: null, detailLoading: false, detailError: null,
  known: new Map(), kv: 0,
  q: '', scope: '', type: '', tag: '', hits: null, searching: false, searchError: null,
  tab: 'explore', path: emptyPath(), lint: null, lintLoading: false, lintError: null,
  bsv: 'maybe', bsvMsg: '', dialog: null, notice: null, cam: { n: 0, kind: 'fit' }, frozen: false,
};
const listeners = new Set<() => void>();
export const getG = () => s;
function set(p: Partial<GState> | ((x: GState) => Partial<GState>)) {
  s = { ...s, ...(typeof p === 'function' ? p(s) : p) };
  listeners.forEach((l) => l());
}
export function useG<T>(sel: (x: GState) => T): T {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => sel(s));
}

/* ---------- small utils ---------- */
const BSV_OFF = 'BSV mode is off: turn on the BSV Dev Kit toggle before loading the BSV knowledge pack.';
const bsvFrom = (st: Stats): Partial<GState> => (st.bsvAvailable === false ? { bsv: 'off', bsvMsg: BSV_OFF } : st.bsvAvailable === true ? { bsv: 'maybe', bsvMsg: '' } : {});
const enc = encodeURIComponent;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isOffline = (e: unknown) => e instanceof ApiError && e.status === 0;
let noticeTimer: number | undefined;
export function notify(text: string, kind: 'info' | 'error' = 'info') {
  set((x) => ({ notice: { text, kind, n: (x.notice?.n ?? 0) + 1 } }));
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => set({ notice: null }), kind === 'error' ? 7000 : 3600);
}
export const dismissNotice = () => set({ notice: null });

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
function recentIds(): string[] { try { const a = JSON.parse(lsGet(RECENT_KEY) ?? '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch { return []; } }
function pushRecent(id: string) { lsSet(RECENT_KEY, JSON.stringify([id, ...recentIds().filter((x) => x !== id)].slice(0, 12))); }

function learn(n: Pick<KgNode, 'id' | 'title' | 'type' | 'scope'>) {
  s.known.set(n.id, { id: n.id, title: n.title, type: n.type, scope: n.scope });
}
export const titleOf = (id: string): string => s.known.get(id)?.title ?? id;

/* ---------- the view graph (what is on the canvas) ---------- */
const vNodes = new Map<string, KgNode>();
const vEdges = new Map<string, KgEdge>();
const touched = new Map<string, number>();
let clock = 0;
let rev = 0;

function publish(extra: Partial<GState> = {}) {
  for (const [id, e] of vEdges) if (!vNodes.has(e.from) || !vNodes.has(e.to)) vEdges.delete(id);
  set({ graph: { nodes: [...vNodes.values()], edges: [...vEdges.values()], rev: ++rev }, kv: s.kv + 1, ...extra });
}
function protectedIds(extra: string[] = []): Set<string> {
  const p = new Set(extra);
  if (s.selectedId) p.add(s.selectedId);
  s.path.result?.nodes.forEach((n) => p.add(n.id));
  return p;
}
function mergeIntoView(nodes: KgNode[], edges: KgEdge[], protect: string[] = [], extra: Partial<GState> = {}) {
  for (const n of nodes) { vNodes.set(n.id, n); touched.set(n.id, ++clock); learn(n); }
  for (const e of edges) vEdges.set(e.id, e);
  let evicted = 0;
  if (vNodes.size > MAX_VIEW_NODES) {
    const keep = protectedIds([...protect, ...nodes.map((n) => n.id)]);
    const order = [...vNodes.keys()].filter((id) => !keep.has(id)).sort((a, b) => (touched.get(a) ?? 0) - (touched.get(b) ?? 0));
    for (const id of order) { if (vNodes.size <= MAX_VIEW_NODES) break; vNodes.delete(id); evicted++; }
    if (vNodes.size > MAX_VIEW_NODES) { // everything left is protected: trim the newest arrivals instead
      for (const id of [...vNodes.keys()].reverse()) { if (vNodes.size <= MAX_VIEW_NODES) break; if (!protect.includes(id)) { vNodes.delete(id); evicted++; } }
    }
  }
  publish({ evicted: s.evicted + evicted, ...extra });
}
function replaceView(sub: KgSubgraph, cam: Cam['kind'] = 'fit', ids?: string[]) {
  vNodes.clear(); vEdges.clear();
  const nodes = sub.nodes.slice(0, MAX_VIEW_NODES);
  for (const n of nodes) { vNodes.set(n.id, n); touched.set(n.id, ++clock); learn(n); }
  for (const e of sub.edges) vEdges.set(e.id, e);
  publish({ truncated: sub.truncated || sub.nodes.length > MAX_VIEW_NODES, evicted: 0, graphLoading: false, noSeeds: false, cam: { n: s.cam.n + 1, kind: cam, ids } });
}

/* ---------- boot / overview ---------- */
const GENERIC = (
  'index overview start guide note notes idea ideas plan project task list meeting daily weekly review system data code design user team time week day year ' +
  'new use make build test release bug fix issue feature update config setup docs reference lesson decision question source people person company market price ' +
  'cost money health food home garden travel book read write learn research paper video image work life goal habit tool app api server file folder link ' +
  'concept entity summary draft todo done open blocked important'
).split(' ');
const STOPISH = new Set('this that with from have were been they them their there then than will would could should about into also some more most such only over very when what which while where your'.split(' '));

/** Words worth searching next, taken from titles, tags and snippets we have already seen. */
function snowballWords(hits: KgSearchHit[], asked: Set<string>): string[] {
  const freq = new Map<string, number>();
  for (const h of hits) {
    const text = `${h.node.title} ${h.node.tags.join(' ')} ${h.node.snippet}`.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
    for (const w of new Set(text)) if (!asked.has(w) && !STOPISH.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 70).map(([w]) => w);
}

/**
 * There is no "list everything" endpoint, so the overview discovers nodes by searching: a vocabulary of common words first,
 * then words taken from what came back. Good enough to seed a view; a proper listing endpoint would replace it.
 */
async function discover(total: number): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  const seen = new Map<string, KgSearchHit>();
  const asked = new Set<string>();
  let words = GENERIC;
  for (let round = 0; round < 3 && words.length; round++) {
    const fresh: KgSearchHit[] = [];
    await Promise.all(words.map((q) => { asked.add(q); return request<KgSearchHit[]>('GET', `/api/kg/search?q=${enc(q)}&limit=25`).then((hits) => {
      hits.forEach((h, i) => { learn(h.node); found.set(h.node.id, (found.get(h.node.id) ?? 0) + 1 + h.score / 100 - i * 0.001); if (!seen.has(h.node.id)) { seen.set(h.node.id, h); fresh.push(h); } });
    }).catch(() => {}); }));
    if (found.size >= total || found.size >= 900 || !fresh.length) break;
    words = snowballWords(fresh, asked);
  }
  return found;
}

export async function boot() {
  set({ boot: s.stats ? 'ready' : 'loading', bootError: null });
  try {
    const stats = await request<Stats>('GET', '/api/kg/stats');
    set({ stats, ...bsvFrom(stats), offline: false, boot: 'ready', bootError: null });
    if (stats.nodes > 0 && vNodes.size === 0) await loadOverview();
  } catch (e) {
    set({ boot: 'error', bootError: errMsg(e), offline: isOffline(e) });
  }
}

export async function loadOverview(extraSeeds: string[] = []) {
  set({ graphLoading: true });
  try {
    const found = await discover(s.stats?.nodes ?? 0);
    const ranked = [...found.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const pinned = [...new Set([...extraSeeds, ...recentIds()])].filter((id) => found.has(id) || extraSeeds.includes(id));
    const small = ranked.length <= 300;
    // large graph: spread the seeds along the ranking so the first view covers several clusters, not just one
    const spread = (n: number) => Array.from({ length: n }, (_, i) => ranked[Math.floor((i * ranked.length) / n)]!);
    const seeds = [...new Set([...pinned, ...(small ? ranked : spread(36))])].slice(0, small ? 300 : 40);
    if (!seeds.length) { set({ graphLoading: false, noSeeds: true }); return; }
    let sub: KgSubgraph;
    try { sub = await request<KgSubgraph>('GET', `/api/kg/subgraph?seed=${enc(seeds.join(','))}&depth=${small ? 1 : 2}&max=${small ? MAX_VIEW_NODES - 20 : 300}`); }
    catch (e) { if (e instanceof ApiError && e.status === 404) { set({ graphLoading: false, noSeeds: true }); return; } throw e; }
    replaceView(sub);
  } catch (e) {
    set({ graphLoading: false, offline: isOffline(e) });
    notify(`Could not load the graph. ${errMsg(e)}`, 'error');
  }
}

export async function loadAround(seeds: string[], depth = 1) {
  if (!seeds.length) return;
  set({ graphLoading: true });
  try {
    const sub = await request<KgSubgraph>('GET', `/api/kg/subgraph?seed=${enc(seeds.slice(0, 60).join(','))}&depth=${depth}&max=${MAX_VIEW_NODES - 100}`);
    replaceView(sub);
  } catch (e) { set({ graphLoading: false }); notify(`Could not load the subgraph. ${errMsg(e)}`, 'error'); }
}

async function ensureInView(id: string): Promise<boolean> {
  if (vNodes.has(id)) { touched.set(id, ++clock); return true; }
  try {
    const sub = await request<KgSubgraph>('GET', `/api/kg/subgraph?seed=${enc(id)}&depth=1&max=40`);
    mergeIntoView(sub.nodes, sub.edges, [id]);
    return true;
  } catch (e) { notify(`That node could not be loaded. ${errMsg(e)}`, 'error'); return false; }
}

export async function expand(id: string) {
  try {
    set({ graphLoading: true });
    const r = await request<{ start: KgNode; nodes: Array<{ node: KgNode; depth: number }>; edges: KgEdge[]; truncated: boolean }>('GET', `/api/kg/nodes/${enc(id)}/neighbors?depth=1&limit=60`);
    const before = vNodes.size;
    mergeIntoView([r.start, ...r.nodes.map((x) => x.node)], r.edges, [id], { graphLoading: false });
    // pick up edges between the new nodes and the rest of the view
    void linkUp();
    const added = vNodes.size - before;
    notify(added > 0 ? `Added ${added} neighbour${added === 1 ? '' : 's'}${r.truncated ? ' (more exist)' : ''}.` : 'No further neighbours to add.');
  } catch (e) { set({ graphLoading: false }); notify(`Could not expand. ${errMsg(e)}`, 'error'); }
}

function chunkIds(ids: string[], maxChars = 6500): string[][] {
  const out: string[][] = []; let cur: string[] = []; let len = 0;
  for (const id of ids) { if (len + id.length + 1 > maxChars && cur.length) { out.push(cur); cur = []; len = 0; } cur.push(id); len += id.length + 1; }
  if (cur.length) out.push(cur);
  return out;
}
/** Re-read every node on the canvas: fresh content, new links, deleted nodes dropped. */
async function linkUp(dropMissing = false) {
  const ids = [...vNodes.keys()];
  if (!ids.length) return;
  try {
    const parts = await Promise.all(chunkIds(ids).map((c) => request<KgSubgraph>('GET', `/api/kg/subgraph?seed=${enc(c.join(','))}&depth=0&max=500`).catch((e) => { if (e instanceof ApiError && e.status === 404) return { nodes: [], edges: [], truncated: false } as KgSubgraph; throw e; })));
    const seen = new Set<string>();
    for (const p of parts) { for (const n of p.nodes) { vNodes.set(n.id, n); seen.add(n.id); learn(n); } for (const e of p.edges) vEdges.set(e.id, e); }
    if (dropMissing) for (const id of ids) if (!seen.has(id)) vNodes.delete(id);
    publish();
  } catch { /* the view stays as it is */ }
}

/* ---------- selection ---------- */
let detailSeq = 0;
export async function loadDetail(id: string) {
  const my = ++detailSeq;
  set({ detailLoading: true, detailError: null });
  try {
    const [d, nb] = await Promise.all([
      request<{ node: KgNode; edges: { out: KgEdge[]; in: KgEdge[] } }>('GET', `/api/kg/nodes/${enc(id)}`),
      request<{ nodes: Array<{ node: KgNode }> }>('GET', `/api/kg/nodes/${enc(id)}/neighbors?depth=1&limit=200`).catch(() => ({ nodes: [] })),
    ]);
    if (my !== detailSeq) return;
    learn(d.node); nb.nodes.forEach((x) => learn(x.node));
    if (vNodes.has(id)) { vNodes.set(id, d.node); }
    set({ detail: { node: d.node, out: d.edges.out, in: d.edges.in }, detailLoading: false, kv: s.kv + 1 });
  } catch (e) {
    if (my !== detailSeq) return;
    if (e instanceof ApiError && e.status === 404) { set({ selectedId: null, detail: null, detailLoading: false }); notify('That node no longer exists.'); return; }
    set({ detailLoading: false, detailError: errMsg(e), offline: isOffline(e) });
  }
}

export function select(id: string | null) {
  if (id === s.selectedId && id !== null) return;
  set({ selectedId: id, detail: null, detailError: null, detailLoading: !!id });
  if (id) { pushRecent(id); void loadDetail(id); } else { detailSeq++; }
}
/** Jump to a node from anywhere (list, linked nodes, lint): make sure it is on the canvas, select it and centre it. */
export async function focusNode(id: string) {
  if (s.path.picking) { pickPath(id); return; }
  const ok = await ensureInView(id);
  if (!ok) return;
  select(id);
  set((x) => ({ cam: { n: x.cam.n + 1, kind: 'focus', ids: [id] } }));
}
export const setHover = (id: string | null) => { if (s.hoverId !== id) set({ hoverId: id }); };
export const fitView = () => set((x) => ({ cam: { n: x.cam.n + 1, kind: 'fit' } }));
export const toggleFrozen = () => set((x) => ({ frozen: !x.frozen }));
export const setTab = (tab: GState['tab']) => { set({ tab }); if (tab === 'lint') void loadLint(); };

/* ---------- search ---------- */
let searchSeq = 0; let searchTimer: number | undefined;
export function setSearch(p: Partial<Pick<GState, 'q' | 'scope' | 'type' | 'tag'>>) {
  set(p);
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void runSearch(), p.q !== undefined ? 200 : 0);
}
export async function runSearch() {
  const { q, scope, type, tag } = s;
  const my = ++searchSeq;
  if (!q.trim()) { set({ hits: null, searching: false, searchError: null }); return; }
  set({ searching: true, searchError: null });
  try {
    const params = new URLSearchParams({ q: q.trim(), limit: '30' });
    if (scope) params.set('scope', scope);
    if (type) params.set('type', type);
    if (tag.trim()) params.set('tags', tag.trim().replace(/^#/, ''));
    const hits = await request<KgSearchHit[]>('GET', `/api/kg/search?${params}`);
    if (my !== searchSeq) return;
    hits.forEach((h) => learn(h.node));
    set({ hits, searching: false, kv: s.kv + 1, offline: false });
  } catch (e) {
    if (my !== searchSeq) return;
    set({ searching: false, searchError: errMsg(e), hits: [], offline: isOffline(e) });
  }
}
export const showHitsOnGraph = () => { const ids = s.hits?.map((h) => h.node.id) ?? []; void loadAround(ids, 1); };

/* ---------- path finder ---------- */
export function setPathOpen(open: boolean) { set((x) => ({ path: { ...x.path, open, picking: open ? x.path.picking : null } })); }
export function pickPath(id: string) {
  const p = s.path;
  if (!p.picking) return;
  const slot = p.picking;
  const next = { ...p, [slot]: id, picking: slot === 'from' && !p.to ? ('to' as const) : null, result: null, error: null };
  set({ path: next });
  void ensureInView(id);
  if (next.from && next.to && !next.picking) void findPath();
}
export function startPick(slot: 'from' | 'to' | null) { set((x) => ({ path: { ...x.path, picking: slot, open: true } })); }
export function setPathEnd(slot: 'from' | 'to', id: string | null) { set((x) => ({ path: { ...x.path, [slot]: id, result: null, error: null } })); }
export function swapPath() { set((x) => ({ path: { ...x.path, from: x.path.to, to: x.path.from, result: null, error: null } })); }
export function clearPath() { set({ path: { ...emptyPath(), open: s.path.open } }); }
export async function findPath() {
  const { from, to } = s.path;
  if (!from || !to) return;
  set((x) => ({ path: { ...x.path, loading: true, error: null, result: null, picking: null } }));
  try {
    const r = await request<PathResult>('GET', `/api/kg/path?from=${enc(from)}&to=${enc(to)}`);
    if (r.found) {
      mergeIntoView(r.nodes, r.edges, r.nodes.map((n) => n.id));
      select(null); // the path takes over the stage; its steps are listed in the left column
      set((x) => ({ path: { ...x.path, loading: false, result: r }, cam: { n: x.cam.n + 1, kind: 'fitIds', ids: r.nodes.map((n) => n.id) } }));
    } else set((x) => ({ path: { ...x.path, loading: false, result: r } }));
  } catch (e) { set((x) => ({ path: { ...x.path, loading: false, error: errMsg(e) } })); }
}

/* ---------- lint ---------- */
export async function loadLint() {
  set({ lintLoading: true, lintError: null });
  try {
    const lint = await request<KgLintReport>('GET', '/api/kg/lint');
    set({ lint, lintLoading: false, offline: false });
    const need = new Set<string>();
    lint.orphans.forEach((i) => need.add(i)); lint.untrustedWithoutReview.forEach((i) => need.add(i));
    lint.stale.forEach((x) => need.add(x.id)); lint.contradictions.forEach((c) => { need.add(c.a); need.add(c.b); });
    lint.duplicateTitles.forEach((d) => d.ids.forEach((i) => need.add(i)));
    void resolveTitles([...need].slice(0, 150));
  } catch (e) { set({ lintLoading: false, lintError: errMsg(e), offline: isOffline(e) }); }
}
export async function resolveTitles(ids: string[]) {
  const missing = ids.filter((id) => !s.known.has(id));
  for (let i = 0; i < missing.length; i += 8) {
    await Promise.all(missing.slice(i, i + 8).map((id) => request<{ node: KgNode }>('GET', `/api/kg/nodes/${enc(id)}`).then((r) => learn(r.node)).catch(() => {})));
    set({ kv: s.kv + 1 });
  }
}

/* ---------- writes ---------- */
export const openDialog = (d: Dialog) => set({ dialog: d });
export const closeDialog = () => set({ dialog: null });

async function afterWrite() {
  void request<Stats>('GET', '/api/kg/stats').then((st) => set({ stats: st, ...bsvFrom(st) })).catch(() => {});
  await linkUp(true);
  if (s.selectedId) { if (vNodes.has(s.selectedId)) void loadDetail(s.selectedId); else void loadDetail(s.selectedId); }
  if (s.q.trim()) void runSearch();
  if (s.lint || s.tab === 'lint') void loadLint();
}

export async function saveNode(d: NodeDraft): Promise<KgNode> {
  const props = { ...(getG().detail?.node.id === d.id ? getG().detail?.node.props ?? {} : {}) } as Record<string, string | number | boolean>;
  if (d.reviewed) props.reviewed = true; else delete props.reviewed;
  const body: Record<string, unknown> = {
    ...(d.id ? { id: d.id } : {}), title: d.title.trim(), type: d.type, body: d.body, tags: d.tags, scope: d.scope,
    sources: d.sources.filter((x) => x.ref.trim()).map((x) => ({ ref: x.ref.trim(), ...(x.licence?.trim() ? { licence: x.licence.trim() } : {}), ...(x.untrusted ? { untrusted: true } : {}) })),
    props,
  };
  if (d.confidence !== undefined) body.confidence = d.confidence;
  const r = await request<{ node: KgNode; created: boolean }>('POST', '/api/kg/nodes', body);
  learn(r.node);
  set({ boot: 'ready', noSeeds: false });
  mergeIntoView([r.node], [], [r.node.id]);
  if (r.created || !s.selectedId) { select(r.node.id); set((x) => ({ cam: { n: x.cam.n + 1, kind: 'focus', ids: [r.node.id] } })); }
  void afterWrite();
  notify(r.created ? 'Note created.' : 'Note saved.');
  return r.node;
}

export async function deleteNode(id: string) {
  const r = await request<{ ok: boolean; removedEdges: number }>('DELETE', `/api/kg/nodes/${enc(id)}`);
  vNodes.delete(id); touched.delete(id); s.known.delete(id);
  if (s.selectedId === id) { detailSeq++; set({ selectedId: null, detail: null }); }
  if (s.path.from === id || s.path.to === id || s.path.result?.nodes.some((n) => n.id === id)) clearPath();
  publish();
  void afterWrite();
  notify(`Deleted${r.removedEdges ? ` with ${r.removedEdges} link${r.removedEdges === 1 ? '' : 's'}` : ''}.`);
}

export async function addLink(from: string, to: string, rel: string, note: string) {
  const r = await request<{ edge: KgEdge; created: boolean }>('POST', '/api/kg/edges', { from, to, rel: rel.trim(), ...(note.trim() ? { note: note.trim() } : {}) });
  await ensureInView(to); await ensureInView(from);
  vEdges.set(r.edge.id, r.edge);
  publish();
  void afterWrite();
  notify(r.created ? 'Link added.' : 'That link already exists.');
}

export async function deleteEdge(id: string) {
  try {
    await request('DELETE', `/api/kg/edges/${enc(id)}`);
    vEdges.delete(id); publish(); void afterWrite(); notify('Link removed.');
  } catch (e) { notify(`Could not remove the link. ${errMsg(e)}`, 'error'); }
}

/** Edit some fields of a note in place (the detail panel): only what is given is sent, so nothing else is touched. */
export async function patchNode(id: string, fields: { title?: string; type?: KgNodeType; body?: string; tags?: string[] }): Promise<KgNode> {
  const r = await request<{ node: KgNode; created: boolean }>('POST', '/api/kg/nodes', { id, ...fields });
  learn(r.node);
  mergeIntoView([r.node], [], [r.node.id]);
  void afterWrite();
  notify('Note saved.');
  return r.node;
}

/** Change a link's relation or note. Resolves with the stored edge; rejects with the core's message (a 409 when the new relation already exists). */
export async function updateEdge(id: string, fields: { rel?: string; note?: string | null }): Promise<KgEdge> {
  const r = await request<{ edge: KgEdge }>('PATCH', `/api/kg/edges/${enc(id)}`, fields);
  vEdges.set(r.edge.id, r.edge);
  publish();
  void afterWrite();
  notify('Link saved.');
  return r.edge;
}

export async function importVault(dir: string): Promise<ImportReport> {
  const r = await request<ImportReport>('POST', '/api/kg/import', { dir: dir.trim() });
  const st = await request<Stats>('GET', '/api/kg/stats').catch(() => null);
  if (st) set({ stats: st, ...bsvFrom(st), boot: 'ready' });
  if (vNodes.size === 0 || r.created > 0) await loadOverview();
  else void afterWrite();
  return r;
}
export const exportVault = (dir: string) => request<ExportReport>('POST', '/api/kg/export', { dir: dir.trim() });

export async function seedBsv() {
  try {
    await request('POST', '/api/kg/seed/bsv');
    const st = await request<Stats>('GET', '/api/kg/stats').catch(() => null);
    if (st) set({ stats: st, ...bsvFrom(st), boot: 'ready' });
    await loadOverview(['bsv-curriculum-index']);
    notify('BSV knowledge pack loaded.');
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) { set({ bsv: 'off', bsvMsg: e.message }); notify(e.message, 'error'); }
    else notify(`Could not load the BSV pack. ${errMsg(e)}`, 'error');
  }
}

/* ---------- live updates ---------- */
let liveTimer: number | undefined;
let liveUsers = 0;
let unsub: (() => void) | null = null;
/** Re-reads what the view shows (stats, canvas, detail, search, lint). Called on kg.updated and when the Library returns to the Lattice. */
export function refreshFromServer(changed?: string[]) {
  void request<Stats>('GET', '/api/kg/stats').then((st) => {
    const wasEmpty = (s.stats?.nodes ?? 0) === 0;
    set({ stats: st, ...bsvFrom(st), boot: 'ready', noSeeds: false });
    if (st.nodes > 0 && (wasEmpty || vNodes.size === 0)) void loadOverview(changed ?? []);
  }).catch(() => {});
  void linkUp(true);
  if (s.selectedId) void loadDetail(s.selectedId);
  if (s.q.trim()) void runSearch();
  if (s.tab === 'lint') void loadLint();
}
function onEvent(e: LegionEvent) {
  if (e.type !== 'kg.updated') return;
  window.clearTimeout(liveTimer);
  liveTimer = window.setTimeout(() => refreshFromServer(e.changed), 350);
}
/** Mount hook: starts the SSE subscription for `kg.updated` while the view is on screen. */
export function startLive(): () => void {
  if (liveUsers++ === 0) unsub = subscribe(onEvent, () => {});
  return () => { if (--liveUsers === 0) { unsub?.(); unsub = null; window.clearTimeout(liveTimer); } };
}
export const resetOffline = () => set({ offline: false });
