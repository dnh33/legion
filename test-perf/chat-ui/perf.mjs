// Before/after cost of the chat area: typing, streaming into a long thread, idle (with a held queue in the new build).
//   node test-perf/chat-ui/perf.mjs <ui-dir> [label]
import { startFake } from './harness.mjs';
import { openPage, sleep, until, composer, typeEnter } from './lib.mjs';

const ui = process.argv[2]; const label = process.argv[3] || ui;
const env = await startFake({ ui, repo: '/tmp/m/wt-chat', port: Number(process.env.PORT || 48660) });
// a long thread: 24 round trips of rich replies
let id;
for (let i = 0; i < 24; i++) {
  const t = env.engine.startTask({ agentId: 'zealot', prompt: `[md] question ${i}`, source: 'ui', ...(id ? { continueTaskId: id } : {}) });
  id = t.id; await env.engine.waitFor(id, 5000);
}
const { browser, page, errs } = await openPage(env);
const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
const get = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const measure = async (fn) => {
  const a = await get(); const t0 = Date.now(); await fn(); const wall = (Date.now() - t0) / 1000; const b = await get();
  const d = (k) => b[k] - a[k];
  return { secs: +wall.toFixed(1), busyPct: +(100 * d('TaskDuration') / wall).toFixed(1), scriptPct: +(100 * d('ScriptDuration') / wall).toFixed(1), layoutPerS: +(d('LayoutCount') / wall).toFixed(1), recalcPerS: +(d('RecalcStyleCount') / wall).toFixed(1), domNodes: Math.round(b.Nodes) };
};
await until(async () => (await page.locator('.thread .msg.assistant').count()) >= 20, 8000, 'long thread');
await page.locator('.thread-scroll').evaluate((e) => { e.scrollTop = e.scrollHeight; });
const out = { label, messages: await page.locator('.thread .msg').count() };
await sleep(800);
out.idle = await measure(() => sleep(6000));
await composer(page).click();
out.typing200 = await measure(async () => { await page.keyboard.type('the quick brown fox jumps over the lazy dog '.repeat(5).slice(0, 200), { delay: 25 }); });
await composer(page).fill('');
// streaming 50 deltas/s for 6 s into the open thread (real bus events, as the engine emits them)
const tid = id;
out.streaming50 = await measure(async () => {
  for (let i = 0; i < 300; i++) { env.bus.emit({ type: 'message.delta', taskId: tid, text: 'streamed token ' }); await sleep(20); }
});
env.bus.emit({ type: 'message.delta', taskId: tid, text: '' });
await sleep(500);
if (process.env.HELD_QUEUE) {
  // idle cost with a held queue on screen (restored after a reload): no timers or animation may run for it
  await page.evaluate((tid) => sessionStorage.setItem('legion.queue.v1', JSON.stringify({ v: 1, threads: { ['t:' + tid]: { items: ['one', 'two', 'three'].map((t, i) => ({ id: 'q' + i, text: t + ' queued message', model: 'auto', at: i })), hold: null } } })), tid);
  await page.reload(); await page.waitForSelector('[data-testid="queue-strip"]'); await sleep(1200);
  out.idleHeldQueue = await measure(() => sleep(6000));
}
console.log(JSON.stringify(out));
if (errs.length) console.log('page errors', errs);
await browser.close(); await env.stop();
