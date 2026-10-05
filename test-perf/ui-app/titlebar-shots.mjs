// Title-bar layout check: screenshots of the real built UI at several widths with the Doctor chip in both states, plus geometry asserts
// (the BSV ticker never overlaps the search box, the view tabs or the right-hand cluster; the search box keeps its left edge; every icon
// button is clickable, i.e. the element at its centre is the button itself; the Beta mark is shown, unclipped, inside the brand and
// hoverable at every width, dark and light). Dev tool, NOT part of `npm test` (needs Playwright + Chromium).
// A REAL core on a random port with a temp LEGION_HOME (BSV mode on, no wallet configured: nothing is ever contacted), killed at the end.
// Usage: node test-perf/ui-app/titlebar-shots.mjs <outDir> [dist-ui dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { launchChromium } from '../../scripts/lib/load-playwright.mjs';
import { serveSameOrigin } from '../lib/same-origin.mjs';

process.env.PLAYWRIGHT_PATH ||= '/opt/node-tools/node_modules/playwright';
const OUT = process.argv[2] || path.join(os.tmpdir(), 'tb-shots');
fs.mkdirSync(OUT, { recursive: true });
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const uiDir = path.resolve(process.argv[3] || path.join(REPO, 'dist-ui'));
const HOME = path.join(os.tmpdir(), `wt-tb-home-${process.pid}`);
const ADMIN = 'a'.repeat(64), TOKEN = 't'.repeat(40);
const PORT = 48800 + Math.floor(Math.random() * 400);
if (PORT === 3321) throw new Error('refusing to use the wallet port');
fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ port: PORT, authToken: TOKEN, bsv: { enabled: true, network: 'testnet' } }));
const core = spawn('node', [path.join(REPO, 'dist/src/bin/legion-core.js')], { env: { ...process.env, LEGION_HOME: HOME, LEGION_PORT: String(PORT), LEGION_ADMIN_STDIN: '1' }, stdio: ['pipe', 'ignore', 'ignore'] });
core.stdin.end(ADMIN + '\n');
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 150)); }
// UI and API on ONE origin (test-perf/lib/same-origin.mjs): a second port is a foreign origin the core's guard refuses.
const ui = await serveSameOrigin({ uiDir, corePort: PORT });
const uiUrl = ui.uiUrl;

const DOCTOR = { ok: [{ id: 'node', label: 'Node', ok: true, detail: 'ok' }], bad: [{ id: 'node', label: 'Node', ok: true, detail: 'ok' }, { id: 'boat', label: 'boat.dev key', ok: false, detail: 'missing', fix: 'add it' }] };
const rect = (r) => r && { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) };
const overlap = (a, b) => a && b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const out = []; let failed = 0;
const check = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
let browser;
try {
  browser = await launchChromium();
  for (const width of [960, 1100, 1280, 1440, 1920]) for (const state of ['ok', 'bad']) for (const platform of ['win32', 'darwin']) for (const theme of ['dark', 'light']) {
    if (platform === 'darwin' && (state === 'ok' || theme === 'light')) continue;
    const ctx = await browser.newContext({ viewport: { width, height: 700 }, deviceScaleFactor: 1, colorScheme: theme });
    // the app's theme is its own setting (localStorage), not the OS preference, so set it the way the toggle does
    await ctx.addInitScript(({ b, t, a, pf, th }) => { window.legion = { baseUrl: b, token: t, admin: a, platform: pf, openExternal() {} }; try { localStorage.setItem('legion.theme', th); } catch { /* ignore */ } }, { b: ui.origin, t: TOKEN, a: ADMIN, pf: platform, th: theme });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    // a rig whose API calls fail still draws a title bar: count them, so a broken origin fails the run instead of passing it
    const apiFails = []; page.on('requestfailed', (r) => { if (r.url().includes('/api/')) apiFails.push(`${r.url().replace(/^https?:\/\/[^/]+/, '')} ${r.failure()?.errorText ?? ''}`); });
    page.on('response', (r) => { if (r.url().includes('/api/') && r.status() === 403) apiFails.push(`${r.url().replace(/^https?:\/\/[^/]+/, '')} 403`); });
    // the real Doctor answer arrives AFTER first paint (it runs the checks), so the chip grows once the ticker was already placed: answer late on purpose
    await page.route('**/api/doctor', async (r) => { await new Promise((x) => setTimeout(x, 1200)); await r.fulfill({ json: DOCTOR[state] }); });
    await page.goto(uiUrl);
    await page.waitForSelector('.tb-doctor.' + (state === 'bad' ? 'bad' : 'good'), { timeout: 15000 });
    await page.waitForSelector('.chain-overlay', { timeout: 15000 });
    await page.waitForTimeout(700);
    const tag = `${width}-${state}${platform === 'darwin' ? '-mac' : ''}${theme === 'light' ? '-light' : ''}`;
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
        theme: document.documentElement.dataset.theme,
        word: R(q('.tb-word')),
        beta: (() => {
          const el = document.querySelector('.tb-beta');
          if (!el) return null;
          const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          // what --warn resolves to in this theme, so "not the Doctor's failing colour" is measured, not assumed
          const probe = document.createElement('span'); probe.style.color = 'var(--warn)'; document.body.appendChild(probe);
          const warn = getComputedStyle(probe).color; probe.remove();
          return { box: R(r), shown: el.getClientRects().length > 0 && cs.display !== 'none' && cs.visibility !== 'hidden', text: el.textContent, title: el.getAttribute('title'),
            clipped: el.scrollWidth > el.clientWidth + 0.5, hit: !!hit && (hit === el || el.contains(hit)), color: cs.color, border: cs.borderTopColor, warn, region: cs.getPropertyValue('-webkit-app-region') };
        })(),
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
    check(g.theme === theme, `${tag}: rendered in the ${theme} theme (got ${g.theme})`);
    // the Beta mark: present, not clipped, inside the brand at every width, hoverable (nothing covers it, and it is no-drag)
    const b = g.beta;
    console.log(`   beta=${b ? JSON.stringify({ ...rect(b.box), color: b.color, region: b.region }) : 'MISSING'} brand=${JSON.stringify(rect(g.brand))} word.right=${Math.round(g.word.right)}`);
    check(!!b && b.shown && b.text === 'Beta' && /beta/i.test(b.title || ''), `${tag}: Beta mark shown, reads "Beta", carries its note`);
    if (b) {
      check(b.box.left >= g.brand.left - 0.5 && b.box.right <= g.brand.right + 0.5 && g.word.right <= g.brand.right + 0.5, `${tag}: Beta mark inside the brand (${Math.round(b.box.right)} <= ${Math.round(g.brand.right)})`);
      check(b.box.top >= 0 && b.box.bottom <= 40, `${tag}: Beta mark inside the 40px bar (${Math.round(b.box.top)}..${Math.round(b.box.bottom)})`);
      check(b.box.right <= g.search.left - 0.5, `${tag}: Beta mark ends before the search box`);
      check(!b.clipped, `${tag}: Beta label not clipped`);
      check(b.hit, `${tag}: Beta mark is the element at its centre, so its hover note can fire`);
      check(b.region === '' || b.region === 'no-drag', `${tag}: Beta mark is no-drag (computed ${JSON.stringify(b.region)})`);
      check(b.color !== b.warn && b.border !== b.warn, `${tag}: Beta mark is not in the warn colour (${b.color} vs warn ${b.warn})`);
    }
    out.push({ tag, searchLeft: Math.round(g.search.left), searchRight: Math.round(g.search.right), ticker: g.tickerText });
    check(errs.length === 0, `${tag}: no page errors ${errs.join(';')}`);
    check(apiFails.length === 0, `${tag}: every API call reached the core (${apiFails.slice(0, 3).join('; ')})`);
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
  ui?.close();
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
