/**
 * One-off docs/site screenshot pass: app-light (light theme, approval card), assayer-bsv (Assayer chat with the
 * current BSV truth), lattice-bsv (the BSV knowledge pack in the Lattice). Same stack as capture.mjs: real core,
 * fake model/wallet. Run: node docs/video-v2/capture/docs-shots.mjs <shot>  (SHOTS_OUT overrides the out dir).
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from '../../../scripts/lib/load-playwright.mjs';
import { startStack } from './stack.mjs';
import { runTask } from './seed.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.SHOTS_OUT || join(here, 'docs-shots');
mkdirSync(out, { recursive: true });
const want = new Set(process.argv.slice(2));
const on = (name) => want.size === 0 || want.has(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json ?? r.text)}`); return r.json; };

let stack = null;
let browser = null;
const cleanup = async () => { try { await browser?.close(); } catch { /* ignore */ } try { await stack?.stop(); } catch { /* ignore */ } };

async function openPage(s, light = false) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(({ base, token, admin, theme }) => {
    try { localStorage.setItem('legion.theme', theme); localStorage.setItem('legion.ops', '0'); localStorage.setItem('legion.bsv.confirmed', '1'); } catch { /* ignore */ }
    window.legion = { baseUrl: base, token, admin, platform: 'win32', openExternal() {}, bsvPolicy: async () => ({ ok: false, cancelled: true }), projectChange: async () => ({ ok: false, cancelled: true }) };
  }, { base: `http://127.0.0.1:${s.proxyPort}`, token: s.authToken, admin: s.adminSecret, theme: light ? 'light' : 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(s.pageUrl);
  await page.waitForSelector('.titlebar');
  await page.waitForSelector('.conn-online', { timeout: 15000 }).catch(() => { throw new Error('UI never went online'); });
  await sleep(700);
  return { ctx, page, errors };
}
const shot = async (page, name) => { await page.mouse.move(1, 1); await sleep(400); await page.screenshot({ path: join(out, `${name}.png`) }); console.log('wrote', `${name}.png`); };

async function main() {
  browser = await launchChromium();
  stack = await startStack();
  const s = stack;

  if (on('app-light')) {
    const prompt = 'Run the tests and fix whatever fails';
    const t = await runTask(s, 'forgemaster', prompt, [
      { say: 'I will look at the test setup first, then run the suite.' },
      { tool: 'Read', input: { file_path: 'package.json' } },
      { tool: 'Grep', input: { pattern: 'describe\\(', path: 'test' } },
      { say: 'Two test files, both use the same helper. Running the suite now.' },
      { tool: 'Bash', input: { command: 'npm test -- --reporter=dot' }, as: 'b' },
      { result: 'The suite ran. All tests pass.', costUsd: 0.05 }], { wait: false });
    await s.until(async () => ((await s.call('GET', '/api/approvals')).json ?? []).length > 0, 15000, 'approval card');
    const { ctx, page, errors } = await openPage(s, true);
    await page.getByText('Forgemaster', { exact: true }).first().click(); await sleep(700);
    await page.getByText(prompt).first().click().catch(() => undefined); await sleep(1800);
    await shot(page, 'app-light');
    console.log('errors', errors);
    await ctx.close();
    for (const a of (await s.call('GET', '/api/approvals')).json ?? []) await s.call('POST', `/api/approvals/${a.id}`, { allow: false });
    await s.until(async () => { const x = (await s.call('GET', `/api/tasks/${t.id}`)).json?.task; return x && ['done', 'error', 'cancelled'].includes(x.status); }, 15000, 'task end');
  }

  if (on('assayer-bsv') || on('lattice-bsv')) {
    ok(await s.call('POST', '/api/bsv', { enabled: true }), 'bsv on');
    ok(await s.call('POST', '/api/bsv/wallet/connect', { url: s.wallet.url }, 'native'), 'wallet connect (fake wallet)');
    if (on('assayer-bsv')) {
      const prompt = 'What does BSV mode do today, and what can you actually do for me?';
      const t = await runTask(s, 'assayer', prompt, [
        { say: 'Reading the BSV knowledge pack and the current policy.' },
        { tool: 'mcp__legion_kg__kg_recall', input: { query: 'BSV mode today' } },
        { say: 'BSV mode is on and the network is testnet. I can ask a wallet on this computer for a read-only status. There is one spend tool: it asks the wallet to pay only after you confirm it in native dialogs. Mainnet is built and OFF by default, so nothing can move funds without your confirmation.' },
        { result: 'That is the honest state of BSV mode today.', costUsd: 0.07 }]);
      console.log('assayer task:', t?.status, JSON.stringify(t).slice(0, 200));
      const log = await s.modelLog();
      const mine = log.filter((x) => String(x.prompt ?? '').includes('What does BSV mode do'));
      console.log('log entries:', mine.length, JSON.stringify(mine.map((x) => ({ text: String(x.text ?? x.result ?? '').slice(0, 90) }))));
      const { ctx, page, errors } = await openPage(s);
      await page.getByText('Assayer', { exact: true }).first().click(); await sleep(700);
      await page.getByText(prompt, { exact: false }).first().click().catch(() => undefined);
      await page.getByText('spend tool', { exact: false }).first().waitFor({ timeout: 20000 }).catch(() => console.log('final reply not rendered yet'));
      await sleep(1800);
      await shot(page, 'assayer-bsv');
      console.log('errors', errors);
      await ctx.close();
    }
    if (on('lattice-bsv')) {
      const { ctx, page, errors } = await openPage(s);
      await page.getByRole('tab', { name: /^Library/ }).click(); await sleep(1500);
      await page.getByRole('button', { name: 'Fit to view' }).click().catch(() => undefined); await sleep(1500);
      await page.mouse.move(1000, 520); await sleep(500);
      await shot(page, 'lattice-bsv');
      console.log('errors', errors);
      await ctx.close();
    }
  }
}

try { await main(); } catch (e) { console.error('FAILED:', e.stack || e); process.exitCode = 1; } finally { await cleanup(); }
