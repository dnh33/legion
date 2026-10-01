/** Canvas renderer + interaction for the Lattice. Framework-free: the React wrapper only feeds it data and options. */
import type { KgEdge, KgNode } from '../../../src/shared/kg';
import { ALPHA_MIN, Sim, type SimEdge, type SimNode } from './layout';
import { REL_TINT, scopeKind, typeColor } from './palette';

export interface EngineOptions {
  theme: 'dark' | 'light';
  selectedId: string | null;
  hoverId: string | null;
  pathNodes: Set<string>;
  pathEdges: Set<string>;
  pathActive: boolean;
  hitIds: Set<string>;
  match: ((n: KgNode) => boolean) | null;
  pickMode: boolean;
  frozen: boolean;
  insetLeft: number;
  insetRight: number;
  insetTop: number;
  insetBottom: number;
  /** creator id -> one glyph for the badge */
  badges: Record<string, string>;
}
export interface EngineEvents {
  onSelect(id: string | null): void;
  onExpand(id: string): void;
  onHover(id: string | null): void;
  onPick(id: string): void;
}
interface Colors {
  bg: string; surface: string; surface3: string; line: string; lineStrong: string; text: string; text2: string; muted: string;
  accent: string; warn: string; danger: string; font: string; mono: string;
}
interface Geom { x1: number; y1: number; cx: number; cy: number; x2: number; y2: number; curved: boolean; ux: number; uy: number; mx: number; my: number }

const MIN_K = 0.08, MAX_K = 4;

export class GraphEngine {
  readonly sim = new Sim();
  private ctx: CanvasRenderingContext2D;
  private W = 0; private H = 0; private dpr = 1;
  private cam = { x: 0, y: 0, k: 1 };
  private camTo: { x: number; y: number; k: number } | null = null;
  private colors!: Colors;
  private opts: EngineOptions;
  private raf = 0;
  private hidden = typeof document !== 'undefined' && document.hidden;
  private reduced = false;
  private destroyed = false;
  private userMoved = false;
  /** Ids to re-frame once the layout settles (a path that was fitted while nodes were still moving). */
  private refit: string[] | null = null;
  private refitTick = 0;
  private adj = new Map<string, Set<string>>();
  private hoverNode: SimNode | null = null;
  private hoverEdge: SimEdge | null = null;
  private drag: null | { kind: 'node' | 'pan'; node?: SimNode; sx: number; sy: number; lx: number; ly: number; moved: boolean; pid: number; dx: number; dy: number } = null;
  private widthCache = new Map<string, number>();
  private geomCache = new Map<string, Geom>();
  /** exposed for diagnostics */
  perf = { drawMs: 0, tickMs: 0, frames: 0 };
  /** ms spent in edges / nodes / labels / edge labels during the last draw (diagnostics) */
  sections: number[] = [];
  private cleanup: Array<() => void> = [];

  constructor(private canvas: HTMLCanvasElement, private ev: EngineEvents, opts: EngineOptions) {
    this.ctx = canvas.getContext('2d')!;
    this.opts = opts;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reduced = mq.matches;
    const onMq = () => { this.reduced = mq.matches; };
    mq.addEventListener('change', onMq);
    this.cleanup.push(() => mq.removeEventListener('change', onMq));
    const onVis = () => { this.hidden = document.hidden; if (!this.hidden) this.invalidate(); else if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; } };
    document.addEventListener('visibilitychange', onVis);
    this.cleanup.push(() => document.removeEventListener('visibilitychange', onVis));

    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      canvas.addEventListener(type, fn as EventListener, o);
      this.cleanup.push(() => canvas.removeEventListener(type, fn as EventListener));
    };
    on('pointerdown', this.onDown);
    on('pointermove', this.onMove);
    on('pointerup', this.onUp);
    on('pointercancel', this.onUp);
    on('pointerleave', () => { if (!this.drag) this.setHover(null, null); });
    on('dblclick', this.onDbl);
    on('wheel', this.onWheel, { passive: false });
    document.fonts?.ready.then(() => { this.widthCache.clear(); this.invalidate(); }).catch(() => {});
    this.readColors();
    this.resize();
  }

  destroy() {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.cleanup.forEach((f) => f());
  }

  /* ---------- data & options ---------- */
  setData(nodes: KgNode[], edges: KgEdge[]) {
    const first = this.sim.byId.size === 0;
    this.sim.setData(nodes, edges);
    this.adj.clear();
    for (const e of this.sim.edges) {
      (this.adj.get(e.s.id) ?? this.adj.set(e.s.id, new Set()).get(e.s.id)!).add(e.t.id);
      (this.adj.get(e.t.id) ?? this.adj.set(e.t.id, new Set()).get(e.t.id)!).add(e.s.id);
    }
    if (this.hoverNode && !this.sim.byId.has(this.hoverNode.id)) this.hoverNode = null;
    this.hoverEdge = null;
    if (first) { this.userMoved = false; this.sim.settle(this.reduced ? 500 : 230); this.fit(false); }
    else if (this.reduced) this.sim.settle(400);
    this.invalidate();
  }

  setOptions(o: Partial<EngineOptions>) {
    const themeChanged = o.theme !== undefined && o.theme !== this.opts.theme;
    this.opts = { ...this.opts, ...o };
    if (themeChanged) this.readColors();
    this.invalidate();
  }

  readColors() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
    this.colors = {
      bg: g('--bg', '#0b0d10'), surface: g('--surface', '#12151a'), surface3: g('--surface-3', '#1d222a'), line: g('--line', '#1e232b'),
      lineStrong: g('--line-strong', '#2a313b'), text: g('--text', '#e6e9ef'), text2: g('--text-2', '#b3bac6'), muted: g('--muted', '#8a93a3'),
      accent: g('--accent', '#7CFFB2'), warn: g('--warn', '#FFCC66'), danger: g('--danger', '#FF6B6B'),
      font: g('--font', 'IBM Plex Sans, system-ui, sans-serif'), mono: g('--font-mono', 'JetBrains Mono, monospace'),
    };
    this.widthCache.clear();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = Math.max(1, Math.round(r.width)); this.H = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.W * this.dpr); this.canvas.height = Math.round(this.H * this.dpr);
    this.invalidate();
  }

  /* ---------- camera ---------- */
  /** The transform is fixed to the canvas centre so opening a panel never moves the graph; only fit/focus aim at the free area. */
  private centre() { return { cx: this.W / 2, cy: this.H / 2 }; }
  private aim(x: number, y: number, k: number) { const sh = (this.opts.insetLeft - this.opts.insetRight) / 2, sv = (this.opts.insetTop - this.opts.insetBottom) / 2; return { x: x - sh / k, y: y - sv / k, k }; }
  private toScreen(x: number, y: number) { const { cx, cy } = this.centre(); return { x: (x - this.cam.x) * this.cam.k + cx, y: (y - this.cam.y) * this.cam.k + cy }; }
  private toWorld(sx: number, sy: number) { const { cx, cy } = this.centre(); return { x: (sx - cx) / this.cam.k + this.cam.x, y: (sy - cy) / this.cam.k + this.cam.y }; }
  private setCam(t: { x: number; y: number; k: number }, animate: boolean) {
    if (!animate || this.reduced) { this.cam = { ...t }; this.camTo = null; } else this.camTo = { ...t };
    this.invalidate();
  }

  fit(animate = true) {
    const b = this.sim.bounds();
    if (!b) return;
    const l = this.opts.insetLeft, r = this.opts.insetRight;
    const fw = Math.max(120, this.W - l - r - Math.min(190, (this.W - l - r) * 0.2)), fh = Math.max(120, this.H - this.opts.insetTop - this.opts.insetBottom - 110);
    const bw = Math.max(60, b.maxX - b.minX), bh = Math.max(60, b.maxY - b.minY);
    const k = Math.min(1.5, Math.max(MIN_K, Math.min(fw / bw, fh / bh)));
    this.setCam(this.aim((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, k), animate);
  }

  /** Frame a set of nodes (used for paths and search results). */
  fitIds(ids: string[]) {
    const ns = ids.map((i) => this.sim.byId.get(i)).filter((n): n is SimNode => !!n);
    if (!ns.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of ns) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
    const l = this.opts.insetLeft, r = this.opts.insetRight;
    const fw = Math.max(120, this.W - l - r - Math.min(160, (this.W - l - r) * 0.2)), fh = Math.max(120, this.H - this.opts.insetTop - this.opts.insetBottom - 100);
    const k = clamp(Math.min(fw / Math.max(80, maxX - minX), fh / Math.max(80, maxY - minY)), MIN_K, 1.6);
    this.userMoved = true; this.refit = null;
    this.setCam(this.aim((minX + maxX) / 2, (minY + maxY) / 2, k), true);
    this.refit = ids;
  }

  focusOn(id: string) {
    const n = this.sim.byId.get(id);
    if (!n) return;
    this.userMoved = true; this.refit = null;
    this.setCam(this.aim(n.x, n.y, Math.min(2, Math.max(this.cam.k, 0.95))), true);
  }
  /** Pan just enough to bring a node out from under the detail panel / left drawer. */
  reveal(id: string) {
    const n = this.sim.byId.get(id);
    if (!n || this.camTo) return;
    const p = this.toScreen(n.x, n.y);
    const l = this.opts.insetLeft + 50, r = this.W - this.opts.insetRight - 50;
    if (p.x >= l && p.x <= r && p.y >= 50 && p.y <= this.H - 50) return;
    this.setCam(this.aim(n.x, n.y, this.cam.k), true);
  }
  zoomBy(f: number) { this.userMoved = true; this.refit = null; const k = clamp(this.cam.k * f, MIN_K, MAX_K); this.setCam({ x: this.cam.x, y: this.cam.y, k }, true); }
  panBy(dx: number, dy: number) { this.userMoved = true; this.refit = null; this.setCam({ x: this.cam.x + dx / this.cam.k, y: this.cam.y + dy / this.cam.k, k: this.cam.k }, true); }
  relayout() {
    for (const n of this.sim.nodes) { n.vx = 0; n.vy = 0; }
    this.sim.alpha = 1;
    if (this.reduced) { this.sim.settle(400); this.fit(false); }
    this.userMoved = false;
    this.invalidate();
  }
  get zoom() { return this.cam.k; }
  /** Screen position of a node (diagnostics and tests). */
  screenOf(id: string): { x: number; y: number } | null { const n = this.sim.byId.get(id); return n ? this.toScreen(n.x, n.y) : null; }

  /* ---------- loop ---------- */
  invalidate() {
    if (this.raf || this.destroyed || this.hidden) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = () => {
    this.raf = 0;
    if (this.destroyed || this.hidden) return;
    let busy = false;
    const t0 = performance.now();
    if (this.sim.alpha > ALPHA_MIN && !this.reduced && !this.opts.frozen) {
      const wasActive = true;
      this.sim.tick();
      if (this.sim.nodes.length < 220) this.sim.tick();
      busy = wasActive;
      if (this.refit && this.sim.alpha > ALPHA_MIN && ++this.refitTick % 36 === 0) this.fitIds(this.refit);
      if (this.sim.alpha <= ALPHA_MIN) { if (this.refit) { const ids = this.refit; this.fitIds(ids); this.refit = null; } else if (!this.userMoved) this.fit(true); }
    }
    const t1 = performance.now();
    if (this.camTo) {
      const c = this.cam, t = this.camTo;
      c.x += (t.x - c.x) * 0.2; c.y += (t.y - c.y) * 0.2; c.k += (t.k - c.k) * 0.2;
      if (Math.abs(t.x - c.x) * c.k < 0.4 && Math.abs(t.y - c.y) * c.k < 0.4 && Math.abs(t.k - c.k) < 0.002) { this.cam = { ...t }; this.camTo = null; } else busy = true;
    }
    this.draw();
    const t2 = performance.now();
    const p = this.perf; p.frames++;
    p.tickMs = p.tickMs * 0.9 + (t1 - t0) * 0.1; p.drawMs = p.drawMs * 0.9 + (t2 - t1) * 0.1;
    if (p.frames % 20 === 0) { this.canvas.dataset.drawMs = p.drawMs.toFixed(2); this.canvas.dataset.tickMs = p.tickMs.toFixed(2); this.canvas.dataset.alpha = this.sim.alpha.toFixed(3); }
    if (busy) this.invalidate();
  };

  /* ---------- geometry ---------- */
  private nodeR(n: SimNode) { return Math.max(3, n.r * Math.pow(this.cam.k, 0.72)); }

  private geom(e: SimEdge): Geom {
    const a = this.toScreen(e.s.x, e.s.y), b = this.toScreen(e.t.x, e.t.y);
    const rs = this.nodeR(e.s), rt = this.nodeR(e.t) + 1.5;
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
    let cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const curved = e.bend !== 0;
    if (curved) { cx += (-dy / d) * e.bend * d * 0.55; cy += (dx / d) * e.bend * d * 0.55; }
    const tx1 = curved ? cx - a.x : dx, ty1 = curved ? cy - a.y : dy;
    const l1 = Math.hypot(tx1, ty1) || 1;
    const tx2 = curved ? b.x - cx : dx, ty2 = curved ? b.y - cy : dy;
    const l2 = Math.hypot(tx2, ty2) || 1;
    const x1 = a.x + (tx1 / l1) * rs, y1 = a.y + (ty1 / l1) * rs;
    const x2 = b.x - (tx2 / l2) * rt, y2 = b.y - (ty2 / l2) * rt;
    const mx = curved ? 0.25 * x1 + 0.5 * cx + 0.25 * x2 : (x1 + x2) / 2, my = curved ? 0.25 * y1 + 0.5 * cy + 0.25 * y2 : (y1 + y2) / 2;
    return { x1, y1, cx, cy, x2, y2, curved, ux: tx2 / l2, uy: ty2 / l2, mx, my };
  }

  private nodeAt(sx: number, sy: number): SimNode | null {
    const ns = this.sim.nodes;
    let best: SimNode | null = null, bd = Infinity;
    for (let i = ns.length - 1; i >= 0; i--) {
      const n = ns[i]!;
      const p = this.toScreen(n.x, n.y);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d <= this.nodeR(n) + 4 && d < bd) { best = n; bd = d; }
    }
    return best;
  }

  private edgeAt(sx: number, sy: number): SimEdge | null {
    let best: SimEdge | null = null, bd = 6;
    for (const e of this.sim.edges) {
      const g = this.geom(e);
      let px = g.x1, py = g.y1;
      const steps = g.curved ? 10 : 1;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const qx = g.curved ? (1 - t) * (1 - t) * g.x1 + 2 * (1 - t) * t * g.cx + t * t * g.x2 : g.x2;
        const qy = g.curved ? (1 - t) * (1 - t) * g.y1 + 2 * (1 - t) * t * g.cy + t * t * g.y2 : g.y2;
        const d = segDist(sx, sy, px, py, qx, qy);
        if (d < bd) { bd = d; best = e; }
        px = qx; py = qy;
      }
    }
    return best;
  }

  /* ---------- pointer ---------- */
  private local(e: PointerEvent | MouseEvent | WheelEvent) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  private setHover(n: SimNode | null, e: SimEdge | null) {
    const idChanged = (n?.id ?? null) !== (this.hoverNode?.id ?? null);
    if (!idChanged && (e?.id ?? null) === (this.hoverEdge?.id ?? null)) return;
    this.hoverNode = n; this.hoverEdge = e;
    this.canvas.style.cursor = n ? (this.opts.pickMode ? 'crosshair' : 'pointer') : e ? 'help' : this.opts.pickMode ? 'crosshair' : 'grab';
    if (idChanged) this.ev.onHover(n?.id ?? null);
    this.invalidate();
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const p = this.local(e);
    const n = this.nodeAt(p.x, p.y);
    const w = this.toWorld(p.x, p.y);
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.focus({ preventScroll: true });
    this.drag = { kind: n ? 'node' : 'pan', node: n ?? undefined, sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: false, pid: e.pointerId, dx: n ? n.x - w.x : 0, dy: n ? n.y - w.y : 0 };
    if (!n) this.canvas.style.cursor = 'grabbing';
  };

  private onMove = (e: PointerEvent) => {
    const p = this.local(e);
    const d = this.drag;
    if (!d) {
      const n = this.nodeAt(p.x, p.y);
      this.setHover(n, n ? null : this.edgeAt(p.x, p.y));
      return;
    }
    if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) < 4) return;
    d.moved = true; this.userMoved = true; this.refit = null;
    if (d.kind === 'pan') {
      this.cam.x -= (p.x - d.lx) / this.cam.k; this.cam.y -= (p.y - d.ly) / this.cam.k; this.camTo = null;
    } else if (d.node) {
      const w = this.toWorld(p.x, p.y);
      d.node.fx = w.x + d.dx; d.node.fy = w.y + d.dy;
      if (this.reduced) { d.node.x = d.node.fx; d.node.y = d.node.fy; } else this.sim.alpha = Math.max(this.sim.alpha, 0.3);
    }
    d.lx = p.x; d.ly = p.y;
    this.invalidate();
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag; this.drag = null;
    if (!d) return;
    try { this.canvas.releasePointerCapture(d.pid); } catch { /* ignore */ }
    if (d.node) { d.node.fx = null; d.node.fy = null; }
    this.canvas.style.cursor = this.hoverNode ? 'pointer' : 'grab';
    if (d.moved || e.type === 'pointercancel') return;
    if (d.node) { if (this.opts.pickMode) this.ev.onPick(d.node.id); else this.ev.onSelect(d.node.id); }
    else if (!this.opts.pickMode) this.ev.onSelect(null);
  };

  private onDbl = (e: MouseEvent) => {
    const p = this.local(e);
    const n = this.nodeAt(p.x, p.y);
    if (n) this.ev.onExpand(n.id);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.userMoved = true; this.refit = null;
    const p = this.local(e);
    const before = this.toWorld(p.x, p.y);
    const k = clamp(this.cam.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)), MIN_K, MAX_K);
    this.cam.k = k; this.camTo = null;
    const { cx, cy } = this.centre();
    this.cam.x = before.x - (p.x - cx) / k; this.cam.y = before.y - (p.y - cy) / k;
    this.invalidate();
  };

  /* ---------- drawing ---------- */
  private textW(text: string, font: string): number {
    const k = font + '|' + text;
    let w = this.widthCache.get(k);
    if (w === undefined) { this.ctx.font = font; w = this.ctx.measureText(text).width; if (this.widthCache.size > 4000) this.widthCache.clear(); this.widthCache.set(k, w); }
    return w;
  }

  private draw() {
    const c = this.ctx, col = this.colors, o = this.opts, K = this.cam.k;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.W, this.H);
    const nodes = this.sim.nodes, edges = this.sim.edges;
    if (!nodes.length) return;

    const hover = this.hoverNode ?? (o.hoverId ? this.sim.byId.get(o.hoverId) ?? null : null);
    const sel = o.selectedId ? this.sim.byId.get(o.selectedId) ?? null : null;
    const focus = hover ?? null;
    const focusNb = focus ? this.adj.get(focus.id) : sel ? this.adj.get(sel.id) : undefined;
    const emph = focus ?? sel;

    const nodeA = (n: SimNode): number => {
      let a = 1;
      if (o.pathActive && !o.pathNodes.has(n.id)) a = 0.2;
      if (o.match && !o.match(n.node)) a = Math.min(a, 0.16);
      if (focus) { if (n !== focus && !focusNb?.has(n.id) && !(o.pathActive && o.pathNodes.has(n.id))) a = Math.min(a, 0.14); }
      else if (sel && n !== sel && !focusNb?.has(n.id) && !(o.pathActive && o.pathNodes.has(n.id))) a = Math.min(a, 0.5);
      return a;
    };

    const tp = performance.now();
    this.geomCache.clear();
    // ---- edges (bucketed by emphasis so each bucket is one stroke)
    const lines: Array<{ e: SimEdge; g: Geom; a: number; w: number; col: string; arrow: boolean }> = [];
    const showArrows = K > 0.42;
    for (const e of edges) {
      const g = this.geom(e);
      this.geomCache.set(e.id, g);
      const inPath = o.pathActive && o.pathEdges.has(e.id);
      const touch = emph && (e.s === emph || e.t === emph);
      let a = 0.5;
      if (o.pathActive) a = inPath ? 1 : 0.1;
      if (o.match && !(o.match(e.s.node) && o.match(e.t.node))) a = Math.min(a, 0.08);
      if (focus) a = touch ? 0.95 : Math.min(a, 0.06);
      else if (sel) a = touch ? 0.95 : Math.min(a, o.pathActive ? a : 0.22);
      if (this.hoverEdge === e) a = 1;
      const tint = REL_TINT[e.edge.rel];
      const stroke = inPath ? col.accent : tint ? col[tint] : (touch || this.hoverEdge === e) ? col.text2 : col.muted;
      lines.push({ e, g, a, w: inPath ? 2.6 : touch || this.hoverEdge === e ? 1.7 : 1, col: stroke, arrow: showArrows || !!touch || inPath });
    }
    lines.sort((x, y) => x.a - y.a);
    for (const L of lines) {
      c.globalAlpha = L.a; c.strokeStyle = L.col; c.lineWidth = L.w;
      c.beginPath(); c.moveTo(L.g.x1, L.g.y1);
      if (L.g.curved) c.quadraticCurveTo(L.g.cx, L.g.cy, L.g.x2, L.g.y2); else c.lineTo(L.g.x2, L.g.y2);
      if (L.e.edge.rel === 'supersedes') c.setLineDash([5, 3]); else if (L.e.edge.rel === 'contradicts') c.setLineDash([2, 3]);
      c.stroke(); c.setLineDash([]);
      if (L.arrow && L.a > 0.12) {
        const sz = L.w > 1.5 ? 8 : 6.5, ux = L.g.ux, uy = L.g.uy;
        c.fillStyle = L.col;
        c.beginPath();
        c.moveTo(L.g.x2 + ux * 1.5, L.g.y2 + uy * 1.5);
        c.lineTo(L.g.x2 - ux * sz - uy * sz * 0.42, L.g.y2 - uy * sz + ux * sz * 0.42);
        c.lineTo(L.g.x2 - ux * sz + uy * sz * 0.42, L.g.y2 - uy * sz - ux * sz * 0.42);
        c.closePath(); c.fill();
      }
    }
    c.globalAlpha = 1;

    const te = performance.now();
    // ---- nodes
    const order = nodes.slice().sort((a, b) => rank(a) - rank(b));
    function rank(n: SimNode) { return n === sel ? 3 : n === focus ? 4 : o.pathNodes.has(n.id) && o.pathActive ? 2 : o.hitIds.has(n.id) ? 1 : 0; }
    const showBadge = K > 0.75;
    for (const n of order) {
      const p = this.toScreen(n.x, n.y);
      if (p.x < -30 || p.y < -30 || p.x > this.W + 30 || p.y > this.H + 30) continue;
      const r = this.nodeR(n);
      const a = nodeA(n);
      const fill = typeColor(o.theme, n.node.type);
      const isSel = n === sel, isHover = n === focus, inPath = o.pathActive && o.pathNodes.has(n.id);
      c.globalAlpha = a;
      if (o.hitIds.has(n.id) && !isSel) { c.fillStyle = withAlpha(col.accent, 0.2); c.beginPath(); c.arc(p.x, p.y, r + 7, 0, 6.2832); c.fill(); }
      if (isSel) { c.fillStyle = withAlpha(col.accent, 0.22); c.beginPath(); c.arc(p.x, p.y, r + 9, 0, 6.2832); c.fill(); }
      // backing disc keeps edges from showing through translucent fills
      c.fillStyle = col.bg; c.beginPath(); c.arc(p.x, p.y, r + 1, 0, 6.2832); c.fill();
      c.fillStyle = fill; c.globalAlpha = a * 0.92; c.beginPath(); c.arc(p.x, p.y, r, 0, 6.2832); c.fill();
      c.globalAlpha = a;
      // scope outline
      const sk = scopeKind(n.node.scope);
      if (sk === 'agent') { c.strokeStyle = col.text2; c.lineWidth = 1.6; c.setLineDash([3, 2.4]); c.beginPath(); c.arc(p.x, p.y, r + 3, 0, 6.2832); c.stroke(); c.setLineDash([]); }
      else if (sk === 'bsv') { c.strokeStyle = col.warn; c.lineWidth = 2; c.beginPath(); c.arc(p.x, p.y, r + 3, 0, 6.2832); c.stroke(); }
      else { c.strokeStyle = col.lineStrong; c.lineWidth = 1; c.beginPath(); c.arc(p.x, p.y, r + 0.5, 0, 6.2832); c.stroke(); }
      if (n.node.sources?.some((s) => s.untrusted)) { c.fillStyle = col.warn; c.beginPath(); c.arc(p.x - r * 0.72, p.y - r * 0.72, 2.6, 0, 6.2832); c.fill(); }
      if (isSel || inPath) { c.strokeStyle = col.accent; c.lineWidth = isSel ? 2.4 : 2; c.beginPath(); c.arc(p.x, p.y, r + (sk === 'shared' ? 2.5 : 6), 0, 6.2832); c.stroke(); }
      else if (isHover) { c.strokeStyle = col.text; c.lineWidth = 1.5; c.beginPath(); c.arc(p.x, p.y, r + (sk === 'shared' ? 2.5 : 6), 0, 6.2832); c.stroke(); }
      // creator badge
      if ((showBadge || isSel || isHover) && r >= 5) {
        const bx = p.x + r * 0.78, by = p.y + r * 0.78, br = 5.6;
        c.fillStyle = col.surface3; c.strokeStyle = col.lineStrong; c.lineWidth = 1;
        c.beginPath(); c.arc(bx, by, br, 0, 6.2832); c.fill(); c.stroke();
        const g = o.badges[n.node.createdBy] ?? (n.node.createdBy === 'human' ? 'H' : n.node.createdBy === 'system' ? 'S' : n.node.createdBy.charAt(0).toUpperCase());
        c.fillStyle = col.text; c.font = `600 7.5px ${col.mono}`; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(g, bx, by + 0.4);
      }
    }
    c.globalAlpha = 1;

    const tn = performance.now();
    // ---- labels with greedy collision avoidance
    interface Cand { n: SimNode; pri: number; text: string; font: string; bold: boolean }
    const cands: Cand[] = [];
    const lblBudget = K < 0.3 ? 8 : K < 0.55 ? 26 : K < 0.9 ? 60 : 400;
    for (const n of nodes) {
      const p = this.toScreen(n.x, n.y);
      if (p.x < -10 || p.y < -10 || p.x > this.W + 10 || p.y > this.H + 10) continue;
      const isSel = n === sel, isHover = n === focus, nb = !!emph && !!this.adj.get(emph.id)?.has(n.id), inPath = o.pathActive && o.pathNodes.has(n.id);
      let pri = n.deg;
      if (isHover) pri = 1e6; else if (isSel) pri = 9e5; else if (inPath) pri = 8e5; else if (nb) pri = 5e5 + n.deg; else if (o.hitIds.has(n.id)) pri = 4e5 + n.deg;
      else if (focus || (o.pathActive)) continue;
      else if (nodeA(n) < 0.3) continue;
      const bold = isSel || isHover || inPath;
      const t = n.node.title.length > 30 ? n.node.title.slice(0, 29) + '…' : n.node.title;
      cands.push({ n, pri, text: t, font: `${bold ? 600 : 500} ${bold ? 12.5 : 11.5}px ${col.font}`, bold });
    }
    cands.sort((a, b) => b.pri - a.pri);
    const placed: Array<[number, number, number, number]> = [];
    // nodes are obstacles too: a label may not sit on top of a neighbouring disc
    const discs: Array<[number, number, number]> = [];
    for (const n of nodes) { const p = this.toScreen(n.x, n.y); if (p.x > -40 && p.y > -40 && p.x < this.W + 40 && p.y < this.H + 40) discs.push([p.x, p.y, this.nodeR(n) + 3]); }
    let shown = 0;
    c.textAlign = 'center'; c.textBaseline = 'alphabetic'; c.lineJoin = 'round';
    for (const cd of cands) {
      if (cd.pri < 5e5 && shown >= lblBudget) break;
      const p = this.toScreen(cd.n.x, cd.n.y), r = this.nodeR(cd.n);
      const w = this.textW(cd.text, cd.font);
      const lo = o.insetLeft + 6 + w / 2, hi = this.W - o.insetRight - 6 - w / 2;
      if (p.x < o.insetLeft - 4 || p.x > this.W - o.insetRight + 4) continue; // node itself is covered by a panel
      const lx = hi > lo ? Math.min(hi, Math.max(lo, p.x)) : p.x;
      const x0 = lx - w / 2 - 3, y0 = p.y + r + 5, x1 = lx + w / 2 + 3, y1 = y0 + 15;
      if (cd.pri < 8e5 && placed.some((q) => x0 < q[2] && x1 > q[0] && y0 < q[3] && y1 > q[1])) continue;
      if (cd.pri < 8e5 && discs.some((q) => q[0] + q[2] > x0 && q[0] - q[2] < x1 && q[1] + q[2] > y0 && q[1] - q[2] < y1 && !(Math.abs(q[0] - p.x) < 0.5 && Math.abs(q[1] - p.y) < 0.5))) continue;
      placed.push([x0, y0, x1, y1]); shown++;
      c.font = cd.font;
      c.globalAlpha = Math.max(0.55, nodeA(cd.n));
      c.lineWidth = 3.4; c.strokeStyle = col.bg; c.strokeText(cd.text, lx, y0 + 11);
      c.fillStyle = cd.bold ? col.text : col.text2; c.fillText(cd.text, lx, y0 + 11);
    }
    c.globalAlpha = 1;

    const tl = performance.now();
    // ---- edge labels (hovered edge, edges of the hovered node, path edges)
    const labelEdges: SimEdge[] = [];
    if (this.hoverEdge) labelEdges.push(this.hoverEdge);
    if (focus) for (const e of edges) { if ((e.s === focus || e.t === focus) && e !== this.hoverEdge) labelEdges.push(e); if (labelEdges.length > 16) break; }
    else if (o.pathActive) for (const e of edges) if (o.pathEdges.has(e.id)) labelEdges.push(e);
    c.textBaseline = 'middle';
    const edgeRects: Array<[number, number, number, number]> = [];
    for (const e of labelEdges) {
      const g = this.geomCache.get(e.id)!;
      const text = e.edge.rel.replace(/_/g, ' ');
      const font = `500 10.5px ${col.mono}`;
      const w = this.textW(text, font) + 10;
      // slide along the edge until the pill clears node labels and other pills
      const hit = (x0: number, y0: number) => edgeRects.some((q) => x0 < q[2] && x0 + w > q[0] && y0 < q[3] && y0 + 16 > q[1]) || placed.some((q) => x0 < q[2] && x0 + w > q[0] && y0 < q[3] && y0 + 16 > q[1]);
      let mx = g.mx, my = g.my, ok = !hit(mx - w / 2, my - 8);
      for (const t of [0.36, 0.64, 0.26, 0.74, 0.18, 0.82]) {
        if (ok) break;
        const u = 1 - t;
        const px = g.curved ? u * u * g.x1 + 2 * u * t * g.cx + t * t * g.x2 : g.x1 + (g.x2 - g.x1) * t;
        const py = g.curved ? u * u * g.y1 + 2 * u * t * g.cy + t * t * g.y2 : g.y1 + (g.y2 - g.y1) * t;
        if (!hit(px - w / 2, py - 8)) { mx = px; my = py; ok = true; }
      }
      const x0 = mx - w / 2, y0 = my - 8;
      if (!ok && e !== this.hoverEdge && !(o.pathActive && o.pathEdges.has(e.id))) continue;
      edgeRects.push([x0, y0, x0 + w, y0 + 16]);
      const tint = REL_TINT[e.edge.rel];
      c.fillStyle = col.surface3; c.strokeStyle = o.pathActive && o.pathEdges.has(e.id) ? col.accent : tint ? col[tint] : col.lineStrong; c.lineWidth = 1;
      roundRect(c, x0, y0, w, 16, 8); c.fill(); c.stroke();
      c.font = font; c.fillStyle = tint ? col[tint] : col.text; c.fillText(text, mx, my + 0.5);
    }
    this.sections = [te - tp, tn - te, tl - tn, performance.now() - tl];
  }
}

/* ---------- helpers ---------- */
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
