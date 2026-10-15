// Rehearsal-only: what a user on the REAL published 0.3.0 meets when they reopen Legion while a full-package update is being prepared.
// The 0.3.0 install is the baseline; its own (frozen) swap helper does the work; the candidate is the full package built from this checkout,
// served from loopback through the stepping-stone layout (second manifest name), exactly as a 0.3.0 client reads a real full release.
//   reopen-reexec  the owner's clicked path. Auto-install is OFF. The window's own admin key (used over the DevTools protocol of the installed
//                  app) POSTs /api/update/install, the way the Update button does; the app applies it when idle (the native "restart now" dialog
//                  cannot be driven from outside, and it shares the same helper). The helper logs "re-running the swap helper ...": Legion is
//                  reopened --reopen-at seconds after that line (once the first app is gone). Then: is the install whole, what does the outcome
//                  say, how many Legion instances run; and a RETRY (install again, no reopen) must land the candidate.
//   auto-away      autoInstallWhenIdle is ON (the owner's setting), nobody clicks. Legion is reopened --reopen-at seconds after the old app is
//                  gone (or never: the control). Records the end state, then waits to see whether the update lands LATER with no action at all
//                  (does the app retry by itself after the reopen, and when).
// Gating (the job fails): the install is whole (byte-identical to 0.3.0, or the complete new package), user data survived, no swap left half done,
// at most one Legion instance at the end, and for reopen-reexec the retry lands the candidate. What the first attempt does and whether auto-install
// self-heals are REPORTED, not gated: they are the findings.
// The only difference from a user's PC is the environment the installed app is started with (isolated LEGION_HOME, the loopback stand-in for
// GitHub through scripts/rehearsal/preload.mjs, a DevTools port). No installed file is edited and no src/ file knows about any of it.
// usage: node run-reopen.mjs --scenario reopen-reexec|auto-away --reopen-at <seconds|never> --install <dir> --prepared <dir> --work <dir> --baseline <version>
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { args, die } from '../lib/release-lib.mjs';

const a = args(process.argv.slice(2), { scenario: 'v', 'reopen-at': 'v', install: 'v', prepared: 'v', work: 'v', baseline: 'v' });
for (const k of ['scenario', 'reopen-at', 'install', 'prepared', 'work', 'baseline']) if (!a[k]) die(`--${k} is required`);
if (!['reopen-reexec', 'auto-away'].includes(a.scenario)) die('--scenario must be reopen-reexec or auto-away');
const reopenAt = a['reopen-at'] === 'never' ? null : Number(a['reopen-at']);
if (reopenAt !== null && !(reopenAt >= 0)) die('--reopen-at must be a number of seconds or "never"');
const clicked = a.scenario === 'reopen-reexec';
const here = dirname(fileURLToPath(import.meta.url));
const install = resolve(a.install), work = resolve(a.work), preparedDir = resolve(a.prepared);
const prepared = { ...JSON.parse(readFileSync(join(preparedDir, 'prepared.json'), 'utf8')), pubKeyFile: join(preparedDir, 'legion-update-k1.pub.pem') };
const PORT = 18443, APP_PORT = 4747, CDP = 9333;
const good = prepared.versions.good;
const label = `${a.scenario}${reopenAt === null ? '-never' : `-${reopenAt}s`}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (m) => console.log(`[+${String(Math.round((Date.now() - T0) / 1000)).padStart(4)}s ${new Date().toISOString().slice(11, 19)}] ${m}`);
const problems = [], findings = [];
const check = (ok, msg) => { if (ok) log(`ok    ${msg}`); else { problems.push(msg); log(`FAIL  ${msg}`); } };
const finding = (msg) => { findings.push(msg); log(`FINDING ${msg}`); };

mkdirSync(work, { recursive: true });
const home = join(work, 'home'), art = join(work, 'artifacts');
for (const d of [home, art, join(home, 'updater')]) mkdirSync(d, { recursive: true });
writeFileSync(join(home, 'updater', 'settings.json'), JSON.stringify({ checkEnabled: true, autoInstallWhenIdle: !clicked, intervalHours: 1 }));
writeFileSync(join(home, 'rehearsal-marker.txt'), 'user data that must survive an update\n');
const control = join(work, 'control.txt'); writeFileSync(control, 'none');
const serveLog = join(art, 'serve.log');
const up = join(install, '.update');
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const sha = (p) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(p).on('data', (c) => h.update(c)).on('error', rej).on('end', () => res(h.digest('hex'))); });
async function tree(root) {
  const out = {};
  const walk = async (d, rel) => {
    for (const n of readdirSync(d).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      if (r === '.update') continue;
      const p = join(d, n); const st = statSync(p);
      if (st.isDirectory()) await walk(p, r);
      else { try { out[r] = `${st.size}:${await sha(p)}`; } catch (e) { out[r] = `${st.size}:unreadable(${e.code})`; } }
    }
  };
  await walk(root, '');
  return out;
}
const diff = (x, y) => { const d = []; for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (x[k] !== y[k]) d.push(k); return d; };
async function health() { try { const r = await fetch(`http://127.0.0.1:${APP_PORT}/health`, { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() : null; } catch { return null; } }
async function waitFor(what, fn, ms, step = 1000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) { log(`timed out waiting for ${what}`); return null; } await sleep(step); } }
const ps = (cmd) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
const esc = (s) => s.replace(/'/g, "''");
function killInstalled() {
  ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like '${esc(install)}\\*' -or $_.ExecutablePath -like '${esc(tmpdir())}\\legion-apply-*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
}
/** Every process that runs from the install's runtime or from the helper's temp copy, sorted into what it is. */
function procs() {
  const r = ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like '${esc(install)}\\*' -or $_.ExecutablePath -like '${esc(tmpdir())}\\legion-apply-*') } | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)|$($_.CommandLine)" }`);
  const out = { mains: [], cores: [], helpers: [], children: [], other: [] };
  for (const line of (r.stdout ?? '').split(/\r?\n/).filter(Boolean)) {
    const [pid, exe, ...rest] = line.split('|'); const cmd = rest.join('|');
    const p = { pid: Number(pid), exe, cmd: cmd.slice(0, 160) };
    if (exe.toLowerCase().includes('legion-apply-') || /apply\.mjs/.test(cmd)) out.helpers.push(p);
    else if (/--type=/.test(cmd)) out.children.push(p);
    else if (/legion-core/.test(cmd)) out.cores.push(p);
    else if (/\.m?js\b/.test(cmd)) out.other.push(p);
    else out.mains.push(p);
  }
  return out;
}

const children = [];
const env = {
  ...process.env, CI: '', LEGION_HOME: home, REHEARSAL_PORT: String(PORT), REHEARSAL_PUBKEY_FILE: prepared.pubKeyFile,
  NODE_OPTIONS: `--import ${pathToFileURL(join(here, 'preload.mjs')).href}`, REHEARSAL_DELAY_FILE: join(work, 'delay.txt'),
  ELECTRON_ENABLE_LOGGING: '1', ELECTRON_DISABLE_GPU: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const electron = join(install, 'runtime', 'electron', 'electron.exe');
const appLog = openSync(join(work, 'app.log'), 'a');
/** Starts the installed app the way a shortcut does (plus a DevTools port, so the window's own admin key can press the Update button). */
function launchApp(why) {
  const c = spawn(electron, [install, '--disable-gpu', '--disable-software-rasterizer', '--no-sandbox', '--disable-dev-shm-usage', `--remote-debugging-port=${CDP}`, '--remote-allow-origins=*'], { env, detached: true, stdio: ['ignore', appLog, appLog], windowsHide: true });
  c.unref();
  log(`started the installed app (${why}), pid ${c.pid}`);
  return c.pid;
}

/** The Update button's request, sent from inside the installed app's own window, which is the only holder of the admin key. */
async function windowCall(method, path, body) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${CDP}/json`, { signal: AbortSignal.timeout(3000) })).json();
    const page = targets.find((t) => t.type === 'page' && /^https?:\/\/127\.0\.0\.1/.test(t.url)) ?? targets.find((t) => t.type === 'page' && !/^devtools:/.test(t.url));
    if (!page?.webSocketDebuggerUrl) return { err: 'no window yet' };
    const expr = `(async()=>{const l=window.legion;if(!l||!l.admin)return {err:'no admin key in the window yet'};const r=await fetch(l.baseUrl+${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'x-legion-admin':l.admin,authorization:'Bearer '+l.token,'content-type':'application/json'}${method === 'GET' ? '' : `,body:${JSON.stringify(JSON.stringify(body ?? {}))}`}});let j=null;try{j=await r.json()}catch(e){};return {status:r.status,json:j}})()`;
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('devtools socket failed')); });
    const msg = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('devtools call timed out')), 20000);
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) { clearTimeout(t); res(m); } };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });
    try { ws.close(); } catch { /* gone */ }
    return msg.result?.result?.value ?? { err: msg.error?.message ?? msg.result?.exceptionDetails?.text ?? 'no value' };
  } catch (e) { return { err: e.message }; }
}

const applyLines = () => (existsSync(join(up, 'apply.log')) ? readFileSync(join(up, 'apply.log'), 'utf8').split('\n').filter(Boolean) : []);
const lineTs = (re, nth = 0) => { const l = applyLines().filter((x) => re.test(x))[nth]; const m = l?.match(/^\[([^\]]+)\]/); return m ? Date.parse(m[1]) : undefined; };
const rerunCount = () => applyLines().filter((l) => l.includes('re-running the swap helper')).length;
const outcome = () => readJson(join(up, 'outcome.json'));
const journal = () => readJson(join(up, 'journal.json'));
const landed = async () => { const h = await health(); const j = journal(); return h?.ok && h.version === good && j?.state === 'committed' && j?.to === good ? h : null; };

let before = {};
const timeline = {};
/** What the user is left with right now. */
async function snapshot(why) {
  const h = await health();
  const o = outcome(), j = journal(), p = procs();
  let intact = 'unknown';
  if (h?.version === a.baseline) { const d = diff(before, await tree(install)); intact = d.length ? `NO: ${d.slice(0, 4).join(', ')}` : 'byte-identical to the baseline'; }
  else if (h?.version === good) {
    const list = readJson(join(preparedDir, 'served', 'stone', 'PACKAGE-FILES.json')); const wrong = [];
    for (const f of list?.files ?? []) { try { if ((await sha(join(install, ...f.path.split('/')))) !== f.sha256) wrong.push(f.path); } catch { wrong.push(f.path); } }
    intact = !list ? 'unknown: no package list' : wrong.length ? `NO: ${wrong.length} file(s) differ: ${wrong.slice(0, 4).join(', ')}` : 'equals the new package';
  }
  const data = existsSync(join(home, 'rehearsal-marker.txt')) && readFileSync(join(home, 'rehearsal-marker.txt'), 'utf8').startsWith('user data') ? 'survived' : 'LOST';
  const s = { why, version: h?.version ?? null, intact, data, journal: j?.state ?? null, outcome: o?.result ?? null, reason: o?.reason ?? null, mains: p.mains.length, cores: p.cores.length, helpers: p.helpers.length, others: p.other.length };
  log(`SNAPSHOT ${why}: running ${s.version ?? 'nothing answering'}; install ${intact}; data ${data}; journal ${s.journal}, outcome ${s.outcome}${s.reason ? ` (${s.reason})` : ''}; instances: ${s.mains} app, ${s.cores} core, ${s.helpers} helper, ${s.others} other node`);
  return s;
}

function writeResult(extra) {
  const res = { scenario: a.scenario, label, reopenAt: a['reopen-at'], baseline: a.baseline, candidate: good, timeline, findings, problems, ...extra };
  writeFileSync(join(art, 'result.json'), JSON.stringify(res, null, 2));
  return res;
}

let final = null, first = null; const extra = {};
try {
  log(`${label}: baseline ${a.baseline} installed at ${install}; ${clicked ? 'clicked path (auto-install off)' : 'auto-install on'}; reopen ${reopenAt === null ? 'never' : `${reopenAt}s after ${clicked ? 'the swap helper starts re-running' : 'the old app is gone'}`}`);
  check(readJson(join(install, 'build-info.json'))?.version === a.baseline, `the install is ${a.baseline}`);
  before = await tree(install);
  log(`baseline tree hashed: ${Object.keys(before).length} files`);
  children.push(spawn(process.execPath, [join(here, 'serve.mjs'), '--served', join(preparedDir, 'served'), '--control', control, '--port', String(PORT), '--log', serveLog], { stdio: 'ignore', windowsHide: true }));
  await waitFor('the fake release server', async () => existsSync(serveLog), 15000);
  writeFileSync(control, 'stone'); // the stepping-stone layout: a 0.3.0 client reads the second name and is offered the full candidate
  launchApp('baseline');
  const h0 = await waitFor('the baseline app to answer /health', async () => { const h = await health(); return h?.ok ? h : null; }, 180000);
  check(!!h0 && h0.version === a.baseline, `the installed ${a.baseline} starts and reports health (got ${h0?.version})`);
  if (!h0) throw new Error('the baseline never became healthy');

  // ---- first attempt ----
  const press = async () => !!(await waitFor('the window to offer the update and take the Update click', async () => {
    const st = await windowCall('GET', '/api/update/status');
    if (!st?.json) return null;
    if (st.json.staged?.version === good && st.json.consent) return true;
    if (!st.json.available) return null;
    const r = await windowCall('POST', '/api/update/install');
    log(`Update pressed: HTTP ${r?.status ?? r?.err}`);
    return r?.status === 200 ? true : null;
  }, 6 * 60_000, 5000));
  let viaWindow = clicked;
  if (clicked) {
    if (!(await press())) {
      finding('the DevTools route to the window did not work; falling back to auto-install so the run still reports the reopen');
      writeFileSync(join(home, 'updater', 'settings.json'), JSON.stringify({ checkEnabled: true, autoInstallWhenIdle: true, intervalHours: 1 }));
      viaWindow = false;
    } else log('the update is staged and approved (the Update click)');
  }
  extra.path = viaWindow ? 'clicked (Update pressed in the window)' : 'auto-install';

  let reopened = false, sawGone = false;
  const base = () => (clicked ? timeline.rerunAt : timeline.goneAt);
  const result1 = await (async () => {
    const end = Date.now() + 15 * 60_000;
    for (;;) {
      const h = await health();
      if (timeline.rerunAt === undefined) { const t = lineTs(/re-running the swap helper/); if (t) { timeline.rerunAt = t; log('the helper logged "re-running the swap helper" (the copy of the runtime starts; nothing on screen)'); } }
      if (!sawGone && h === null && (timeline.rerunAt !== undefined || existsSync(join(up, 'run', 'job.json')))) { sawGone = true; timeline.goneAt = Date.now(); log('the old Legion is gone'); }
      if (!reopened && reopenAt !== null && sawGone && base() !== undefined && Date.now() >= base() + reopenAt * 1000 && procs().mains.length === 0) {
        reopened = true; timeline.reopenAt = Date.now();
        log(`reopening Legion ${Math.round((timeline.reopenAt - base()) / 1000)}s after ${clicked ? 'the helper log line' : 'the old app was gone'}`);
        launchApp('the user reopens Legion');
      }
      const o = outcome();
      if (o && (o.result === 'failed' || o.result === 'rolled-back')) return { kind: o.result, o };
      if (await landed()) return { kind: 'landed' };
      if (Date.now() > end) return { kind: 'timeout' };
      await sleep(500);
    }
  })();
  timeline.firstDoneAt = Date.now();
  const applyAt = lineTs(new RegExp(`apply ${a.baseline.replace(/\./g, '\\.')} -> ${good.replace(/\./g, '\\.')}`));
  if (timeline.rerunAt && applyAt) { timeline.copySeconds = Math.round((applyAt - timeline.rerunAt) / 1000); log(`the runtime copy took ${timeline.copySeconds}s on this runner (the owner's PC: 36s)`); }
  log(`first attempt: ${result1.kind}${result1.o?.reason ? ` (${result1.o.reason})` : ''}`);
  await sleep(result1.kind === 'landed' ? 20_000 : 10_000); // let a relaunched app and a loser at the single-instance lock settle
  first = await snapshot(`after the first attempt (${result1.kind})`);
  extra.first = { kind: result1.kind, reason: result1.o?.reason ?? null, reopened, snapshot: first };
  check(first.intact !== 'unknown' && !String(first.intact).startsWith('NO'), `the install is whole after the first attempt (${first.intact})`);
  check(first.data === 'survived', 'user data survived the first attempt');
  check(first.journal !== 'swapping', 'no swap was left half done');

  // ---- what happens next ----
  if (result1.kind === 'timeout') check(false, 'the first attempt never settled within 15 minutes');
  else if (result1.kind === 'landed') finding(`the first attempt landed ${good}${reopened ? ' even though Legion was reopened during it' : ' (no reopen)'}`);
  else {
    finding(`the first attempt ended as ${result1.kind}${result1.o?.reason ? `: "${result1.o.reason}"` : ''}; the install is ${first.intact}; running ${first.version}; ${first.mains} app instance(s) left`);
    const failedAt = Date.now();
    if (clicked) {
      // The reopened app forgot its stage (memory only). Does it keep, or re-find, the update without a click?
      const st = await windowCall('GET', '/api/update/status');
      log(`status in the reopened app: staged=${JSON.stringify(st?.json?.staged ?? null)}, consent=${st?.json?.consent}, available=${st?.json?.available?.version ?? null}, outcome=${st?.json?.outcome?.result ?? null}`);
      extra.afterFailStatus = { staged: st?.json?.staged ?? null, consent: st?.json?.consent ?? null, available: st?.json?.available?.version ?? null, outcomeShown: st?.json?.outcome?.result ?? null };
      timeline.retryPressedAt = Date.now();
      check(await press(), 'the retry: Update is pressed again in the reopened app and the update is staged'); // install again, NO reopen
      const n0 = rerunCount();
      const res = await waitFor(`the retry to land ${good}`, landed, 15 * 60_000, 2000);
      timeline.retryDoneAt = Date.now();
      check(!!res, `the retry lands ${good} (health reports it, journal committed)`);
      if (res) finding(`the retry (no reopen) landed ${good} ${Math.round((timeline.retryDoneAt - timeline.retryPressedAt) / 1000)}s after Update was pressed`);
      extra.retrySwaps = rerunCount() - n0;
    } else {
      // Nobody clicks and nobody reopens again. Does the update land later by itself?
      log('waiting up to 14 minutes to see whether the update lands later with no action at all');
      const n0 = rerunCount();
      let sawRetry = false;
      const res = await waitFor(`a later automatic attempt to land ${good}`, async () => {
        if (!sawRetry && rerunCount() > n0) { sawRetry = true; timeline.autoRetryAt = Date.now(); log(`the app started a second attempt by itself ${Math.round((Date.now() - failedAt) / 1000)}s after the failure`); }
        return landed();
      }, 14 * 60_000, 2000);
      extra.selfHealed = !!res; extra.selfHealSeconds = res ? Math.round((Date.now() - failedAt) / 1000) : null;
      if (res) finding(`SELF-HEALS: with no action, the update landed ${good} ${extra.selfHealSeconds}s after the failed attempt (a second attempt by the app itself: ${sawRetry ? 'seen' : 'not seen'})`);
      else finding(`STUCK: 14 minutes after the failed attempt the install still runs ${(await health())?.version ?? 'nothing'}; the app did not complete the update by itself`);
    }
  }
  if (await landed()) {
    await waitFor('the relaunched app to settle to one instance', async () => (procs().mains.length === 1 ? true : null), 90_000, 3000);
    await waitFor('the old copy to be cleaned', async () => !existsSync(join(up, 'prev')), 120_000);
  }
  await sleep(5000);
  final = await snapshot('final');
  check(final.intact !== 'unknown' && !String(final.intact).startsWith('NO'), `the install is whole at the end (${final.intact})`);
  check(final.data === 'survived', 'user data survived');
  check(final.journal !== 'swapping', 'no swap left half done at the end');
  check(final.mains <= 1, `at most one Legion app instance at the end (${final.mains})`);
  check(final.cores <= 1, `at most one Legion core at the end (${final.cores})`);
  if (final.version === good) check(final.journal === 'committed', 'the final journal says committed');
} catch (e) {
  problems.push(`the scenario stopped: ${e.message}`); log(`FAIL  the scenario stopped: ${e.stack || e.message}`);
} finally {
  try { if (!final) final = await snapshot('final (after a stop)'); } catch { /* best effort */ }
  const res = writeResult({ first, final, ...extra });
  try { for (const [from, to] of [[join(up, 'apply.log'), 'apply.log'], [join(up, 'journal.json'), 'journal.json'], [join(up, 'outcome.json'), 'outcome.json'], [join(home, 'updater', 'state.json'), 'updater-state.json'], [join(work, 'app.log'), 'app.log']]) if (existsSync(from)) cpSync(from, join(art, to)); } catch { /* best effort */ }
  try { cpSync(join(home, 'logs'), join(art, 'logs'), { recursive: true }); } catch { /* no logs folder */ }
  try { for (const n of readdirSync(home)) if (/^core\.log/.test(n)) cpSync(join(home, n), join(art, n)); } catch { /* none */ }
  killInstalled();
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  // the logs of the installed copy: every error or warning line is printed (owner rule), nothing is hidden
  try {
    const seen = new Set();
    for (const d of [join(home, 'logs'), home]) {
      let names = []; try { names = readdirSync(d); } catch { continue; }
      for (const n of names) {
        if (!/\.(log|txt)$/i.test(n) && !/^core\.log/.test(n)) continue;
        let t = ''; try { if (!statSync(join(d, n)).isFile()) continue; t = readFileSync(join(d, n), 'utf8'); } catch { continue; }
        for (const l of t.split('\n')) if (/\b(error|warn(ing)?|fatal|unhandled|EBUSY|EPERM|ENOENT)\b/i.test(l)) seen.add(`${n}: ${l.trim().slice(0, 240)}`);
      }
    }
    log(`LOGS: ${seen.size} error/warning line(s) in the installed copy's logs`);
    for (const l of [...seen].slice(0, 60)) log(`LOG   ${l}`);
  } catch { /* best effort */ }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const f = res.first?.kind ? `${res.first.kind}${res.first.reason ? ` ("${res.first.reason}")` : ''}` : '-';
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### ${label}: ${problems.length ? 'FAILED' : 'passed'}\n| scenario | reopen | first attempt | final version | data | Legion apps left |\n|---|---|---|---|---|---|\n| ${a.scenario} | ${reopenAt === null ? 'never' : `+${reopenAt}s`} | ${f} | ${final?.version ?? 'none'} | ${final?.data ?? '-'} | ${final?.mains ?? '-'} app, ${final?.cores ?? '-'} core |\n\n${findings.map((x) => `- ${x}`).join('\n')}\n${problems.map((p) => `- PROBLEM: ${p}`).join('\n')}\n`);
  }
}
if (problems.length) { console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`); process.exit(1); }
console.log(`\n${label}: passed`);
