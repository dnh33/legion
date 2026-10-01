// One shared SSE connection: counts connections at the proxy while visiting every view, reconnects once after a drop, and checks
// that every subscriber (library inbox, lattice stats, store) still reacts to a pushed event.   node check-sse.mjs <base|new> [fetch|eventsource]
import assert from 'node:assert/strict';
import { startEnv, openPage } from './env.mjs';
const which = process.argv[2] || 'new'; const mode = process.argv[3] || 'fetch';
const env = await startEnv({ ui: which === 'base' ? '/tmp/m/u-base/dist-ui' : '/tmp/m/wt-u/dist-ui', repo: '/tmp/m/wt-u', port: 48800 });
const res = []; let failed = 0;
const check = async (n, f) => { try { await f(); res.push('ok   ' + n); } catch (e) { failed++; res.push('FAIL ' + n + ': ' + String(e.message).split('\n')[0]); } };
// eventsource mode: a plain browser tab (no admin key, ?base=&token=)
const opened = mode === 'eventsource'
  ? await (async () => { const o = await openPage(env, { init: () => { delete window.legion; } }); return o; })()
  : await openPage(env);
let { browser, page } = opened;
if (mode === 'eventsource') { await page.goto(`${env.uiUrl}?base=${encodeURIComponent(env.base)}&token=${env.token}`); await page.waitForSelector('.titlebar'); await page.waitForTimeout(1500); }
const live = async () => (await env.stat()).sse;
await check(`${mode}: chat view holds exactly one SSE connection`, async () => assert.equal(await live(), 1, `live SSE = ${await live()}`));
await page.click('.tb-view[title="Rooms"]'); await page.waitForTimeout(1200);
await check('rooms view: still one', async () => assert.equal(await live(), 1, `live SSE = ${await live()}`));
await page.click('.tb-view[title^="Library"]'); await page.waitForSelector('.lib'); await page.waitForTimeout(2000);
await check('library/lattice view: still one', async () => assert.equal(await live(), 1, `live SSE = ${await live()}`));
await check('a kg.updated event reaches the library inbox and the lattice (both refetch)', async () => {
  const before = await env.stat();
  await env.emit({ type: 'kg.updated', nodeCount: 1, edgeCount: 0, changed: [] }); await page.waitForTimeout(1200);
  const after = await env.stat();
  const d = (p) => (after.apiCalls[p] || 0) - (before.apiCalls[p] || 0);
  assert.ok(d('/api/kg/inbox') >= 1, 'inbox refetch ' + d('/api/kg/inbox'));
  assert.ok(d('/api/kg/stats') >= 1, 'lattice refetch ' + d('/api/kg/stats'));
});
await check('a mascot event reaches the store (stage state follows)', async () => {
  await page.click('.tb-view[title="Chat"]'); await page.waitForTimeout(500);
  await env.emit({ type: 'mascot', mood: 'hacking', note: 'x' }); await page.waitForTimeout(2600);
  assert.equal(await page.evaluate(() => document.querySelector('.ops-slot .mx')?.dataset.state), 'hacking');
});
await check('after the server drops the stream: reconnects, again exactly one connection', async () => {
  const o0 = (await env.stat()).sseOpened;
  await fetch(`${env.base}/__dropsse`);
  await page.waitForTimeout(3500);
  const st = await env.stat();
  assert.equal(st.sse, 1, `live SSE = ${st.sse}`);
  assert.equal(st.sseOpened - o0, 1, `reconnects = ${st.sseOpened - o0}`);
  await env.emit({ type: 'mascot', mood: 'thinking', note: 'y' }); await page.waitForTimeout(2600);
  assert.equal(await page.evaluate(() => document.querySelector('.ops-slot .mx')?.dataset.state), 'thinking');
});
const st = await env.stat();
res.push(`total SSE connections opened over the run: ${st.sseOpened} (live now ${st.sse})`);
console.log(res.join('\n'));
await browser.close(); await env.stop(); process.exit(failed ? 1 : 0);
