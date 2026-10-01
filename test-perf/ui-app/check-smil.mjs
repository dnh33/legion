// Assertions for the stage SMIL / Ops-closed work.   node check-smil.mjs <base|new>   (exit 1 on failure; base is expected to fail)
import assert from 'node:assert/strict';
import { startEnv, openPage } from './env.mjs';
const which = process.argv[2] || 'new';
const env = await startEnv({ ui: which === 'base' ? '/tmp/m/u-base/dist-ui' : '/tmp/m/wt-u/dist-ui', repo: '/tmp/m/wt-u', port: 48500 });
const { browser, page, errs } = await openPage(env);
const smil = () => page.evaluate(() => { const v = [...document.querySelectorAll('.mascot-stage .mx-layer > svg')]; return v.length ? (v.every((s) => s.animationsPaused()) ? 'paused' : v.some((s) => s.animationsPaused()) ? 'mixed' : 'playing') : 'none'; });
const results = []; let failed = 0;
const check = async (name, fn) => { try { await fn(); results.push(`ok   ${name}`); } catch (e) { failed++; results.push(`FAIL ${name}: ${String(e.message).split('\n')[0]}`); } };
const force = async (st) => { await page.click(`.lab-grid button:text-is("${st}")`); await page.waitForTimeout(2200); };
await page.keyboard.press('Control+Shift+M'); await page.waitForSelector('.lab');
await check('idle: SMIL paused', async () => assert.equal(await smil(), 'paused'));
for (const st of ['thinking', 'hacking', 'awaiting', 'victory', 'error']) await check(`${st}: SMIL playing`, async () => { await force(st); assert.equal(await smil(), 'playing'); });
for (const st of ['listening', 'sleeping', 'annoyed', 'idle']) await check(`${st}: SMIL paused`, async () => { await force(st); assert.equal(await smil(), 'paused'); });
await check('window blur pauses SMIL while thinking, focus resumes it', async () => {
  await force('thinking'); assert.equal(await smil(), 'playing');
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); assert.equal(await smil(), 'paused');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); assert.equal(await smil(), 'playing');
});
await check('document hidden pauses SMIL while thinking, visible resumes it', async () => {
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await smil(), 'paused');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await smil(), 'playing');
});
await check('Ops closed: the stage is not mounted (no .mx, no SMIL root)', async () => {
  await page.keyboard.press('Control+.'); await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.ops-slot .mx').length), 0);
});
await check('Ops reopened: the stage is back (lab still forces thinking, so SMIL plays)', async () => {
  await page.keyboard.press('Control+.'); await page.waitForTimeout(1200);
  const n = await page.evaluate(() => document.querySelectorAll('.ops-slot .mx').length); assert.equal(n, 1, 'mx count ' + n);
  assert.equal(await smil(), 'playing');
});
console.log(results.join('\n')); if (errs.length) console.log('page errors', errs);
await browser.close(); await env.stop(); process.exit(failed ? 1 : 0);
