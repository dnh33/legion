// Cost of pointer moves with the Relic stage present (SMIL paused in both builds so only the pointer path is measured).
//   node pointer-sweep.mjs <base|new> [moves]
import { startEnv, openPage } from './env.mjs';
const which = process.argv[2] || 'new'; const moves = Number(process.argv[3] || 400);
const env = await startEnv({ ui: which === 'base' ? '/tmp/m/u-base/dist-ui' : '/tmp/m/wt-u/dist-ui', repo: '/tmp/m/wt-u', port: 48600 });
const { browser, page, cdp, errs } = await openPage(env);
await page.evaluate(() => document.querySelectorAll('svg').forEach((s) => s.pauseAnimations?.()));
await page.waitForTimeout(500);
const get = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const a = await get(); const t0 = Date.now();
for (let i = 0; i < moves; i++) {
  const t = i / moves;
  await page.mouse.move(300 + 900 * Math.abs(Math.sin(t * 9)), 120 + 650 * Math.abs(Math.cos(t * 7)));
  await page.waitForTimeout(4);
}
const b = await get(); const wall = (Date.now() - t0) / 1000; const d = (k) => b[k] - a[k];
console.log(JSON.stringify({ build: which, moves, wallS: +wall.toFixed(2), taskMs: +(d('TaskDuration') * 1000).toFixed(0), styleMs: +(d('RecalcStyleDuration') * 1000).toFixed(0), recalcs: d('RecalcStyleCount'), layouts: d('LayoutCount'), layoutMs: +(d('LayoutDuration') * 1000).toFixed(0) }), errs);
await browser.close(); await env.stop(); process.exit(0);
