// Lattice before/after measurement with a real core and real Chromium (no GPU in CI VMs: trust ratios, counts and allocation, not absolute ms).
//   node test-perf/lattice/measure.mjs --root <tree with dist and dist-ui> [--dpr 1|2] [--out file.json]
// Env EXTRA_NODES / EXTRA_EDGES add synthetic notes (a bigger graph). The same script runs against the baseline tree (c70616d) and this one.
import fs from 'node:fs';
import { arg, launch, sleep, startCore } from './lib.mjs';
const root = arg('root', process.cwd());
const dpr = Number(arg('dpr', 1));
const out = arg('out');
const { cfg, stop } = await startCore(root);
const { browser, ctx } = await launch(root, cfg, { dpr });
await ctx.addInitScript(() => {
  const W = window; W.__c = { tick: 0, draw: 0, drawMs: 0, dash: 0 }; W.__tk = []; W.__cur = 0; W.__sd = [];
  const P = CanvasRenderingContext2D.prototype; const od = P.setLineDash; P.setLineDash = function (...a) { W.__c.dash++; return od.apply(this, a); };
  // the engine is handed to the canvas as __lattice (diagnostic hook): wrap its tick/draw when it arrives
  Object.defineProperty(HTMLCanvasElement.prototype, '__lattice', { configurable: true, get() { return this.__l; }, set(e) {
    this.__l = e; const t = e.sim.tick.bind(e.sim); e.sim.tick = () => { W.__c.tick++; const s0 = performance.now(); const r = t(); W.__cur += performance.now() - s0; return r; };
    const sd = e.setData.bind(e); e.setData = (...a) => { const s0 = performance.now(); const r = sd(...a); W.__sd.push([s0, performance.now() - s0]); return r; };
    const d = e.draw.bind(e); e.draw = (...a) => { const s = performance.now(); const r = d(...a); W.__c.draw++; W.__c.drawMs += performance.now() - s; return r; };
  } });
  W.__f = []; const raf = W.requestAnimationFrame.bind(W); let last = performance.now();
  const loop = (t) => { W.__f.push([t, t - last]); last = t; W.__tk.push([t, W.__cur]); W.__cur = 0; raf(loop); }; raf(loop);
  W.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) W.__lt.push([e.startTime, e.duration]); }).observe({ entryTypes: ['longtask'] }); } catch {}
});
const page = await ctx.newPage();
const reqs = []; const t00 = Date.now();
page.on('request', (r) => { const u = r.url(); if (u.includes('/api/')) reqs.push({ t: Date.now() - t00, u: u.replace(cfg.core, '').split('?')[0], full: u.replace(cfg.core, '') }); });
page.on('pageerror', (e) => console.error('pageerror', e.message));
const cdp = await ctx.newCDPSession(page); await cdp.send('Performance.enable');
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const q = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const kinds = (rs) => rs.reduce((a, r) => (a[r.u] = (a[r.u] || 0) + 1, a), {});
const R = { root, dpr, stats: cfg.stats && { nodes: cfg.stats.nodes, edges: cfg.stats.edges } };

/** Run `action` and report main-thread cost, frame gaps, long tasks, work counters and API requests inside the window. */
async function windowOf(label, action) {
  const m0 = await metrics(); const c0 = await page.evaluate(() => ({ ...__c })); const r0 = reqs.length;
  const t0 = await page.evaluate(() => performance.now());
  const extra = await action();
  const m1 = await metrics(); const c1 = await page.evaluate(() => ({ ...__c })); const t1 = await page.evaluate(() => performance.now());
  const w = await page.evaluate(([a, b]) => ({ tk: __tk.filter(([t]) => t >= a && t <= b).map((x) => x[1]), sd: __sd.filter(([t]) => t >= a && t <= b).map((x) => x[1]), f: __f.filter(([t]) => t >= a && t <= b).map((x) => x[1]), lt: __lt.filter(([t]) => t >= a && t <= b).map((x) => x[1]) }), [t0, t1]);
  const rr = reqs.slice(r0);
  const o = { label, ms: Math.round(t1 - t0), cpuTaskMs: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000), scriptMs: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000),
    ticks: c1.tick - c0.tick, draws: c1.draw - c0.draw, drawMsTotal: Math.round(c1.drawMs - c0.drawMs), tickMsPerFrameMax: +Math.max(0, ...w.tk).toFixed(1), tickMsPerFrameP95: +q(w.tk, 0.95).toFixed(1), tickMsTotal: +w.tk.reduce((a, b) => a + b, 0).toFixed(0), setDataMsMax: +Math.max(0, ...w.sd).toFixed(1), setDataCalls: w.sd.length, frames: w.f.length, gapMax: Math.round(Math.max(0, ...w.f)), gapP95: Math.round(q(w.f, 0.95)), gapsOver34: w.f.filter((g) => g > 34).length,
    longTasks: w.lt.length, longTaskMax: Math.round(Math.max(0, ...w.lt)), longTaskSum: Math.round(w.lt.reduce((a, b) => a + b, 0)), apiReqs: rr.length, req: kinds(rr), ...extra };
  console.error(JSON.stringify(o)); (R.windows ??= []).push(o); return o;
}
const settle = async (since, ms = 15000) => { for (let i = 0; i < ms / 50; i++) { const a = await page.evaluate(() => document.querySelector('canvas.lt-canvas')?.__lattice?.sim.alpha ?? 1); if (a <= 0.012) return Date.now() - since; await sleep(50); } return null; };
const lib = 'button.tb-view[aria-label^="Library"]', chat = 'button.tb-view[aria-label="Chat"]';

await page.goto(cfg.ui + '/?latticeDiag'); await page.waitForSelector('.titlebar'); await sleep(1500);
const openLib = (label) => windowOf(label, async () => {
  const t = Date.now(); await page.click(lib); await page.waitForSelector('canvas.lt-canvas');
  await page.waitForFunction(() => document.querySelector('canvas.lt-canvas').__lattice);
  const w0 = await page.evaluate(() => document.querySelector('canvas.lt-canvas').width);
  const settledMs = await settle(t); await sleep(800);
  const e = await page.evaluate(() => { const c = document.querySelector('canvas.lt-canvas'); const l = c.__lattice; return { nodes: l.sim.nodes.length, edges: l.sim.edges.length, canvasW: c.width, dprStartW: 0 }; });
  return { settledMs, nodes: e.nodes, edges: e.edges, canvasWAtRest: e.canvasW, firstSeenCanvasW: w0 };
});
await openLib('open-library');
await sleep(500);
await page.click(chat); await sleep(800);
await openLib('re-open-library');

const ids = await page.evaluate(() => [...document.querySelector('canvas.lt-canvas').__lattice.sim.nodes].map((n) => n.id));
const alphaOf = () => page.evaluate(() => document.querySelector('canvas.lt-canvas').__lattice.sim.alpha);
await sleep(1000);
await windowOf('idle-5s', () => sleep(5000));
const emit = (changed) => fetch(cfg.emit + '/?changed=' + encodeURIComponent(changed.join(',')));
await windowOf('kg.updated unrelated id', async () => { await emit(['not-on-canvas-' + Date.now()]); await sleep(2500); return { alpha: await alphaOf() }; });
await windowOf('kg.updated on-canvas id, nothing changed', async () => { await emit([ids[5]]); await sleep(3500); return { alpha: await alphaOf() }; });
await windowOf('kg.updated no changed[] (refresh)', async () => { await emit([]); await sleep(3500); return { alpha: await alphaOf() }; });
const H = { Authorization: `Bearer ${cfg.token}`, 'X-Legion-Admin': cfg.admin, 'Content-Type': 'application/json' };
await windowOf('one real write (new note)', async () => { await fetch(cfg.core + '/api/kg/nodes', { method: 'POST', headers: H, body: JSON.stringify({ title: 'Noise ' + Date.now(), type: 'note', body: 'x', scope: 'shared' }) }); await sleep(4000); return { alpha: await alphaOf() }; });
await windowOf('five writes, 1/s', async () => { for (let i = 0; i < 5; i++) { await fetch(cfg.core + '/api/kg/nodes', { method: 'POST', headers: H, body: JSON.stringify({ title: 'Noise ' + i + Date.now(), type: 'note', body: 'x', scope: 'shared' }) }); await sleep(1000); } await sleep(3500); });

// ---- draw / hit-test micro measurements on the settled canvas (heap deltas need precise memory info + gc)
await settle(Date.now()); await sleep(500);
R.draw = await page.evaluate(() => {
  const c = document.querySelector('canvas.lt-canvas'); const e = c.__lattice; const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const heap = () => performance.memory.usedJSHeapSize;
  const garbage = (fn, n, rounds = 7) => { const r = []; for (let k = 0; k < rounds; k++) { gc(); const a = heap(); for (let i = 0; i < n; i++) fn(); r.push((heap() - a) / n / 1024); } return +med(r).toFixed(1); };
  // best of 7 rounds: a shared CI VM adds noise upwards only
  const ms = (fn, n) => { for (let i = 0; i < 5; i++) fn(); let b = Infinity; for (let k = 0; k < 7; k++) { const t = performance.now(); for (let i = 0; i < n; i++) fn(); b = Math.min(b, (performance.now() - t) / n); } return +b.toFixed(3); };
  const dashPer = (fn) => { const a = __c.dash; fn(); return __c.dash - a; };
  const draw = () => e.draw.__orig ? e.draw.__orig() : Object.getPrototypeOf(e).draw.call(e);
  const out = { hasHoverDpr: c.width };
  const n0 = e.sim.nodes.find((n) => n.deg > 4);
  const st = (hov) => { e.hoverNode = hov; };
  st(null); out.idle = { drawMs: ms(draw, 100), garbageKBperDraw: garbage(draw, 20), setLineDashPerDraw: dashPer(draw) };
  st(n0); out.hover = { drawMs: ms(draw, 100), garbageKBperDraw: garbage(draw, 20), setLineDashPerDraw: dashPer(draw) }; st(null);
  const p = e.screenOf(n0.id);
  out.nodeAt = { ms: ms(() => e.nodeAt(p.x, p.y), 3000), garbageKB: garbage(() => e.nodeAt(p.x, p.y), 3000) };
  out.edgeAtEmpty = { ms: ms(() => e.edgeAt(8, 8), 3000), garbageKB: garbage(() => e.edgeAt(8, 8), 3000) };
  out.edgeAtNear = { ms: ms(() => e.edgeAt(p.x + 3, p.y + 3), 3000), garbageKB: garbage(() => e.edgeAt(p.x + 3, p.y + 3), 3000) };
  return out;
});
console.error(JSON.stringify(R.draw));
await browser.close(); stop();
const txt = JSON.stringify(R, null, 1); if (out) fs.writeFileSync(out, txt); else console.log(txt);
process.exit(0);
