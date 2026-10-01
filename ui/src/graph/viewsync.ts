/**
 * Pure logic behind the Lattice store's refresh and overview loading (no React, no fetch): what counts as a change, which ids make a
 * kg.updated event worth a re-read, how a re-read is split into requests, and how its answer is merged into the view. Kept free of
 * imports (types only) so node tests can run it directly.
 */
import type { KgEdge, KgNode, KgSearchHit, KgSubgraph } from '../../../src/shared/kg.js';

/** True when a re-read node is the same as the one on the canvas (nothing a view can show has changed). */
export function sameNode(a: KgNode, b: KgNode): boolean {
  if (a === b) return true;
  if (a.rev !== b.rev || a.updatedAt !== b.updatedAt || a.title !== b.title || a.type !== b.type || a.scope !== b.scope) return false;
  if (a.status !== b.status || a.supersededBy !== b.supersededBy || a.trust !== b.trust || a.confidence !== b.confidence) return false;
  if (a.body !== b.body || a.tags.length !== b.tags.length || a.tags.some((t, i) => t !== b.tags[i])) return false;
  const sa = a.sources, sb = b.sources;
  if ((sa?.length ?? 0) !== (sb?.length ?? 0) || sa?.some((s, i) => s.ref !== sb![i]!.ref || s.untrusted !== sb![i]!.untrusted)) return false;
  const pa = a.props, pb = b.props;
  if (pa !== pb) {
    const ka = Object.keys(pa ?? {}), kb = Object.keys(pb ?? {});
    if (ka.length !== kb.length || ka.some((k) => pa![k] !== pb?.[k])) return false;
  }
  return true;
}

export function sameEdge(a: KgEdge, b: KgEdge): boolean {
  return a === b || (a.from === b.from && a.to === b.to && a.rel === b.rel && a.note === b.note && a.weight === b.weight);
}

export function chunkIds(ids: string[], maxChars = 6500): string[][] {
  const out: string[][] = []; let cur: string[] = []; let len = 0;
  for (const id of ids) { if (len + id.length + 1 > maxChars && cur.length) { out.push(cur); cur = []; len = 0; } cur.push(id); len += id.length + 1; }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * The seed lists to request (depth 0: a response holds only the links between ITS OWN seeds) so that together they cover every pair of
 * view nodes. One list while the ids fit one URL; above that the ids are cut into half-size chunks and every PAIR of chunks is asked
 * for, so a link between two nodes that sit in different chunks is found too (it used to be missed above about 300 nodes).
 */
export function seedGroups(ids: string[], oneUrl = 6500): string[][] {
  if (chunkIds(ids, oneUrl).length <= 1) return ids.length ? [ids] : [];
  const chunks = chunkIds(ids, Math.floor(oneUrl / 2) - 100);
  const out: string[][] = [];
  for (let i = 0; i < chunks.length; i++) for (let j = i + 1; j < chunks.length; j++) out.push([...chunks[i]!, ...chunks[j]!]);
  return out;
}

export interface ViewMaps { nodes: Map<string, KgNode>; edges: Map<string, KgEdge> }
export interface RefreshResult {
  /** Something on the canvas differs now (a node or link changed, was added or was dropped). */
  changed: boolean;
  /** The set of nodes or links changed (added or removed), not just their content. */
  topology: boolean;
  seen: Set<string>;
}

/**
 * Merges a re-read of `ids` into the view. Nodes and links whose content is the same keep their object (so nothing downstream sees a
 * change). With `dropMissing`, nodes the server no longer has are removed, and so are view links that are gone server-side: a link
 * is dropped only when BOTH its ends were re-read in this answer and no response contained it (and no response was cut short). With
 * `edgesAtStart` only links that were already on the canvas when the request was sent can be dropped: one merged in meanwhile is newer
 * than the answer.
 */
export function reconcileView(v: ViewMaps, ids: string[], parts: KgSubgraph[], dropMissing: boolean, learn?: (n: KgNode) => void, edgesAtStart?: ReadonlySet<string>): RefreshResult {
  let changed = false, topology = false;
  const seen = new Set<string>();
  const returned = new Set<string>();
  for (const p of parts) {
    for (const n of p.nodes) {
      seen.add(n.id);
      const o = v.nodes.get(n.id);
      if (!o) { v.nodes.set(n.id, n); changed = topology = true; learn?.(n); continue; }
      if (!sameNode(o, n)) { v.nodes.set(n.id, n); changed = true; learn?.(n); }
    }
    for (const e of p.edges) {
      returned.add(e.id);
      const o = v.edges.get(e.id);
      if (!o) { v.edges.set(e.id, e); changed = topology = true; continue; }
      if (!sameEdge(o, e)) { v.edges.set(e.id, e); changed = true; }
    }
  }
  if (dropMissing) {
    for (const id of ids) if (!seen.has(id) && v.nodes.delete(id)) changed = topology = true;
    if (!parts.some((p) => p.truncated)) {
      for (const [id, e] of v.edges) {
        if (!returned.has(id) && seen.has(e.from) && seen.has(e.to) && (!edgesAtStart || edgesAtStart.has(id))) { v.edges.delete(id); changed = topology = true; }
      }
    }
  }
  // links whose end left the canvas
  for (const [id, e] of v.edges) if (!v.nodes.has(e.from) || !v.nodes.has(e.to)) { v.edges.delete(id); changed = topology = true; }
  return { changed, topology, seen };
}

/**
 * Whether a kg.updated event needs the canvas re-read: no `changed` list (a manual refresh) always does; otherwise only when one of the
 * ids is a node or link on the canvas.
 */
export function touchesView(changed: string[] | undefined, v: ViewMaps): boolean {
  return !changed?.length || changed.some((id) => v.nodes.has(id) || v.edges.has(id));
}

/** Whether the open note (and the notes it shows as neighbours, whose titles are in its link list) need re-reading. */
export function touchesDetail(changed: string[] | undefined, related: Iterable<string>): boolean {
  if (!changed?.length) return true;
  const set = new Set(related);
  return changed.some((id) => set.has(id));
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep the item order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]!, i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * The overview call returns the most connected nodes first. The canvas lays nodes out from the order they arrive in, so put the ones the
 * user asked for (seeds, recently opened) first, as the discovery path did, then everything else in the order the core ranked it.
 */
export function orderOverview(sub: KgSubgraph, pinned: readonly string[]): KgSubgraph {
  const byId = new Map(sub.nodes.map((n) => [n.id, n]));
  const first: KgNode[] = [];
  const used = new Set<string>();
  for (const id of pinned) { const n = byId.get(id); if (n && !used.has(id)) { used.add(id); first.push(n); } }
  if (!first.length) return sub;
  return { ...sub, nodes: [...first, ...sub.nodes.filter((n) => !used.has(n.id))] };
}

/** True when two search answers would render the same list (so a re-run after an unrelated write changes nothing). */
export function sameHits(a: KgSearchHit[] | null, b: KgSearchHit[]): boolean {
  return !!a && a.length === b.length && a.every((h, i) => {
    const o = b[i]!;
    return h.node.id === o.node.id && h.score === o.score && h.node.updatedAt === o.node.updatedAt && h.node.title === o.node.title && h.node.snippet === o.node.snippet;
  });
}
