/** Force-directed layout (no libraries): repulsion, degree-aware springs, gravity and collision. */
import type { KgEdge, KgNode } from '../../../src/shared/kg.js';

export interface SimNode {
  id: string; node: KgNode; x: number; y: number; vx: number; vy: number;
  r: number; deg: number; fx: number | null; fy: number | null;
}
export interface SimEdge { id: string; s: SimNode; t: SimNode; edge: KgEdge; bend: number; /** indices of the ends in Sim.nodes */ si: number; ti: number }

const REPEL = 2800;
const REPEL_MAX2 = 340 * 340;
const GRAVITY = 0.0075;
const DECAY = 0.58;
export const ALPHA_MIN = 0.012;

export const radiusFor = (deg: number): number => Math.min(15, 6 + Math.sqrt(deg) * 2.1);

export class Sim {
  nodes: SimNode[] = [];
  edges: SimEdge[] = [];
  byId = new Map<string, SimNode>();
  alpha = 0;

  /** Edge signature of the last setData (order independent): equal ids give an equal signature. */
  sig = '';

  /**
   * Seeds the positions of the nodes of a previous Lattice mount (see `savePositions`) so that a re-open does not start from the
   * phyllotaxis seed. Only when at least 90% of `nodes` are known; returns whether it did. Call before the first setData.
   */
  restore(cache: PosCache | null, nodes: KgNode[]): boolean {
    if (!cache || this.byId.size > 0 || !nodes.length) return false;
    let known = 0;
    for (const n of nodes) if (cache.pos.has(n.id)) known++;
    if (known < nodes.length * 0.9) return false;
    for (const n of nodes) {
      const p = cache.pos.get(n.id);
      if (p) this.byId.set(n.id, { id: n.id, node: n, x: p[0], y: p[1], vx: 0, vy: 0, r: 6, deg: 0, fx: null, fy: null });
    }
    return true;
  }

  /**
   * Replace the data set but keep positions of nodes that stay; place newcomers next to a neighbour. The layout is re-heated only when
   * its shape changed (a node or link added or removed): a re-read of the same graph, or a changed title or body, leaves it at rest.
   * `restoredSig` (after `restore`) says which links the seeded positions were laid out for. Returns whether the shape changed.
   */
  setData(nodes: KgNode[], edges: KgEdge[], restoredSig?: string): boolean {
    const prev = this.byId;
    const had = prev.size > 0;
    const ids = new Set(nodes.map((n) => n.id));
    const liveEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
    const nbr = new Map<string, string[]>();
    for (const e of liveEdges) {
      (nbr.get(e.from) ?? nbr.set(e.from, []).get(e.from)!).push(e.to);
      (nbr.get(e.to) ?? nbr.set(e.to, []).get(e.to)!).push(e.from);
    }
    const next = new Map<string, SimNode>();
    const prevEdgeIds = restoredSig === undefined ? new Set(this.edges.map((e) => e.id)) : null;
    let topo = !had || prev.size !== nodes.length;
    let fresh = 0;
    for (const n of nodes) {
      const old = prev.get(n.id);
      if (old) { old.node = n; next.set(n.id, old); continue; }
      topo = true;
      let x = 0, y = 0;
      const anchor = (nbr.get(n.id) ?? []).map((id) => prev.get(id) ?? next.get(id)).find(Boolean);
      const a = hash(n.id) * Math.PI * 2;
      if (anchor && had) { const d = 34 + (hash(n.id + 'r') * 22); x = anchor.x + Math.cos(a) * d; y = anchor.y + Math.sin(a) * d; }
      else { const i = fresh++; const rad = 26 * Math.sqrt(i + 1); x = Math.cos(i * 2.39996) * rad; y = Math.sin(i * 2.39996) * rad; }
      next.set(n.id, { id: n.id, node: n, x, y, vx: 0, vy: 0, r: 6, deg: 0, fx: null, fy: null });
    }
    this.byId = next;
    this.nodes = [...next.values()];
    const index = new Map<string, number>();
    this.nodes.forEach((n, i) => { n.deg = 0; index.set(n.id, i); });
    // parallel / antiparallel edges between the same pair get fanned out
    const groups = new Map<string, KgEdge[]>();
    for (const e of liveEdges) {
      const k = e.from < e.to ? `${e.from}\u0000${e.to}` : `${e.to}\u0000${e.from}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
    }
    this.edges = [];
    for (const g of groups.values()) {
      g.forEach((e, i) => {
        const s = next.get(e.from)!, t = next.get(e.to)!;
        s.deg++; t.deg++;
        const bend = g.length === 1 ? 0 : (i - (g.length - 1) / 2) * 0.42 * (e.from < e.to ? 1 : -1);
        if (prevEdgeIds && !prevEdgeIds.has(e.id)) topo = true;
        this.edges.push({ id: e.id, s, t, edge: e, bend, si: index.get(e.from)!, ti: index.get(e.to)! });
      });
    }
    for (const n of this.nodes) n.r = radiusFor(n.deg);
    this.sig = edgeSig(this.edges);
    if (prevEdgeIds ? this.edges.length !== prevEdgeIds.size : this.sig !== restoredSig) topo = true;
    if (topo) this.alpha = Math.max(this.alpha, had ? 0.55 : 1);
    return topo;
  }

  tick(): void {
    const ns = this.nodes, n = ns.length;
    const a = this.alpha;
    // dense graphs need more elbow room or they collapse into one disc
    const crowd = 1 + Math.min(n, 400) / 110;
    const rep = REPEL * crowd, cut2 = REPEL_MAX2 * crowd;
    for (let i = 0; i < n; i++) {
      const p = ns[i]!;
      for (let j = i + 1; j < n; j++) {
        const q = ns[j]!;
        let dx = q.x - p.x, dy = q.y - p.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > cut2) continue;
        if (d2 < 1) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); d2 = dx * dx + dy * dy + 0.01; }
        const d = Math.sqrt(d2);
        const f = (rep * a) / (d2 + 400);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        p.vx -= fx; p.vy -= fy; q.vx += fx; q.vy += fy;
        const min = p.r + q.r + 10;
        if (d < min) { const push = ((min - d) / d) * 0.5; p.vx -= dx * push * 0.5; p.vy -= dy * push * 0.5; q.vx += dx * push * 0.5; q.vy += dy * push * 0.5; }
      }
    }
    for (const e of this.edges) {
      const { s, t } = e;
      let dx = t.x - s.x, dy = t.y - s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const len = 78 + s.r + t.r;
      const k = (0.34 / Math.sqrt(Math.min(s.deg, t.deg) || 1)) * a * 1.4;
      const f = (d - len) * k;
      dx = (dx / d) * f; dy = (dy / d) * f;
      s.vx += dx; s.vy += dy; t.vx -= dx; t.vy -= dy;
    }
    for (const p of ns) {
      p.vx -= p.x * GRAVITY * (0.4 + a); p.vy -= p.y * GRAVITY * (0.4 + a);
      if (p.fx !== null) { p.x = p.fx; p.vx = 0; } else { p.vx *= DECAY; p.x += p.vx; }
      if (p.fy !== null) { p.y = p.fy; p.vy = 0; } else { p.vy *= DECAY; p.y += p.vy; }
    }
    this.alpha *= 0.986;
  }

  /** Run synchronously (used for the first layout and for reduced motion). */
  settle(maxTicks = 320): void {
    for (let i = 0; i < maxTicks && this.alpha > ALPHA_MIN; i++) this.tick();
  }

  bounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (!this.nodes.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) { minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r); minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r); }
    return { minX, minY, maxX, maxY };
  }
}

/** Stable pseudo-random in [0,1) from a string. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/** Order independent fingerprint of a set of edges (ids only). */
export function edgeSig(edges: ReadonlyArray<{ id: string }>): string {
  let h = 0;
  for (const e of edges) h = (h + Math.imul(hash32(e.id), 2654435761)) >>> 0;
  return `${edges.length}:${h.toString(36)}`;
}
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Node positions of the last Lattice, kept for the life of the page (module level) so that closing and re-opening the tab does not
 * run the layout again: Chat to Library to Chat used to start from scratch and freeze the UI for 100+ ms every time.
 */
export interface PosCache { pos: Map<string, [number, number]>; sig: string; settled: boolean }
let posCache: PosCache | null = null;
export const loadPositions = (): PosCache | null => posCache;
export function savePositions(sim: Sim): void {
  if (!sim.nodes.length) return;
  posCache = { pos: new Map(sim.nodes.map((n) => [n.id, [n.x, n.y] as [number, number]])), sig: sim.sig, settled: sim.alpha <= ALPHA_MIN };
}
export const clearPositions = (): void => { posCache = null; };
