// BSV UI screenshots and measurements. Dev tool, NOT part of `npm test` (needs Playwright + Chromium).
// A REAL core on a random port with LEGION_HOME under /tmp/m/wt-bs-home-shots, a FAKE wallet on a random loopback port (never the
// real one on 3321), stderr dropped, everything killed at the end. The window bridge (window.legion.bsvPolicy) is emulated by this
// script, which holds the native secret the way the Electron main process would; no dialog is shown here (the emulation tests cover that).
// Usage: node test-perf/bsv-ui/shots.mjs <outDir>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchChromium } from '../../scripts/lib/load-playwright.mjs';

process.env.PLAYWRIGHT_PATH ||= '/opt/node-tools/node_modules/playwright';
const OUT = process.argv[2] || '/tmp/m/bs-shots';
fs.mkdirSync(OUT, { recursive: true });
const REPO = path.resolve(new URL('../..', import.meta.url).pathname);
const HOME = '/tmp/m/wt-bs-home-shots';
const ADMIN = 'a'.repeat(64);
const NATIVE = 'b'.repeat(64);
const TOKEN = 't'.repeat(40);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

// ---- the fake wallet: answers the four harmless questions, records every call, can be switched to mainnet
const wallet = { network: 'testnet', height: 1234567, calls: [] };
const walletServer = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    wallet.calls.push(`${req.method} ${req.url} ${b}`);
    const m = (req.url || '').slice(1);
    const j = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (m === 'getVersion') return j({ version: 'fake-wallet 0.0.1' });
    if (m === 'getNetwork') return j({ network: wallet.network });
    if (m === 'isAuthenticated') return j({ authenticated: true });
    if (m === 'getHeight') return j({ height: wallet.height });
    res.writeHead(404); res.end('{}');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => walletServer.once('listening', r));
const walletPort = walletServer.address().port;
if (walletPort === 3321) throw new Error('refusing to run: the fake wallet landed on the real wallet port');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
const PORT = 48400 + Math.floor(Math.random() * 400);
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ port: PORT, authToken: TOKEN, bsv: { enabled: true, network: 'testnet', walletUrl: `http://127.0.0.1:${walletPort}` } }));
const core = spawn('node', [path.join(REPO, 'dist/src/bin/legion-core.js')], { env: { ...process.env, LEGION_HOME: HOME, LEGION_PORT: String(PORT), LEGION_ADMIN_STDIN: '1' }, stdio: ['pipe', 'ignore', 'ignore'] });
core.stdin.end(ADMIN + '\n' + NATIVE + '\n');
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 150)); }

const uiDir = path.join(REPO, 'dist-ui');
const uiServer = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(uiDir, p);
  if (!f.startsWith(uiDir) || !fs.existsSync(f)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream'); res.end(fs.readFileSync(f));
}).listen(PORT + 1000, '127.0.0.1');
const uiUrl = `http://127.0.0.1:${PORT + 1000}/index.html`;

const H = (native) => ({ Authorization: `Bearer ${TOKEN}`, 'X-Legion-Admin': ADMIN, 'Content-Type': 'application/json', ...(native ? { 'X-Legion-Native': NATIVE } : {}) });
const call = async (method, p, body, native = false) => { const r = await fetch(base + p, { method, headers: H(native), body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const routes = { arm: ['/api/bsv/policy/arm', (a) => ({ minutes: a.minutes })], disarm: ['/api/bsv/policy/disarm', () => ({})], freeze: ['/api/bsv/policy/freeze', () => ({ reason: 'frozen by the owner' })], unfreeze: ['/api/bsv/policy/unfreeze', () => ({})] };
const bridgeLog = [];

const results = {};
let browser;
try {
  browser = await launchChromium();
  for (const scheme of ['dark', 'light']) {
    await call('POST', '/api/bsv/policy/disarm', {}, true); await call('POST', '/api/bsv/policy/unfreeze', {}, true);
    wallet.network = 'testnet';
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: scheme });
    await ctx.exposeFunction('__bsvBridge', async (a) => { bridgeLog.push(a.kind); const r = routes[a.kind]; if (!r) return { ok: false, error: 'unknown' }; const x = await call('POST', r[0], r[1](a), true); return x.status === 200 ? { ok: true, view: x.json } : { ok: false, error: x.json.error }; });
    await ctx.addInitScript(({ b, t, a, theme }) => {
      try { localStorage.setItem('legion.theme', theme); } catch { /* ignore */ }
      window.__timers = [];
      const si = window.setInterval.bind(window); const ci = window.clearInterval.bind(window);
      window.setInterval = (fn, ms, ...r) => { const id = si(fn, ms, ...r); window.__timers.push({ id, ms, live: true }); return id; };
      window.clearInterval = (id) => { for (const t of window.__timers) if (t.id === id) t.live = false; return ci(id); };
      window.legion = { baseUrl: b, token: t, admin: a, platform: 'win32', openExternal() {}, bsvPolicy: (x) => window.__bsvBridge(x), onBsvChanged: () => () => undefined };
    }, { b: base, t: TOKEN, a: ADMIN, theme: scheme });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(uiUrl);
    await page.waitForSelector('.titlebar');
    await page.waitForSelector('.chain-overlay', { timeout: 15000 });
    await page.waitForTimeout(900);
    const shot = (n) => page.screenshot({ path: `${OUT}/${scheme}-${n}.png` });
    const anims = () => page.evaluate(() => document.getAnimations().filter((a) => { const t = a.effect?.target; return t && t.closest && t.closest('.chain-overlay, .live-border, .bsv-pill, .bsv-panel'); }).length);
    const live = () => page.evaluate(() => window.__timers.filter((t) => t.live).map((t) => t.ms).sort((x, y) => x - y));
    const R = (results[scheme] = {});

    await shot('1-testnet-idle');
    R.testnetTicker = await page.locator('.chain-ticker').innerText().catch(() => null);
    R.animsIdle = await anims();
    R.timersIdle = await live();

    await page.getByRole('button', { name: 'Open the BSV panel' }).click();
    await page.waitForSelector('.bsv-panel'); await page.waitForTimeout(500);
    await shot('2-panel-testnet');
    R.panelWallet = await page.locator('[data-wallet]').innerText();
    R.animsPanel = await anims();
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);

    // arm (the bridge stands in for main's confirmation)
    await page.getByRole('button', { name: 'Open the BSV panel' }).click();
    await page.waitForSelector('.bsv-panel');
    await page.getByRole('button', { name: /Arm LIVE FUNDS/ }).click();
    await page.waitForSelector('.live-border', { timeout: 8000 });
    await page.waitForTimeout(1300);
    await shot('3-armed-panel');
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    await shot('4-armed');
    R.armedTicker = await page.locator('.chain-ticker').innerText().catch(() => null);
    R.pill = await page.locator('.bsv-pill').innerText();
    R.freezeVisible = await page.getByRole('button', { name: 'Freeze chain' }).isVisible();
    R.animsArmed = await anims();
    R.timersArmed = await live();
    const c1 = await page.locator('.bsv-count').innerText(); await page.waitForTimeout(2100); const c2 = await page.locator('.bsv-count').innerText();
    R.countdown = [c1, c2];

    // freeze from the pill
    await page.getByRole('button', { name: 'Freeze chain' }).click();
    await page.waitForSelector('.bsv-pill.frozen', { timeout: 8000 }); await page.waitForTimeout(400);
    await shot('5-frozen');
    R.timersFrozen = await live();
    R.borderGone = (await page.locator('.live-border').count()) === 0;

    // a wallet on mainnet while Legion is on testnet
    await call('POST', '/api/bsv/policy/unfreeze', {}, true);
    wallet.network = 'main';
    await page.reload(); await page.waitForSelector('.bsv-pill', { timeout: 15000 }); await page.waitForTimeout(600);
    await shot('6-wallet-mainnet');
    R.mainnetPill = await page.locator('.bsv-pill').innerText();
    R.mainnetTicker = await page.locator('.chain-ticker').innerText().catch(() => null);
    R.borderOnMainnetWarning = (await page.locator('.live-border').count());
    await page.getByRole('button', { name: 'Details' }).click(); await page.waitForSelector('.bsv-panel'); await page.waitForTimeout(500);
    await shot('7-panel-mainnet');
    await page.evaluate(() => { const b = document.querySelector('.modal-body'); if (b) b.scrollTop = b.scrollHeight; }); await page.waitForTimeout(300);
    await shot('7b-panel-activity');
    R.auditText = await page.locator('[data-audit]').innerText();
    R.logRows = await page.locator('.bsv-log li').count();
    await ctx.close();

    // a narrow window while armed
    wallet.network = 'testnet';
    await call('POST', '/api/bsv/policy/arm', { minutes: 5 }, true);
    const ctx2 = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1, colorScheme: scheme });
    await ctx2.addInitScript(({ b, t, a, theme }) => { try { localStorage.setItem('legion.theme', theme); } catch { /* ignore */ } window.legion = { baseUrl: b, token: t, admin: a, platform: 'win32', openExternal() {} }; }, { b: base, t: TOKEN, a: ADMIN, theme: scheme });
    const p2 = await ctx2.newPage(); await p2.goto(uiUrl); await p2.waitForSelector('.live-border', { timeout: 15000 }); await p2.waitForTimeout(700);
    await p2.screenshot({ path: `${OUT}/${scheme}-8-armed-narrow.png` });
    R.noBridgeFreezeText = await p2.getByRole('button', { name: 'Freeze chain' }).isVisible();
    await ctx2.close();
    R.errors = errs;
  }
  results.walletCalls = [...new Set(wallet.calls.map((c) => c.replace(/\d+$/, '')))];
  results.bridgeCalls = bridgeLog;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  const exited = new Promise((r) => core.once('exit', r)); core.kill('SIGTERM'); setTimeout(() => core.kill('SIGKILL'), 3000).unref();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 4000))]);
  uiServer.close(); walletServer.close();
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 1));
process.exit(0);
