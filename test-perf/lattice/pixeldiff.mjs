// Pixel-for-pixel comparison of a settled Lattice frame between two builds, with identical data and identical node positions.
//   node test-perf/lattice/pixeldiff.mjs --base <baseline tree> --new <this tree> [--out dir]
// One core serves the data to both builds. Positions come from the baseline run (settled layout) and are applied to both before
// every capture, so only the drawing code differs (layout equivalence is covered by test/perf-l-lattice.test.ts).
import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path'; import { arg, launch, sleep, startCore } from './lib.mjs';
const baseRoot = path.resolve(arg('base')), newRoot = path.resolve(arg('new', process.cwd())), outDir = arg('out', '/tmp/m/pixeldiff');
fs.mkdirSync(outDir, { recursive: true });
const { cfg, stop } = await startCore(newRoot);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const serve = async (root) => { const s = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, 'dist-ui', p); if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }); await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; };
const ui = { base: await serve(baseRoot), new: await serve(newRoot) };
let positions = null; const shots = {};

async function capture(which, dpr) {
  const { browser, ctx } = await launch(which === 'base' ? baseRoot : newRoot, cfg, { dpr });
  const page = await ctx.newPage(); page.on('pageerror', (e) => console.error(which, 'pageerror', e.message));
  await page.goto(ui[which] + '/?latticeDiag'); await page.waitForSelector('.titlebar'); await sleep(800);
  await page.click('button.tb-view[aria-label^="Library"]'); await page.waitForSelector('canvas.lt-canvas');
  await page.waitForFunction(() => document.querySelector('canvas.lt-canvas').__lattice);
  for (let i = 0; i < 400; i++) { const a = await page.evaluate(() => document.querySelector('canvas.lt-canvas').__lattice.sim.alpha); if (a <= 0.012) break; await sleep(100); }
  await sleep(1000);
  const res = await page.evaluate(async ([positions, core, token, admin]) => {
    const c = document.querySelector('canvas.lt-canvas'); const e = c.__lattice;
    const sd = e.setData.bind(e); e.setData = () => {}; // the UI's own loads must not touch the frame while we capture
    const r = await fetch(core + '/api/kg/overview?limit=200', { headers: { Authorization: 'Bearer ' + token, 'X-Legion-Admin': admin } });
    const sub = await r.json();
    sd(sub.nodes, sub.edges);
    const settledPos = () => Object.fromEntries(e.sim.nodes.map((n) => [n.id, [n.x, n.y]]));
    let settled = null;
    if (!positions) { for (let i = 0; i < 3000 && e.sim.alpha > 0.012; i++) e.sim.tick(); settled = settledPos(); }
    else { e.pre = 0; for (let i = 0; i < 3000 && e.sim.alpha > 0.012; i++) e.sim.tick(); settled = settledPos(); }
    const pos = positions ?? settled;
    for (const n of e.sim.nodes) { const p = pos[n.id]; if (p) { n.x = p[0]; n.y = p[1]; n.vx = 0; n.vy = 0; } }
    e.sim.alpha = 0; e.pre = 0; e.camTo = null; e.userMoved = true; e.hoverNode = null; e.hoverEdge = null;
    e.resize(); e.fit(false);
    const base = { ...e.cam };
    const nodes = [...e.sim.nodes]; const byDeg = [...nodes].sort((a, b) => b.deg - a.deg);
    const sel = byDeg[0], hov = byDeg[3], other = byDeg[10];
    const edges = e.sim.edges; const hedge = edges.find((x) => x.s !== sel && x.t !== sel && x.s.deg > 3);
    // a short path out from the selected node
    const pn = [sel.id], pe = []; let cur = sel; for (let i = 0; i < 4; i++) { const ed = edges.find((x) => (x.s === cur || x.t === cur) && !pn.includes(x.s === cur ? x.t.id : x.s.id)); if (!ed) break; pe.push(ed.id); cur = ed.s === cur ? ed.t : ed.s; pn.push(cur.id); }
    const types = [...new Set(nodes.map((n) => n.node.type))];
    const hit = new Set(byDeg.slice(5, 20).map((n) => n.id));
    const D = { selectedId: null, hoverId: null, pathNodes: new Set(), pathEdges: new Set(), pathActive: false, hitIds: new Set(), match: null, theme: 'dark' };
    const states = {
      fit: {}, zoom13: { k: base.k * 1.3 }, zoom3: { k: 3, at: hov }, zoom06: { k: base.k * 0.6 },
      hover: { hoverNode: hov }, hoverEdge: { hoverEdge: hedge }, select: { selectedId: sel.id }, 'select+hover': { selectedId: sel.id, hoverNode: other },
      path: { pathActive: true, pathNodes: new Set(pn), pathEdges: new Set(pe), selectedId: sel.id }, match: { match: (n) => n.type === types[0] }, hitIds: { hitIds: hit },
      light: { theme: 'light' },
    };
    const out = {};
    for (const [name, s] of Object.entries(states)) {
      const { hoverNode, hoverEdge, k, at, ...o } = s;
      if (s.theme === 'light') document.documentElement.dataset.theme = 'light';
      e.setOptions({ ...D, ...o }); if (s.theme === 'light') e.readColors();
      e.hoverNode = hoverNode ?? null; e.hoverEdge = hoverEdge ?? null;
      e.cam = { ...base }; if (k) { e.cam.k = k; if (at) { e.cam.x = at.x; e.cam.y = at.y; } }
      e.draw();
      out[name] = c.toDataURL('image/png');
      if (s.theme === 'light') { delete document.documentElement.dataset.theme; e.readColors(); }
    }
    return { out, settled, size: [c.width, c.height], nodes: nodes.length, edges: edges.length };
  }, [positions, cfg.core, cfg.token, cfg.admin]);
  await browser.close();
  return res;
}

const report = { dpr: {} };
for (const dpr of [1, 2]) {
  const b = await capture('base', dpr);
  if (dpr === 1) positions = b.settled;
  const n = await capture('new', dpr);
  shots[dpr] = { base: b.out, new: n.out };
  console.error('dpr', dpr, 'canvas', b.size, n.size, 'nodes', b.nodes, 'edges', b.edges);
}
// compare in a blank page (lossless PNG data URLs, per-channel)
const { browser, ctx } = await launch(newRoot, cfg, { dpr: 1 }); const pg = await ctx.newPage(); await pg.goto('about:blank');
for (const dpr of [1, 2]) {
  const r = await pg.evaluate(async (shots) => {
    const load = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = u; });
    const px = async (u) => { const i = await load(u); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); return { w: i.width, h: i.height, d: x.getImageData(0, 0, i.width, i.height).data }; };
    const out = {};
    for (const k of Object.keys(shots.base)) {
      const a = await px(shots.base[k]), b = await px(shots.new[k]);
      if (a.w !== b.w || a.h !== b.h) { out[k] = { sizeMismatch: [a.w, a.h, b.w, b.h] }; continue; }
      let n = 0, mx = 0, sum = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; const diff = new Uint8ClampedArray(a.d.length);
      for (let i = 0; i < a.d.length; i += 4) { const d = Math.max(Math.abs(a.d[i] - b.d[i]), Math.abs(a.d[i + 1] - b.d[i + 1]), Math.abs(a.d[i + 2] - b.d[i + 2]), Math.abs(a.d[i + 3] - b.d[i + 3])); if (d) { n++; sum += d; if (d > mx) mx = d; const p = i >> 2, x = p % a.w, y = (p / a.w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; diff[i] = 255; diff[i + 3] = 255; } }
      out[k] = { differingPixels: n, totalPixels: a.w * a.h, maxChannelDiff: mx, meanDiffWhereDifferent: n ? +(sum / n).toFixed(2) : 0, bbox: n ? [x0, y0, x1, y1] : null };
      if (n) { const c = document.createElement('canvas'); c.width = a.w; c.height = a.h; c.getContext('2d').putImageData(new ImageData(diff, a.w, a.h), 0, 0); out[k].diffPng = c.toDataURL('image/png'); }
    }
    // control: the harness must see a difference when there is one (same build, two different states)
    { const a = await px(shots.new.fit), b = await px(shots.new.select); let n = 0; for (let i = 0; i < a.d.length; i += 4) if (a.d[i] !== b.d[i] || a.d[i + 1] !== b.d[i + 1] || a.d[i + 2] !== b.d[i + 2]) n++; out.__control_fit_vs_select = { differingPixels: n }; }
    return out;
  }, shots[dpr]);
  report.dpr[dpr] = r;
  for (const [k, v] of Object.entries(r)) { if (k.startsWith('__')) { console.log(`dpr${dpr} ${k}`, JSON.stringify(v)); continue; }
    const save = (tag, u) => fs.writeFileSync(path.join(outDir, `dpr${dpr}-${k}-${tag}.png`), Buffer.from(u.split(',')[1], 'base64'));
    if (v.differingPixels || v.sizeMismatch) { save('base', shots[dpr].base[k]); save('new', shots[dpr].new[k]); if (v.diffPng) save('diff', v.diffPng); }
    delete v.diffPng;
    console.log(`dpr${dpr} ${k.padEnd(13)}`, JSON.stringify(v));
  }
}
await browser.close(); stop();
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
process.exit(0);
