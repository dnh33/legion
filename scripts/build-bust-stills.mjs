#!/usr/bin/env node
/**
 * Renders the resting pictures of every painted bust: one WebP per bust x state x theme, into ui/src/mascot/stills/<theme>/.
 *
 * Each picture is a screenshot of the REAL engine (ui/src/mascot/engine.js) with the REAL stylesheets (tokens.css, mascot.css,
 * bust.css) in headless Edge, mounted exactly as <Bust> mounts it at rest (rail mode, rail crop, centred in a square slot, transparent
 * background). A canvas redraw of the layer SVGs was tried before and was wrong (hidden eye sets showed), so do not do that.
 *
 * Run: node scripts/build-bust-stills.mjs [--only scout,builder] [--out dir]
 * Needs playwright-core and Microsoft Edge on this machine (not repo dependencies): set PLAYWRIGHT_CORE to the path of
 * playwright-core/index.mjs if `import('playwright-core')` does not resolve. The output is committed; CI never runs this.
 */
import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MASCOT = join(ROOT, 'ui', 'src', 'mascot');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const OUT = resolve(arg('--out') ?? join(MASCOT, 'stills'));
const ONLY = arg('--only')?.split(',');

const BUSTS = ['zealot', 'archivist', 'assayer', 'builder', 'exorcist', 'forgemaster', 'herald', 'inquisitor', 'preceptor', 'scout', 'scribe', 'sculptor', 'sentinel'];
const STATES = ['idle', 'awaiting', 'sleeping', 'hacking', 'thinking', 'error'];
const THEMES = ['dark', 'light'];
const SLOT = 80;      // css px of the square slot the bust is fitted in (same maths as Bust.tsx)
const DPR = 2;
const OUT_PX = 96;    // the biggest resting bust is 44 css px; 96 covers 2x screens
const QUALITY = Number(arg('--quality') ?? 0.8);

const page_html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/mascot.css"><link rel="stylesheet" href="/bust.css">
<style>html,body{margin:0;background:transparent}</style></head><body><span id="slot" class="bust bust-rest" style="width:${SLOT}px;height:${SLOT}px"></span>
<script type="module">
import { createMascot } from '/engine.js';
const get = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u); return r.json(); });
window.mount = async (id, state, theme) => {
  document.documentElement.dataset.theme = theme;
  const slot = document.getElementById('slot'); slot.replaceChildren();
  const [data, p] = await Promise.all([get(id === 'zealot' ? '/data/relic.json' : '/data/' + id + '.json'), get('/personas/' + id + '.json')]);
  const f = p.cropRail || data.cropRail || data.crop, k = Math.min(${SLOT} / f[2], ${SLOT} / f[3]);
  const host = document.createElement('span'); host.className = 'bust-host';
  host.style.width = Math.round(f[2] * k) + 'px'; host.style.height = Math.round(f[3] * k) + 'px';
  slot.append(host);
  window.__m?.destroy(); window.__m = createMascot(host, data, { rail: true, cropRail: p.cropRail, persona: p, quips: p.quips });
  window.__m.setState(state);
};
window.toWebp = (pngB64, px, q) => new Promise((ok, no) => {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = c.height = px;
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, px, px);
    c.toBlob((b) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.readAsDataURL(b); }, 'image/webp', q);
  };
  img.onerror = no; img.src = 'data:image/png;base64,' + pngB64;
});
window.__ready = true;
</script></body></html>`;

const TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x').pathname;
  let file;
  if (u === '/') { res.setHeader('content-type', 'text/html'); return res.end(page_html); }
  if (u === '/tokens.css') file = join(ROOT, 'ui', 'src', 'styles', 'tokens.css');
  else if (/^\/[\w./-]+$/.test(u) && !u.includes('..')) file = join(MASCOT, u);
  if (!file || !existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  res.end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));

const pw = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : 'playwright-core');
const browser = await pw.chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 200, height: 200 }, deviceScaleFactor: DPR });
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => window.__ready);

let n = 0, bytes = 0;
for (const theme of THEMES) {
  mkdirSync(join(OUT, theme), { recursive: true });
  for (const id of BUSTS.filter((b) => !ONLY || ONLY.includes(b))) for (const state of STATES) {
    await page.evaluate(([i, s, t]) => window.mount(i, s, t), [id, state, theme]);
    await page.waitForTimeout(450);
    const png = await page.locator('#slot').screenshot({ omitBackground: true });
    const b64 = await page.evaluate(([d, px, q]) => window.toWebp(d, px, q), [png.toString('base64'), OUT_PX, QUALITY]);
    const buf = Buffer.from(b64, 'base64');
    writeFileSync(join(OUT, theme, `${id}-${state}.webp`), buf);
    n++; bytes += buf.length;
  }
}
await browser.close(); server.close();
console.log(`${n} stills, ${(bytes / 1024).toFixed(0)} KB total, ${(bytes / n / 1024).toFixed(1)} KB each -> ${OUT}`);
