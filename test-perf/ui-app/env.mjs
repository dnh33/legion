// Perf harness for the UI-app fixes: a real core (admin secret over stdin, BSV mode on), a reverse proxy that counts
// SSE connections and can inject synthetic events (POST /__emit), serving the built UI from the same origin.
// Usage: const env = await startEnv({ ui: '/path/to/dist-ui', repo: '/path/to/repo' }); ... await env.stop();
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchChromium } from '../../scripts/lib/load-playwright.mjs';
import { isCorePath, proxyToCore, serveStatic } from '../lib/same-origin.mjs';

process.env.PLAYWRIGHT_PATH ||= '/opt/node-tools/node_modules/playwright';
export const SECRET = 'a'.repeat(64);

export async function startEnv({ ui, repo, port = 48100, home = `/tmp/m/u-home-${port}-${process.pid}`, seedHome = '/tmp/m/perf-uiapp-home' }) {
  fs.rmSync(home, { recursive: true, force: true });
  fs.cpSync(seedHome, home, { recursive: true });
  const cfgPath = path.join(home, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.workspaceDir = path.join(home, 'workspaces');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const token = cfg.authToken;
  const up = port, proxyPort = port + 1;
  const core = spawn('node', [path.join(repo, 'dist/src/bin/legion-core.js')], {
    env: { ...process.env, LEGION_HOME: home, LEGION_PORT: String(up), LEGION_ADMIN_STDIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  core.stdin.write(SECRET + '\n');
  let clog = ''; core.stderr.on('data', (d) => { clog += d; });
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://127.0.0.1:${up}/health`); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }

  const sse = new Set(); const stats = { sseOpened: 0, apiCalls: {} };
  // ONE origin for the UI and the API (../lib/same-origin.mjs): the core's guard refuses a UI served from a second port.
  // The proxy also counts SSE connections and can inject synthetic events (POST /__emit).
  const proxy = http.createServer((req, res) => {
    if (req.url === '/__stat') { res.end(JSON.stringify({ sse: sse.size, ...stats })); return; }
    if (req.url === '/__dropsse') { for (const r of [...sse]) r.destroy(); res.end('ok'); return; }
    if (req.url === '/__emit' && req.method === 'POST') {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { for (const e of [].concat(JSON.parse(b))) for (const r of sse) r.write(`data: ${JSON.stringify(e)}\n\n`); res.end('ok'); }); return;
    }
    const p = req.url.split('?')[0];
    if (!isCorePath(p)) { serveStatic(ui, req, res); return; }
    stats.apiCalls[p] = (stats.apiCalls[p] || 0) + 1;
    proxyToCore(up, req, res, () => {
      if (req.url.startsWith('/api/events') && req.method === 'GET') { if (process.env.DBG) console.log('SSE open', Date.now() % 100000, req.headers['x-legion-admin'] ? 'admin' : 'noadmin', req.headers['user-agent']?.slice(0, 20)); sse.add(res); stats.sseOpened++; res.on('close', () => sse.delete(res)); }
    });
  }).listen(proxyPort, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 200));
  const base = `http://127.0.0.1:${proxyPort}`;
  return {
    base, token, uiUrl: `${base}/index.html`, home,
    stat: async () => (await fetch(`${base}/__stat`)).json(),
    emit: (e) => fetch(`${base}/__emit`, { method: 'POST', body: JSON.stringify(e) }),
    core: () => clog,
    async stop() {
      const exited = new Promise((r) => core.once('exit', r)); core.kill('SIGTERM'); setTimeout(() => core.kill('SIGKILL'), 3000).unref();
      proxy.closeAllConnections?.(); proxy.close(); await Promise.race([exited, new Promise((r) => setTimeout(r, 4000))]);
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

export async function openPage(env, { width = 1440, height = 900, dpr = 1, scheme = 'dark', args = [], init } = {}) {
  const browser = await launchChromium({ args: ['--enable-precise-memory-info', ...args] });
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, colorScheme: scheme });
  await ctx.addInitScript(({ base, token, admin }) => {
    window.legion = { baseUrl: base, token, admin, platform: 'win32', openExternal() {} };
  }, { base: env.base, token: env.token, admin: SECRET });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto(env.uiUrl);
  await page.waitForSelector('.titlebar');
  await page.waitForTimeout(1500);
  return { browser, ctx, page, cdp, errs };
}

export async function busyPct(page, cdp, ms) {
  const get = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const a = await get(); const t0 = Date.now(); await page.waitForTimeout(ms); const b = await get(); const wall = (Date.now() - t0) / 1000;
  const d = (k) => b[k] - a[k];
  return { busy: +(100 * d('TaskDuration') / wall).toFixed(1), script: +(100 * d('ScriptDuration') / wall).toFixed(1), style: +(100 * d('RecalcStyleDuration') / wall).toFixed(1), recalcPerS: +(d('RecalcStyleCount') / wall).toFixed(1), layoutPerS: +(d('LayoutCount') / wall).toFixed(1) };
}
