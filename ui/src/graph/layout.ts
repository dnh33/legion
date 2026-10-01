/** Force-directed layout (no libraries): repulsion, degree-aware springs, gravity and collision. */
import type { KgEdge, KgNode } from '../../../src/shared/kg';

export interface SimNode {
  id: string; node: KgNode; x: number; y: number; vx: number; vy: number;
  r: number; deg: number; fx: number | null; fy: number | null;
}
export interface SimEdge { id: string; s: SimNode; t: SimNode; edge: KgEdge; bend: number }

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

  /** Replace the data set but keep positions of nodes that stay; place newcomers next to a neighbour. */
  setData(nodes: KgNode[], edges: KgEdge[]): void {
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
    let fresh = 0;
    for (const n of nodes) {
      const old = prev.get(n.id);
      if (old) { old.node = n; next.set(n.id, old); continue; }
      let x = 0, y = 0;
      const anchor = (nbr.get(n.id) ?? []).map((id) => prev.get(id) ?? next.get(id)).find(Boolean);
      const a = hash(n.id) * Math.PI * 2;
      if (anchor && had) { const d = 34 + (hash(n.id + 'r') * 22); x = anchor.x + Math.cos(a) * d; y = anchor.y + Math.sin(a) * d; }
      else { const i = fresh++; const rad = 26 * Math.sqrt(i + 1); x = Math.cos(i * 2.39996) * rad; y = Math.sin(i * 2.39996) * rad; }
      next.set(n.id, { id: n.id, node: n, x, y, vx: 0, vy: 0, r: 6, deg: 0, fx: null, fy: null });
    }
    this.byId = next;
    this.nodes = [...next.values()];
    for (const n of this.nodes) n.deg = 0;
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
        this.edges.push({ id: e.id, s, t, edge: e, bend });
      });
    }
    for (const n of this.nodes) n.r = radiusFor(n.deg);
    this.alpha = Math.max(this.alpha, had ? 0.55 : 1);
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
