// Relic stage cost per state: main-thread busy % (CDP TaskDuration, no tracing) and compositor draws/s (CDP trace,
// viz "Display::DrawAndSwap") for the nine states, driven through the Mascot Lab (Ctrl+Shift+M) against a real core.
//   node mascot-perf.mjs <label> <dist-ui dir> [seconds=5] [port=49500] [states,comma]
// Prints one JSON line per state and a final JSON object. The temp home is deleted by env.stop().
import fs from 'node:fs';
import { startEnv, openPage, busyPct } from './env.mjs';
const [label, ui, secsArg, portArg, statesArg] = process.argv.slice(2);
const secs = Number(secsArg || 5) * 1000; const port = Number(portArg || 49500);
const repo = process.env.LEGION_REPO || '/tmp/m/wt-m';
const STATES = (statesArg || 'idle,listening,thinking,hacking,awaiting,victory,error,sleeping,annoyed').split(',');
const env = await startEnv({ ui, repo, port, home: `/tmp/m/m-home-${port}` });
const { browser, page, cdp, errs } = await openPage(env, { scheme: 'dark' });
const bcdp = await browser.newBrowserCDPSession();
const procCpu = async () => { const r = await bcdp.send('SystemInfo.getProcessInfo'); let t = 0; for (const p of r.processInfo) t += p.cpuTime; return t; };
await page.keyboard.press('Control+Shift+M'); await page.waitForSelector('.lab');
async function draws(ms) {
  const events = [];
  const onData = (e) => events.push(...e.value);
  cdp.on('Tracing.dataCollected', onData);
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['viz', 'cc', 'benchmark', 'disabled-by-default-devtools.timeline'] }, transferMode: 'ReportEvents' });
  await page.waitForTimeout(ms);
  await cdp.send('Tracing.end'); await done; cdp.off('Tracing.dataCollected', onData);
  return +(events.filter((e) => e.name === 'Display::DrawAndSwap' && e.ph !== 'E').length / (ms / 1000)).toFixed(1);
}
const out = {};
for (const st of STATES) {
  await page.click(`.lab-grid button:text-is("${st}")`);
  await page.waitForTimeout(2500);
  const c0 = await procCpu(); const w0 = Date.now();
  const b = await busyPct(page, cdp, secs);
  const cpu = Math.round(((await procCpu()) - c0) / ((Date.now() - w0) / 1000) * 100);
  const d = await draws(secs);
  const info = await page.evaluate(() => { const svgs = [...document.querySelectorAll('.mascot-stage .mx-layer > svg')]; const mx = document.querySelector('.mascot-stage .mx'); return { state: mx?.dataset.state, nativeSmilPlaying: svgs.some((s) => !s.animationsPaused() && s.querySelector('animate,animateTransform,animateMotion')), clock: mx?.__mx ? mx.__mx.motion.tracks + ' tracks @' + mx.__mx.motion.hz + 'Hz' : 'native SMIL' }; });
  out[st] = { busy: b.busy, cpu, style: b.style, recalcPerS: b.recalcPerS, layoutPerS: b.layoutPerS, drawsPerS: d, ...info };
  console.log(label, st, JSON.stringify(out[st]));
}
if (errs.length) out.errs = errs;
fs.mkdirSync('/tmp/m/m-work', { recursive: true });
fs.appendFileSync('/tmp/m/m-work/mascot-perf.jsonl', JSON.stringify({ label, ui, at: new Date().toISOString(), out }) + '\n');
await browser.close(); await env.stop(); process.exit(0);
