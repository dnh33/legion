// Title-bar layout check: screenshots of the real built UI at several widths with the Doctor chip in both states, plus geometry asserts
// (the BSV ticker never overlaps the search box, the view tabs or the right-hand cluster; the search box keeps its left edge; every icon
// button is clickable, i.e. the element at its centre is the button itself). Dev tool, NOT part of `npm test` (needs Playwright + Chromium).
// A REAL core on a random port with a temp LEGION_HOME (BSV mode on, no wallet configured: nothing is ever contacted), killed at the end.
// Usage: node test-perf/ui-app/titlebar-shots.mjs <outDir> [dist-ui dir]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchChromium } from '../../scripts/lib/load-playwright.mjs';

process.env.PLAYWRIGHT_PATH ||= '/opt/node-tools/node_modules/playwright';
const OUT = process.argv[2] || '/tmp/m/tb-shots';
fs.mkdirSync(OUT, { recursive: true });
const REPO = path.resolve(new URL('../..', import.meta.url).pathname);
const uiDir = path.resolve(process.argv[3] || path.join(REPO, 'dist-ui'));
const HOME = `/tmp/m/wt-tb-home-${process.pid}`;
const ADMIN = 'a'.repeat(64), TOKEN = 't'.repeat(40);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const PORT = 48800 + Math.floor(Math.random() * 400);
if (PORT === 3321) throw new Error('refusing to use the wallet port');
fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ port: PORT, authToken: TOKEN, bsv: { enabled: true, network: 'testnet' } }));
const core = spawn('node', [path.join(REPO, 'dist/src/bin/legion-core.js')], { env: { ...process.env, LEGION_HOME: HOME, LEGION_PORT: String(PORT), LEGION_ADMIN_STDIN: '1' }, stdio: ['pipe', 'ignore', 'ignore'] });
core.stdin.end(ADMIN + '\n');
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 150)); }
const uiServer = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(uiDir, p);
  if (!f.startsWith(uiDir) || !fs.existsSync(f)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream'); res.end(fs.readFileSync(f));
}).listen(PORT + 1000, '127.0.0.1');
const uiUrl = `http://127.0.0.1:${PORT + 1000}/index.html`;

const DOCTOR = { ok: [{ id: 'node', label: 'Node', ok: true, detail: 'ok' }], bad: [{ id: 'node', label: 'Node', ok: true, detail: 'ok' }, { id: 'boat', label: 'boat.dev key', ok: false, detail: 'missing', fix: 'add it' }] };
const rect = (r) => r && { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) };
const overlap = (a, b) => a && b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const out = []; let failed = 0;
const check = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
let browser;
try {
  browser = await launchChromium();
  for (const width of [960, 1100, 1280, 1440, 1920]) for (const state of ['ok', 'bad']) for (const platform of ['win32', 'darwin']) {
    if (platform === 'darwin' && state === 'ok') continue;
    const ctx = await browser.newContext({ viewport: { width, height: 700 }, deviceScaleFactor: 1, colorScheme: 'dark' });
    await ctx.addInitScript(({ b, t, a, pf }) => { window.legion = { baseUrl: b, token: t, admin: a, platform: pf, openExternal() {} }; }, { b: base, t: TOKEN, a: ADMIN, pf: platform });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    // the real Doctor answer arrives AFTER first paint (it runs the checks), so the chip grows once the ticker was already placed: answer late on purpose
    await page.route('**/api/doctor', async (r) => { await new Promise((x) => setTimeout(x, 1200)); await r.fulfill({ json: DOCTOR[state] }); });
    await page.goto(uiUrl);
    await page.waitForSelector('.tb-doctor.' + (state === 'bad' ? 'bad' : 'good'), { timeout: 15000 });
    await page.waitForSelector('.chain-overlay', { timeout: 15000 });
    await page.waitForTimeout(700);
    const tag = `${width}-${state}${platform === 'darwin' ? '-mac' : ''}`;
    await page.screenshot({ path: `${OUT}/${tag}.png`, clip: { x: 0, y: 0, width, height: 80 } });
    const g = await page.evaluate(() => {
      const q = (s) => document.querySelector(s)?.getBoundingClientRect();
      const R = (r) => r && { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      const btn = (el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { name: el.getAttribute('aria-label') || el.className, hit: !!hit && (hit === el || el.contains(hit)) }; };
      const bar = document.querySelector('.titlebar');
      return {
        search: R(q('.tb-search')), right: R(q('.tb-right')), views: R(q('.tb-views')), brand: R(q('.tb-brand')), ticker: R(q('.chain-ticker')), tickerText: document.querySelector('.chain-ticker')?.innerText ?? null,
        searchLabelShown: !!document.querySelector('.tb-search span') && getComputedStyle(document.querySelector('.tb-search span')).display !== 'none',
        buttons: [...document.querySelectorAll('.tb-right button, .tb-search')].filter((e) => e.getClientRects().length).map(btn),
        barScroll: bar.scrollWidth - bar.clientWidth, pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tickerSpan: [...document.querySelectorAll('.chain-ticker span')].map((s) => { const r = s.getBoundingClientRect(); return { l: r.left, r: r.right, sw: s.scrollWidth, cw: s.clientWidth }; }),
      };
    });
    const C = (r) => r && { l: r.left, r: r.right, t: r.top, b: r.bottom };
    const t = C(g.ticker);
    // the ticker text (not its box) must not touch search, right-hand cluster
    const tickText = g.tickerSpan.length ? { l: Math.min(...g.tickerSpan.map((s) => s.l)), r: Math.max(...g.tickerSpan.map((s) => s.r)), t: 0, b: 40 } : null;
    console.log(`-- ${tag}  ticker=${JSON.stringify(g.tickerText)} search=${JSON.stringify(rect(g.search))} right.left=${Math.round(g.right.left)} views=${Math.round(g.views.left)}..${Math.round(g.views.right)}`);
    if (tickText) {
      check(!overlap(tickText, C(g.search)), `${tag}: ticker text clear of the search box`);
      check(!overlap(tickText, C(g.right)), `${tag}: ticker text clear of the right-hand cluster (views, status, Doctor, icons)`);
      check(!overlap(tickText, C(g.views)), `${tag}: ticker text clear of the view tabs`);
    } else console.log(`   (ticker hidden at this width)`);
    check(g.buttons.every((b) => b.hit), `${tag}: every title-bar button is hit-testable at its centre (${g.buttons.filter((b) => !b.hit).map((b) => b.name).join(', ') || 'all'})`);
    check(g.barScroll <= 0 && g.pageScroll <= 0, `${tag}: no horizontal overflow (bar ${g.barScroll}, page ${g.pageScroll})`);
    check(g.search.right <= g.right.left + 0.5, `${tag}: search box ends before the right-hand cluster`);
    out.push({ tag, searchLeft: Math.round(g.search.left), searchRight: Math.round(g.search.right), ticker: g.tickerText });
    check(errs.length === 0, `${tag}: no page errors ${errs.join(';')}`);
    await ctx.close();
  }
  // the search box keeps its position whatever the Doctor chip says (same width, same platform)
  for (const w of [960, 1100, 1280, 1440, 1920]) {
    const a = out.find((o) => o.tag === `${w}-ok`), b = out.find((o) => o.tag === `${w}-bad`);
    check(a.searchLeft === b.searchLeft, `${w}: search left edge ${a.searchLeft} (ok) vs ${b.searchLeft} (1 to fix)`);
  }
} finally {
  await browser?.close();
  core.kill('SIGTERM'); setTimeout(() => core.kill('SIGKILL'), 2000).unref();
  uiServer.close();
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
