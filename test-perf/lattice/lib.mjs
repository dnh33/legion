// Shared by measure.mjs and pixeldiff.mjs: start a core, launch Chromium with the API credentials injected.
import { spawn } from 'node:child_process'; import path from 'node:path'; import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function startCore(root, env = {}) {
  const child = spawn(process.execPath, [path.join(here, 'core.mjs')], { env: { ...process.env, ROOT: root, ...env }, stdio: ['pipe', 'pipe', 'ignore'] }); // stderr dropped on purpose: a test core must never leave an unbounded log
  process.on('exit', () => child.kill());
  const cfg = await new Promise((res, rej) => { let buf = ''; child.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) res(JSON.parse(buf.slice(0, i))); }); child.on('exit', (c) => rej(new Error('core exited ' + c))); });
  return { cfg, stop: () => child.kill() };
}
export async function launch(root, cfg, { dpr = 1, init = true } = {}) {
  const { launchChromium } = await import(pathToFileURL(path.join(root, 'scripts/lib/load-playwright.mjs')).href);
  const browser = await launchChromium({ args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: dpr });
  await ctx.addInitScript((c) => { window.legion = { baseUrl: c.core, token: c.token, admin: c.admin, platform: 'win32', openExternal() {} }; }, cfg);
  return { browser, ctx };
}
export const arg = (name, d) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : d; };
