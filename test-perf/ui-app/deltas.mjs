// Streaming cost: N history messages in the open thread, then 100 message.delta events 20 ms apart (Ops closed, no mascot).
// Reports main-thread script / task ms PER DELTA and the number of store writes seen by the thread (DOM text mutations of the live bubble).
//   node deltas.mjs <base|new> [history=200]
import { startEnv, openPage } from './env.mjs';
const which = process.argv[2] || 'new'; const hist = Number(process.argv[3] || 200);
const env = await startEnv({ ui: which === 'base' ? '/tmp/m/u-base/dist-ui' : '/tmp/m/wt-u/dist-ui', repo: '/tmp/m/wt-u', port: 49100 });
const { browser, page, cdp, errs } = await openPage(env);
const now = new Date().toISOString();
const task = { id: 'tperf', agentId: 'zealot', title: 'perf', status: 'running', source: 'ui', requestedModel: 'auto', model: 'sonnet', costUsd: 0, turns: 1, createdAt: now, updatedAt: now };
await env.emit({ type: 'task.updated', task });
await page.waitForTimeout(300);
await page.click('.recent li button');
await page.waitForTimeout(300);
const md = (i) => `Reply **${i}** with \`code\` and a list:\n\n- one\n- two\n\n\`\`\`ts\nconst x = ${i};\n\`\`\`\n\nSee [docs](https://example.com/${i}).`;
const evs = [];
for (let i = 0; i < hist; i++) {
  const role = i % 2 ? 'assistant' : 'user';
  evs.push({ type: 'message', message: { id: `m${i}`, taskId: 'tperf', role, text: role === 'user' ? `question ${i}` : md(i), at: now } });
  if (i % 5 === 0) evs.push({ type: 'message', message: { id: `t${i}`, taskId: 'tperf', role: 'tool', toolName: 'Read', toolUseId: `u${i}`, text: JSON.stringify({ file_path: `src/a${i}.ts` }), at: now } });
}
for (let i = 0; i < evs.length; i += 50) await env.emit(evs.slice(i, i + 50));
await page.waitForTimeout(1500);
const msgs = await page.evaluate(() => document.querySelectorAll('.thread .msg').length);
await page.evaluate(() => { window.__mut = 0; new MutationObserver((l) => { window.__mut += l.length; }).observe(document.querySelector('.thread-inner'), { subtree: true, childList: true, characterData: true }); });
const get = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const a = await get(); const N = 100;
for (let i = 0; i < N; i++) { await env.emit({ type: 'message.delta', taskId: 'tperf', text: `token${i} lorem ipsum ` }); await page.waitForTimeout(20); }
await page.waitForTimeout(400);
const b = await get(); const d = (k) => b[k] - a[k];
const dDelta = { scriptMsPerDelta: +(d('ScriptDuration') * 1000 / N).toFixed(2), taskMsPerDelta: +(d('TaskDuration') * 1000 / N).toFixed(2), domMutations: await page.evaluate(() => window.__mut) };
// phase 2: 100 task.updated (cost ticking) with the same history: before, every bubble and every rail bust re-rendered per event
const c = await get();
for (let i = 0; i < N; i++) { await env.emit({ type: 'task.updated', task: { ...task, costUsd: i / 100, turns: i, updatedAt: new Date().toISOString() } }); await page.waitForTimeout(20); }
await page.waitForTimeout(300);
const e2 = await get(); const d2 = (k) => e2[k] - c[k];
console.log(JSON.stringify({ build: which, history: hist, renderedMsgs: msgs, deltas: N, delta: dDelta, taskUpdated: { scriptMsPerEvent: +(d2('ScriptDuration') * 1000 / N).toFixed(2), taskMsPerEvent: +(d2('TaskDuration') * 1000 / N).toFixed(2) } }), errs);
await browser.close(); await env.stop(); process.exit(0);
