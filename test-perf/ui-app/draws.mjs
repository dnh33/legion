// Compositor draws per second (CDP trace, viz "Display::DrawAndSwap") with Ops closed (no mascot), BSV chain overlay on and the Doctor heart forced into
// its healthy (beating) state.   node draws.mjs <base|new>
import { startEnv, openPage } from './env.mjs';
const which = process.argv[2] || 'new';
const env = await startEnv({ ui: which === 'base' ? '/tmp/m/u-base/dist-ui' : '/tmp/m/wt-u/dist-ui', repo: '/tmp/m/wt-u', port: 49000 });
const { browser, page, cdp, errs } = await openPage(env);
await page.keyboard.press('Control+.'); await page.waitForTimeout(800);
await page.evaluate(() => { const d = document.querySelector('.tb-doctor'); d.classList.remove('bad'); d.classList.add('good'); });
const chain = await page.evaluate(() => !!document.querySelector('.chain-overlay'));
async function draws(ms) {
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['viz', 'cc', 'benchmark', 'disabled-by-default-devtools.timeline'] }, transferMode: 'ReportEvents' });
  await page.waitForTimeout(ms);
  await cdp.send('Tracing.end'); await done; cdp.removeAllListeners('Tracing.dataCollected');
  const n = events.filter((e) => e.name === 'Display::DrawAndSwap' && e.ph !== 'E').length;
  return +(n / (ms / 1000)).toFixed(1);
}
const out = { chainOverlayPresent: chain };
out.focused = await draws(6000);
await page.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
await page.waitForTimeout(500);
out.blurred = await draws(6000);
console.log(JSON.stringify({ build: which, ...out, drawsPerSec: 'see focused/blurred' }), errs);
await browser.close(); await env.stop(); process.exit(0);
