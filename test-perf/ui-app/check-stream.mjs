// Delta coalescing keeps the core's order: deltas -> final message, deltas -> terminal task.updated, deltas for another task, task.deleted.
//   node check-stream.mjs <base|new>
import assert from 'node:assert/strict';
import { startEnv, openPage } from './env.mjs';
const which = process.argv[2] || 'new';
const env = await startEnv({ ui: which === 'base' ? '/tmp/m/u-base/dist-ui' : '/tmp/m/wt-u/dist-ui', repo: '/tmp/m/wt-u', port: 49200 });
const { browser, page, errs } = await openPage(env);
const now = new Date().toISOString();
const mk = (id, status) => ({ id, agentId: 'zealot', title: id, status, source: 'ui', requestedModel: 'auto', model: 'sonnet', costUsd: 0, turns: 1, createdAt: now, updatedAt: new Date().toISOString() });
await env.emit({ type: 'task.updated', task: mk('t1', 'running') }); await page.waitForTimeout(300);
await page.click('.recent li button'); await page.waitForTimeout(300);
const asst = () => page.evaluate(() => [...document.querySelectorAll('.thread .msg.assistant')].map((e) => e.textContent));
const res = []; let failed = 0;
const check = async (n, f) => { try { await f(); res.push('ok   ' + n); } catch (e) { failed++; res.push('FAIL ' + n + ': ' + String(e.message).split('\n')[0]); } };
await check('deltas appear as one live bubble within a frame or two', async () => {
  for (const t of ['Hel', 'lo ', 'wor', 'ld']) await env.emit({ type: 'message.delta', taskId: 't1', text: t });
  await page.waitForTimeout(250);
  const a = await asst(); assert.equal(a.length, 1); assert.ok(a[0].includes('Hello world'), JSON.stringify(a));
});
await check('final message right after deltas: live bubble replaced, nothing left over or duplicated', async () => {
  await env.emit({ type: 'message.delta', taskId: 't1', text: '!' });
  await env.emit({ type: 'message', message: { id: 'a1', taskId: 't1', role: 'assistant', text: 'Hello world!', at: now } });
  await page.waitForTimeout(400);
  const a = await asst(); assert.equal(a.length, 1, 'bubbles: ' + a.length); assert.ok(a[0].includes('Hello world!'));
  assert.equal(await page.evaluate(() => document.querySelectorAll('.thread .caret').length), 0, 'caret left');
});
await check('deltas then terminal task.updated: stream cleared', async () => {
  await env.emit({ type: 'message.delta', taskId: 't1', text: 'orphan' });
  await env.emit({ type: 'task.updated', task: mk('t1', 'done') });
  await page.waitForTimeout(400);
  const a = await asst(); assert.equal(a.length, 1, JSON.stringify(a));
});
await check('deltas for another task do not show in this thread', async () => {
  await env.emit({ type: 'message.delta', taskId: 'other', text: 'secret' }); await page.waitForTimeout(250);
  assert.equal((await asst()).length, 1);
});
await check('deltas then task.deleted: nothing resurrects', async () => {
  await env.emit({ type: 'message.delta', taskId: 't2', text: 'zzz' });
  await env.emit({ type: 'task.deleted', taskId: 't2' }); await page.waitForTimeout(400);
  assert.equal((await asst()).length, 1);
});
console.log(res.join('\n'), errs); await browser.close(); await env.stop(); process.exit(failed ? 1 : 0);
