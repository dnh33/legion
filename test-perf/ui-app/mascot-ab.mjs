// Back-to-back, interleaved A/B of the Relic stage per state on the same VM: main-thread busy % (CDP TaskDuration), total browser CPU %
// (all Chromium processes: renderer main + raster threads + GPU/viz, software raster here) and compositor draws/s (CDP trace), median of N rounds.
//   node mascot-ab.mjs <uiA> <uiB> [rounds=3] [secs=4] [states,comma] [labelA=base] [labelB=new]
// Both builds run against one real core each (temp homes under /tmp/m/m-home-*, deleted on exit). Results go to stdout as JSON and a table.
import fs from 'node:fs';
import { startEnv, openPage, busyPct } from './env.mjs';
const [uiA, uiB, roundsArg, secsArg, statesArg, labA = 'base', labB = 'new'] = process.argv.slice(2);
const rounds = Number(roundsArg || 3); const ms = Number(secsArg || 4) * 1000;
const STATES = (statesArg || 'idle,listening,thinking,hacking,awaiting,victory,error,sleeping,annoyed').split(',');
const repo = process.env.LEGION_REPO || '/tmp/m/wt-m';
const mk = async (ui, port) => {
  const env = await startEnv({ ui, repo, port, home: `/tmp/m/m-home-${port}` });
  const o = await openPage(env, { scheme: 'dark' });
  await o.page.keyboard.press('Control+Shift+M'); await o.page.waitForSelector('.lab');
  o.env = env; o.bcdp = await o.browser.newBrowserCDPSession();
  return o;
};
const A = await mk(uiA, 49510); const B = await mk(uiB, 49520);
async function sample(o, st) {
  const { page, cdp, bcdp } = o;
  await page.click(`.lab-grid button:text-is("${st}")`); await page.waitForTimeout(1800);
  const procs = async () => { const r = await bcdp.send('SystemInfo.getProcessInfo'); let t = 0; for (const p of r.processInfo) t += p.cpuTime; return t; };
  const c0 = await procs(); const w0 = Date.now();
  const b = await busyPct(page, cdp, ms);
  const cpu = (await procs() - c0) / ((Date.now() - w0) / 1000) * 100;
  const events = []; const onData = (e) => events.push(...e.value); cdp.on('Tracing.dataCollected', onData);
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['viz', 'cc', 'benchmark', 'disabled-by-default-devtools.timeline'] }, transferMode: 'ReportEvents' });
  await page.waitForTimeout(3000); await cdp.send('Tracing.end'); await done; cdp.off('Tracing.dataCollected', onData);
  const draws = events.filter((e) => e.name === 'Display::DrawAndSwap' && e.ph !== 'E').length / 3;
  return { busy: b.busy, cpu: +cpu.toFixed(0), draws: +draws.toFixed(1), layout: b.layoutPerS };
}
const res = { [labA]: {}, [labB]: {} };
for (let r = 0; r < rounds; r++) {
  for (const st of STATES) {
    for (const [lab, o] of r % 2 === 0 ? [[labA, A], [labB, B]] : [[labB, B], [labA, A]]) {
      const s = await sample(o, st); ((res[lab][st] ||= []).push(s));
      console.log(`r${r + 1} ${lab.padEnd(6)} ${st.padEnd(10)} ${JSON.stringify(s)}`);
    }
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const table = {};
for (const lab of [labA, labB]) for (const st of STATES) { const v = res[lab][st]; (table[st] ||= {})[lab] = { busy: med(v.map((x) => x.busy)), cpu: med(v.map((x) => x.cpu)), draws: med(v.map((x) => x.draws)) }; }
console.log('\nstate        busy% ' + labA + ' -> ' + labB + '   total cpu% ' + labA + ' -> ' + labB + '   draws/s');
for (const st of STATES) { const t = table[st]; console.log(`${st.padEnd(11)} ${String(t[labA].busy).padStart(5)} -> ${String(t[labB].busy).padStart(5)}    ${String(t[labA].cpu).padStart(5)} -> ${String(t[labB].cpu).padStart(5)}    ${t[labA].draws} -> ${t[labB].draws}`); }
fs.mkdirSync('/tmp/m/m-work', { recursive: true });
fs.appendFileSync('/tmp/m/m-work/mascot-ab.jsonl', JSON.stringify({ at: new Date().toISOString(), uiA, uiB, rounds, res, table }) + '\n');
for (const o of [A, B]) { await o.browser.close(); await o.env.stop(); }
process.exit(0);
