// Rehearsal-only: drives ONE scenario against a throwaway install of a published release, on a CI runner.
//   success   the candidate (0.99.0) is staged, swapped in and reports healthy; user data survives; the old copy is cleaned
//   rollback  the candidate's first start fails (0.99.1): the previous version is restored byte for byte and the failed one is held back
//   locked    a file under node_modules is held open during the swap: the update is refused cleanly, the old version keeps running
//   slow-short / slow-long   the new build's core starts 25 s / 75 s late (past the app's 15 s wait, and for slow-long past the old
//             helper's 60 s window): whichever way it settles, the install is whole and runs (the new version, or the old one restored)
//   vanished-live  the same, but from the LIVE release: its own (older) helper does the swap, so the check below is not there yet.
//             Kept strict on purpose: a failure here is a finding about the live release, not something to bend the scenario around.
//   chain     the live release is updated by a CODE-ONLY candidate built from this checkout (0.98.0), then by the full-package
//             candidate (0.99.0): the second swap must be done by the NEW helper (its log line carries the helper stamp)
//   stone-walk   the stepping stone (docs/SHIPPING.md): the live release reads only the OLD manifest name, which carries a code-only stone; it goes to the
//             stone (done by its own old helper), and on its next check the stone, which reads the SECOND name, goes to the full candidate. Install
//             intact, data surviving, the second swap done by the NEW helper. Proves a 0.2.7 install never meets a full package with the old helper.
//   stone-stranded   the stone-era gap (docs/SHIPPING.md, Stepping stones): 0.2.7 -> the REAL v0.3.0 package -> a code-only release whose lock differs from
//             the stone's and that carries its own full package. The frozen 0.3.0 updater refuses the code package and must fall back to the full one;
//             a further code-only release with the same lock is then applied by the CODE route without downloading its carried full package.
//   stone-stranded-nofull   the same release without a fullAsset (what the old rule published): the stone install must end on a notice, running the stone.
//   stone-later   a code-only release published AFTER the full one (docs/SHIPPING.md): the old name still carries the stone, the second name the newer code-only
//             release. The live release reaches the stone through the old name, then the newest release through the second name.
//   stone-direct   a build from this checkout (the stone's updater, --baseline 0.98.0) goes straight to the full candidate through the second name
//   vanished  the staged runtime folder disappears after staging (an antivirus): the swap is refused before anything moves.
//             Run from a baseline built from this checkout (--baseline 0.98.0), because the swap is done by the helper of the
//             version being updated FROM, and a published release does not have this check yet.
// The installed app is started the way a shortcut starts it. The only difference from a user's PC is the environment it is started
// with: LEGION_HOME (an isolated data folder) and NODE_OPTIONS (scripts/rehearsal/preload.mjs, which sends GitHub traffic to the
// loopback server and trusts a throwaway key). No installed file is edited.
// usage: node run-scenario.mjs --scenario success|rollback|locked --install <dir> --prepared <dir> --work <dir> --baseline <version>
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { args, die, readZipEntry } from '../lib/release-lib.mjs';

const a = args(process.argv.slice(2), { scenario: 'v', install: 'v', prepared: 'v', work: 'v', baseline: 'v' });
for (const k of ['scenario', 'install', 'prepared', 'work', 'baseline']) if (!a[k]) die(`--${k} is required`);
if (!['success', 'rollback', 'locked', 'slow-short', 'slow-long', 'vanished', 'vanished-live', 'chain', 'stone-walk', 'stone-direct', 'stone-later', 'stone-stranded', 'stone-stranded-nofull'].includes(a.scenario)) die('--scenario must be success, rollback, locked, slow-short, slow-long, vanished, vanished-live, chain, stone-walk, stone-direct, stone-later, stone-stranded or stone-stranded-nofull');
const here = dirname(fileURLToPath(import.meta.url));
const install = resolve(a.install), work = resolve(a.work), preparedDir = resolve(a.prepared);
const prepared = { ...JSON.parse(readFileSync(join(preparedDir, 'prepared.json'), 'utf8')), pubKeyFile: join(preparedDir, 'legion-update-k1.pub.pem') };
const PORT = 18443, APP_PORT = 4747;
// The frozen v0.3.0 dependencyHash (src/core/updater/package.ts): the lock with its own version fields blanked out. The scenario job has no build, so it is copied here.
const dependencyHash = (lockJson) => {
  const sha256 = (b) => createHash('sha256').update(b).digest('hex');
  let parsed; try { parsed = JSON.parse(lockJson); } catch { return sha256(Buffer.from(lockJson, 'utf8')); }
  const clone = structuredClone(parsed); delete clone.version;
  if (clone.packages && typeof clone.packages === 'object' && clone.packages['']) { const e = { ...clone.packages[''] }; delete e.version; clone.packages[''] = e; }
  return sha256(Buffer.from(JSON.stringify(clone), 'utf8'));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const problems = [];
const check = (ok, msg) => { if (ok) log(`ok    ${msg}`); else { problems.push(msg); log(`FAIL  ${msg}`); } };

mkdirSync(work, { recursive: true });
const home = join(work, 'home'), art = join(work, 'artifacts');
for (const d of [home, art, join(home, 'updater')]) mkdirSync(d, { recursive: true });
writeFileSync(join(home, 'updater', 'settings.json'), JSON.stringify({ checkEnabled: true, autoInstallWhenIdle: true, intervalHours: 1 }));
writeFileSync(join(home, 'rehearsal-marker.txt'), 'user data that must survive an update\n');
const control = join(work, 'control.txt'); writeFileSync(control, 'none');
const delayFile = join(work, 'delay.txt');
const serveLog = join(art, 'serve.log');
const up = join(install, '.update');
const good = prepared.versions.good, bad = prepared.versions.bad;

const sha = (p) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(p).on('data', (c) => h.update(c)).on('error', rej).on('end', () => res(h.digest('hex'))); });
async function tree(root) {
  const out = {};
  const walk = async (d, rel) => {
    for (const n of readdirSync(d).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      if (r === '.update') continue;
      const p = join(d, n); const st = statSync(p);
      if (st.isDirectory()) await walk(p, r);
      else { try { out[r] = `${st.size}:${await sha(p)}`; } catch (e) { out[r] = `${st.size}:unreadable(${e.code})`; } } // a file this scenario holds open cannot be read
    }
  };
  await walk(root, '');
  return out;
}
let lockedRel = '';
const diff = (x, y) => { const d = []; for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (x[k] !== y[k] && k !== lockedRel) d.push(k); return d; };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
async function health() { try { const r = await fetch(`http://127.0.0.1:${APP_PORT}/health`, { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() : null; } catch { return null; } }
async function waitFor(what, fn, ms) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) { log(`timed out waiting for ${what}`); return null; } await sleep(2000); } }
const ps = (cmd) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
function killInstalled() {
  const esc = (s) => s.replace(/'/g, "''");
  ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like '${esc(install)}\\*' -or $_.ExecutablePath -like '${esc(tmpdir())}\\legion-apply-*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
}

const children = [];
const env = {
  ...process.env, CI: '', LEGION_HOME: home, REHEARSAL_PORT: String(PORT), REHEARSAL_PUBKEY_FILE: prepared.pubKeyFile,
  NODE_OPTIONS: `--import ${pathToFileURL(join(here, 'preload.mjs')).href}`, REHEARSAL_DELAY_FILE: delayFile,
  ELECTRON_ENABLE_LOGGING: '1', ELECTRON_DISABLE_GPU: '1',
};
delete env.ELECTRON_RUN_AS_NODE;

/** Lines worth a look in the installed copy's own logs. Printed in the run output; each one must be fixed, explained or listed by the reviewer. */
function scanLogs() {
  const found = [];
  const dirs = [join(home, 'logs'), home];
  for (const d of dirs) {
    let names = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!/\.(log|txt)$/i.test(n) && !/^core\.log/.test(n)) continue;
      let text = '';
      try { if (!statSync(join(d, n)).isFile()) continue; text = readFileSync(join(d, n), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) if (/\b(error|warn(ing)?|fatal|unhandled|EBUSY|EPERM|ENOENT)\b/i.test(line)) found.push(`${n}: ${line.trim().slice(0, 240)}`);
    }
  }
  const seen = [...new Set(found)];
  log(`LOGS: ${seen.length} error/warning line(s) in the installed copy's logs`);
  for (const l of seen.slice(0, 60)) log(`LOG   ${l}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n#### Installed copy's logs (${a.scenario}): ${seen.length} error/warning line(s)\n\`\`\`\n${seen.slice(0, 60).join('\n')}\n\`\`\`\n`);
}

/** One line per scenario for the reviewer: what ended up running, whether the install is whole, whether data survived, and which code decided. */
async function report() {
  const h = await health();
  const al = existsSync(join(up, 'apply.log')) ? readFileSync(join(up, 'apply.log'), 'utf8').split('\n').filter(Boolean) : [];
  const swaps = al.filter((l) => / apply \S+ -> \S+/.test(l)).map((l) => `${l.match(/apply \S+ -> \S+/)[0]} by ${l.includes('[helper:') ? 'NEW helper' : 'OLD helper (no stamp)'}`);
  const settle = al.filter((l) => l.includes('new build ')).map((l) => l.replace(/^\[[^\]]*\] /, ''));
  const j = readJson(join(up, 'journal.json')), o = readJson(join(up, 'outcome.json'));
  let intact = 'unknown';
  try {
    if (h?.version === a.baseline) { const d = diff(before, await tree(install)); intact = d.length ? `NO, differs from baseline: ${d.slice(0, 5).join(', ')}` : 'yes, byte-identical to the baseline'; }
    else if (h?.version === good || (a.scenario === 'stone-stranded' && h?.version === prepared.versions.stranded)) {
      // the stranded versions share numbers with other scenarios' candidates, so only that scenario reads its own list; a later hop (0.99.3) is a different package and reads as unknown
      const list = readJson(join(preparedDir, 'served', h.version === good ? 'good' : 'stone-stranded', 'PACKAGE-FILES.json')); const wrong = [];
      for (const f of list?.files ?? []) { try { if ((await sha(join(install, ...f.path.split('/')))) !== f.sha256) wrong.push(f.path); } catch { wrong.push(f.path); } }
      intact = wrong.length ? `NO, ${wrong.length} file(s) differ from the new package: ${wrong.slice(0, 5).join(', ')}` : 'yes, equals the new package';
    }
  } catch (e) { intact = `check failed: ${e.message}`; }
  const data = existsSync(join(home, 'rehearsal-marker.txt')) && readFileSync(join(home, 'rehearsal-marker.txt'), 'utf8').startsWith('user data') ? 'survived' : 'LOST';
  const line = `REPORT ${a.scenario}: running ${h?.version ?? 'nothing answering'}; install intact: ${intact}; data folder: ${data}; journal ${j?.state ?? '-'}, outcome ${o?.result ?? '-'}${o?.reason ? ` (${o.reason.slice(0, 120)})` : ''}; swap: ${swaps.join(' | ') || 'none'}; new build at start: ${settle.join(' | ') || 'nothing logged'}`;
  log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${line}\n`);
}

function collect() {
  try { cpSync(join(home, 'logs'), join(art, 'logs'), { recursive: true }); } catch { /* no logs folder */ }
  try { for (const n of readdirSync(home)) if (/^core\.log/.test(n)) cpSync(join(home, n), join(art, n)); } catch { /* none */ }
  try { cpSync(join(up, 'run', 'job.json'), join(art, 'job.json')); } catch { /* none */ }
  try { scanLogs(); } catch { /* best effort */ }
  for (const [from, to] of [[join(up, 'apply.log'), 'apply.log'], [join(up, 'journal.json'), 'journal.json'], [join(up, 'outcome.json'), 'outcome.json'], [join(home, 'updater', 'state.json'), 'updater-state.json'], [join(work, 'app.log'), 'app.log']]) {
    try { if (existsSync(from)) cpSync(from, join(art, to)); } catch { /* best effort */ }
  }
}

let holder = null;
let before = {};
let baseStamp = null;
// hop 1 is done by the baseline's own helper: its stamp when it has one, no stamp when it is older
const byBaseHelper = (line) => (baseStamp ? line.includes(`[${baseStamp}]`) : !line.includes('helper:'));
try {
  log(`scenario ${a.scenario}: baseline ${a.baseline} installed at ${install}`);
  check(readJson(join(install, 'build-info.json'))?.version === a.baseline, `the install is ${a.baseline}`);
  before = await tree(install);
  log(`baseline tree hashed: ${Object.keys(before).length} files`);
  // The helper that does hop 1 is the baseline's own. Releases from 0.3.0 on stamp it; older ones do not.
  const baseApply = join(install, 'dist', 'src', 'core', 'updater', 'apply.js');
  baseStamp = existsSync(baseApply) ? readFileSync(baseApply, 'utf8').match(/helper:[a-z0-9-]+/)?.[0] ?? null : null;
  log(`baseline helper: ${baseStamp ?? 'unstamped (older than 0.3.0)'}`);

  children.push(spawn(process.execPath, [join(here, 'serve.mjs'), '--served', join(preparedDir, 'served'), '--control', control, '--port', String(PORT), '--log', serveLog], { stdio: 'ignore', windowsHide: true }));
  await waitFor('the fake release server', async () => existsSync(serveLog), 15000);

  const electron = join(install, 'runtime', 'electron', 'electron.exe');
  const appLog = openSync(join(work, 'app.log'), 'a');
  spawn(electron, [install, '--disable-gpu', '--disable-software-rasterizer', '--no-sandbox', '--disable-dev-shm-usage'], { env, detached: true, stdio: ['ignore', appLog, appLog], windowsHide: true }).unref();
  const h0 = await waitFor('the baseline app to answer /health', async () => { const h = await health(); return h?.ok ? h : null; }, 180000);
  check(!!h0 && h0.version === a.baseline, `the installed ${a.baseline} starts and reports health (got ${h0?.version})`);
  if (!h0) throw new Error('the baseline never became healthy');

  if (a.scenario === 'locked') {
    const nm = join(install, 'node_modules');
    const find = (d, depth) => { for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isFile() && /^licen[sc]e/i.test(n) && depth > 0) return p; if (st.isDirectory() && depth < 3) { const r = find(p, depth + 1); if (r) return r; } } return null; };
    const target = find(nm, 0);
    if (!target) throw new Error('no file to lock under node_modules');
    lockedRel = target.slice(install.length + 1).replaceAll(String.fromCharCode(92), '/');
    log(`holding ${target} open`);
    holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(here, 'hold-file.ps1'), '-Path', target], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    await new Promise((res) => { holder.stdout.on('data', (d) => { if (String(d).includes('locked')) res(); }); setTimeout(res, 20000); });
  }

  if (a.scenario.startsWith('slow-')) writeFileSync(delayFile, `${good}:${a.scenario === 'slow-short' ? 25000 : 75000}`);
  const servedName = a.scenario === 'rollback' ? 'bad' : ['stone-later', 'stone-stranded', 'stone-stranded-nofull'].includes(a.scenario) ? a.scenario : a.scenario.startsWith('stone-') ? 'stone' : 'good';
  writeFileSync(control, servedName);
  log(`serving the ${servedName} candidate; waiting for the app to find, stage and apply it`);

  if (a.scenario === 'success') {
    const h1 = await waitFor(`/health to report ${good}`, async () => { const h = await health(); return h?.ok && h.version === good ? h : null; }, 600000);
    check(!!h1, `the new version ${good} starts and reports health`);
    const j = await waitFor('the journal to read committed', async () => (readJson(join(up, 'journal.json'))?.state === 'committed' ? true : null), 120000);
    check(!!j, 'the update is committed (journal)');
    check(readJson(join(up, 'outcome.json'))?.result === 'ok', 'the outcome is ok');
    check(readJson(join(install, 'package.json'))?.version === good && readJson(join(install, 'build-info.json'))?.version === good, `package.json and build-info.json say ${good}`);
    const list = readJson(join(preparedDir, 'served', 'good', 'PACKAGE-FILES.json')); // the candidate's own file list (an install does not keep it)
    const bad = [];
    for (const f of list?.files ?? []) { try { if ((await sha(join(install, ...f.path.split('/')))) !== f.sha256) bad.push(f.path); } catch { bad.push(f.path); } }
    check(!!list && bad.length === 0, `every file of the new package is on disk and matches its list (${list?.files.length ?? 0} files${bad.length ? `; wrong: ${bad.slice(0, 5).join(', ')}` : ''})`);
    const claude = spawnSync(join(install, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'), ['--version'], { encoding: 'utf8', timeout: 30000 });
    check(claude.status === 0, `the bundled claude.exe runs (${(claude.stdout || claude.stderr || '').trim().slice(0, 40)})`);
    check(readFileSync(join(home, 'rehearsal-marker.txt'), 'utf8').startsWith('user data'), 'user data in the data folder survived');
    check(await waitFor('the old copy to be cleaned', async () => !existsSync(join(up, 'prev')), 120000) !== null, '.update/prev was deleted after the healthy start');
    const hits = existsSync(serveLog) ? readFileSync(serveLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    check(hits.some((x) => String(x.path).endsWith(`legion-${good}-win-x64.zip`) && x.status === 200), 'the full package was downloaded (through the redirect hop)');
    check(!hits.some((x) => String(x.path).endsWith('-app.zip')), 'the code-only package was not requested');
  } else if (a.scenario === 'rollback') {
    const o = await waitFor('a rolled-back outcome', async () => (readJson(join(up, 'outcome.json'))?.result === 'rolled-back' ? readJson(join(up, 'outcome.json')) : null), 900000);
    check(!!o, `the update to ${bad} is rolled back (outcome rolled-back)`);
    const h1 = await waitFor(`/health to report ${a.baseline} again`, async () => { const h = await health(); return h?.ok && h.version === a.baseline ? h : null; }, 180000);
    check(!!h1, `${a.baseline} is running again after the rollback`);
    check(readJson(join(up, 'journal.json'))?.state === 'rolled-back', 'the journal says rolled-back');
    const after = await tree(install);
    const d = diff(before, after);
    check(d.length === 0, `the install is byte-identical to the baseline after the rollback${d.length ? `; differs: ${d.slice(0, 8).join(', ')}` : ''}`);
    const st = await waitFor('the failed version to be recorded', async () => (readJson(join(home, 'updater', 'state.json'))?.failedVersions?.includes(bad) ? true : null), 60000);
    check(!!st, `${bad} is recorded as failed (held back)`);
    check(!existsSync(join(up, 'failed')), '.update/failed was removed');
    check(readFileSync(join(home, 'rehearsal-marker.txt'), 'utf8').startsWith('user data'), 'user data survived the failed update');
  } else if (a.scenario.startsWith('slow-')) {
    // Whichever way this settles (committed: the new version; rolled back: the old one), the install must be whole and running.
    const o = await waitFor('an outcome', async () => { const x = readJson(join(up, 'outcome.json')); return x && (x.result === 'ok' || x.result === 'rolled-back') ? x : null; }, 900000);
    check(!!o, `the update settled (${o?.result})`);
    const h1 = await waitFor('the app to answer /health again', async () => { const h = await health(); return h?.ok ? h : null; }, 300000);
    check(!!h1 && [a.baseline, good].includes(h1.version), `Legion is running (version ${h1?.version})`);
    for (const n of ['dist', 'dist-ui', 'node_modules', 'runtime', 'package.json']) check(existsSync(join(install, n)), `${n} is still in the install`);
    if (h1?.version === good) {
      const list = readJson(join(preparedDir, 'served', 'good', 'PACKAGE-FILES.json'));
      const wrong = [];
      for (const f of list?.files ?? []) { try { if ((await sha(join(install, ...f.path.split('/')))) !== f.sha256) wrong.push(f.path); } catch { wrong.push(f.path); } }
      check(wrong.length === 0, `the install is the complete new package (${list?.files.length ?? 0} files${wrong.length ? `; wrong: ${wrong.slice(0, 5).join(', ')}` : ''})`);
    } else {
      const d = diff(before, await tree(install));
      check(d.length === 0, `the install is byte-identical to the baseline${d.length ? `; differs: ${d.slice(0, 8).join(', ')}` : ''}`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n- ${a.scenario}: settled as ${o?.result}, running ${h1?.version}\n`);
  } else if (a.scenario === 'chain') {
    // Hop 1: the code-only candidate. It is applied by the helper of the LIVE release (stamped from 0.3.0 on).
    const co = prepared.versions.base;
    writeFileSync(control, 'codeonly');
    const h1 = await waitFor(`/health to report ${co}`, async () => { const h = await health(); return h?.ok && h.version === co ? h : null; }, 600000);
    check(!!h1, `hop 1: the code-only candidate ${co} starts and reports health`);
    const j1 = await waitFor('the journal to read committed', async () => (readJson(join(up, 'journal.json'))?.state === 'committed' && readJson(join(up, 'journal.json'))?.to === co ? true : null), 120000);
    check(!!j1, 'hop 1 is committed');
    const log1 = existsSync(join(up, 'apply.log')) ? readFileSync(join(up, 'apply.log'), 'utf8') : '';
    check(byBaseHelper(log1.split('\n').find((l) => l.includes(`apply ${a.baseline} -> ${co}`)) ?? 'missing helper:'), `hop 1 was done by the baseline's own helper (${baseStamp ?? 'no stamp'})`);
    check(!log1.includes('re-running the swap helper'), 'hop 1 was a code-only swap (no runtime re-exec)');
    const stampNow = readFileSync(join(install, 'dist', 'src', 'core', 'updater', 'apply.js'), 'utf8').match(/helper:[a-z0-9-]+/)?.[0];
    check(!!stampNow, `the code-only update replaced the helper source in dist (${stampNow})`);
    // Hop 2: the full-package candidate, applied by the helper the code-only update installed.
    writeFileSync(control, 'good');
    const h2 = await waitFor(`/health to report ${good}`, async () => { const h = await health(); return h?.ok && h.version === good ? h : null; }, 900000);
    check(!!h2, `hop 2: the full-package candidate ${good} starts and reports health`);
    const log2 = existsSync(join(up, 'apply.log')) ? readFileSync(join(up, 'apply.log'), 'utf8') : '';
    const line2 = log2.split('\n').find((l) => l.includes(`apply ${co} -> ${good}`)) ?? '';
    check(!!stampNow && line2.includes(`[${stampNow}]`), `hop 2 was done by the NEW helper: ${line2.trim()}`);
    check(log2.includes('re-running the swap helper'), 'hop 2 used the full-package swap (runtime re-exec)');
    // the journal commits only after the healthy start is confirmed, so wait for it like hop 1 does (reading it at once raced the commit)
    check(await waitFor('the journal to read committed', async () => (readJson(join(up, 'journal.json'))?.state === 'committed' && readJson(join(up, 'journal.json'))?.to === good ? true : null), 120000) !== null, 'hop 2 is committed');
    const list = readJson(join(preparedDir, 'served', 'good', 'PACKAGE-FILES.json'));
    const wrong = [];
    for (const f of list?.files ?? []) { try { if ((await sha(join(install, ...f.path.split('/')))) !== f.sha256) wrong.push(f.path); } catch { wrong.push(f.path); } }
    check(wrong.length === 0, `the install is the complete full package (${list?.files.length ?? 0} files${wrong.length ? `; wrong: ${wrong.slice(0, 5).join(', ')}` : ''})`);
    check(await waitFor('the old copy to be cleaned', async () => !existsSync(join(up, 'prev')), 120000) !== null, '.update/prev was deleted after the healthy start');
  } else if (a.scenario === 'stone-later') {
    const co = prepared.versions.stone, later = prepared.versions.later;
    const h1 = await waitFor(`/health to report the stone ${co}`, async () => { const h = await health(); return h?.ok && h.version === co ? h : null; }, 600000);
    check(!!h1, `hop 1: the stepping stone ${co} starts and reports health (the old name offered the stone, not the newest release)`);
    const h2 = await waitFor(`/health to report the newest release ${later}`, async () => { const h = await health(); return h?.ok && h.version === later ? h : null; }, 600000);
    check(!!h2, `hop 2: the newest code-only release ${later} starts and reports health`);
    check(await waitFor('the journal to read committed', async () => (readJson(join(up, 'journal.json'))?.state === 'committed' && readJson(join(up, 'journal.json'))?.to === later ? true : null), 120000) !== null, 'the update to the newest release is committed');
    const log2 = existsSync(join(up, 'apply.log')) ? readFileSync(join(up, 'apply.log'), 'utf8') : '';
    check(!log2.includes('re-running the swap helper'), 'both hops were code-only swaps (no runtime re-exec)');
    check(readFileSync(join(home, 'rehearsal-marker.txt'), 'utf8').startsWith('user data'), 'user data in the data folder survived');
    const hits = (existsSync(serveLog) ? readFileSync(serveLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
    const first = (end) => hits.findIndex((x) => String(x.path).endsWith(end) && x.status === 200);
    check(first('/legion-update-manifest.json') >= 0, 'the old manifest name was read (by the live release)');
    check(first('/legion-update-manifest-2.json') >= 0, 'the second manifest name was read (by the stone)');
    check(first(`legion-${co}-app.zip`) >= 0 && first(`legion-${co}-app.zip`) < first(`legion-${later}-app.zip`), 'the stone package was downloaded BEFORE the newest release');
    check(!hits.some((x) => String(x.path).endsWith('-win-x64.zip')), 'no full package was requested');
  } else if (a.scenario === 'stone-walk' || a.scenario === 'stone-direct') {
    const walk = a.scenario === 'stone-walk';
    const co = prepared.versions.stone; // the REAL published stone (v0.3.0); only its manifest is re-signed
    let stoneStamp = null;
    const hitsNow = () => (existsSync(serveLog) ? readFileSync(serveLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
    if (walk) {
      // Hop 1: the live release reads the old name, which is the code-only stone. Its own helper does the swap.
      const h1 = await waitFor(`/health to report the stone ${co}`, async () => { const h = await health(); return h?.ok && h.version === co ? h : null; }, 600000);
      check(!!h1, `hop 1: the stepping stone ${co} starts and reports health (the full package was not applied by the old helper)`);
      const j1 = await waitFor('the journal to read committed', async () => (readJson(join(up, 'journal.json'))?.state === 'committed' && readJson(join(up, 'journal.json'))?.to === co ? true : null), 120000);
      check(!!j1, 'hop 1 is committed');
      const log1 = existsSync(join(up, 'apply.log')) ? readFileSync(join(up, 'apply.log'), 'utf8') : '';
      check(byBaseHelper(log1.split('\n').find((l) => l.includes(`apply ${a.baseline} -> ${co}`)) ?? 'missing helper:'), `hop 1 was done by the baseline's own helper (${baseStamp ?? 'no stamp'})`);
      check(!log1.includes('re-running the swap helper'), 'hop 1 was a code-only swap (no runtime re-exec)');
      stoneStamp = readFileSync(join(install, 'dist', 'src', 'core', 'updater', 'apply.js'), 'utf8').match(/helper:[a-z0-9-]+/)?.[0] ?? null;
    }
    const h2 = await waitFor(`/health to report the full candidate ${good}`, async () => { const h = await health(); return h?.ok && h.version === good ? h : null; }, 900000);
    check(!!h2, `${walk ? 'hop 2' : 'the update'}: the full candidate ${good} starts and reports health`);
    const log2 = existsSync(join(up, 'apply.log')) ? readFileSync(join(up, 'apply.log'), 'utf8') : '';
    const from2 = walk ? co : a.baseline;
    const line2 = log2.split('\n').find((l) => l.includes(`apply ${from2} -> ${good}`)) ?? '';
    // stone-walk: hop 2 is done by the helper the REAL stone brought (read after hop 1, before hop 2 replaced it); stone-direct: by the helper of the new build
    const stampNow = walk ? stoneStamp : readFileSync(join(install, 'dist', 'src', 'core', 'updater', 'apply.js'), 'utf8').match(/helper:[a-z0-9-]+/)?.[0];
    check(!!stampNow && line2.includes(`[${stampNow}]`), `the full swap was done by the ${walk ? "stepping stone's" : 'NEW'} helper (${stampNow}): ${line2.trim()}`);
    check(log2.includes('re-running the swap helper'), 'the full swap used the full-package route (runtime re-exec)');
    check(await waitFor('the journal to read committed', async () => (readJson(join(up, 'journal.json'))?.state === 'committed' && readJson(join(up, 'journal.json'))?.to === good ? true : null), 120000) !== null, 'the full update is committed');
    check(readJson(join(up, 'outcome.json'))?.result === 'ok', 'the outcome is ok');
    const list = readJson(join(preparedDir, 'served', 'good', 'PACKAGE-FILES.json'));
    const wrong = [];
    for (const f of list?.files ?? []) { try { if ((await sha(join(install, ...f.path.split('/')))) !== f.sha256) wrong.push(f.path); } catch { wrong.push(f.path); } }
    check(wrong.length === 0, `the install is the complete full package (${list?.files.length ?? 0} files${wrong.length ? `; wrong: ${wrong.slice(0, 5).join(', ')}` : ''})`);
    check(readFileSync(join(home, 'rehearsal-marker.txt'), 'utf8').startsWith('user data'), 'user data in the data folder survived');
    check(await waitFor('the old copy to be cleaned', async () => !existsSync(join(up, 'prev')), 120000) !== null, '.update/prev was deleted after the healthy start');
    const hits = hitsNow();
    const first = (end) => hits.findIndex((x) => String(x.path).endsWith(end) && x.status === 200);
    check(first('/legion-update-manifest-2.json') >= 0, 'the second manifest name was read');
    if (walk) {
      check(first('/legion-update-manifest.json') >= 0, 'the old manifest name was read (by the live release)');
      check(first(`legion-${co}-app.zip`) >= 0 && first(`legion-${co}-app.zip`) < first(`legion-${good}-win-x64.zip`), 'the stone package was downloaded BEFORE the full package');
    } else {
      check(first('/legion-update-manifest.json') < 0, 'the old manifest name was never requested (the second name answered)');
      check(!hits.some((x) => String(x.path).endsWith('-app.zip')), 'the code-only package was not requested');
    }
    check(first(`legion-${good}-win-x64.zip`) >= 0, 'the full package was downloaded (through the redirect hop)');
  } else if (a.scenario === 'stone-stranded' || a.scenario === 'stone-stranded-nofull') {
    const stone = prepared.versions.stone, s2 = prepared.versions.stranded, s3 = prepared.versions.stranded2;
    const nofull = a.scenario === 'stone-stranded-nofull';
    const hitsNow = () => (existsSync(serveLog) ? readFileSync(serveLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
    const first = (hits, end) => hits.findIndex((x) => String(x.path).endsWith(end) && x.status === 200);
    const applyLog = () => (existsSync(join(up, 'apply.log')) ? readFileSync(join(up, 'apply.log'), 'utf8') : '');
    const committedTo = (v) => waitFor(`the journal to read committed to ${v}`, async () => (readJson(join(up, 'journal.json'))?.state === 'committed' && readJson(join(up, 'journal.json'))?.to === v ? true : null), 120000);
    // Hop 1: 0.2.7 reads the old name, which is the REAL v0.3.0 package (its manifest re-signed); its own old helper does the swap.
    const h1 = await waitFor(`/health to report the real stone ${stone}`, async () => { const h = await health(); return h?.ok && h.version === stone ? h : null; }, 600000);
    check(!!h1, `hop 1: the real stepping stone ${stone} starts and reports health`);
    check(!!(await committedTo(stone)), 'hop 1 is committed');
    check(byBaseHelper(applyLog().split('\n').find((l) => l.includes(`apply ${a.baseline} -> ${stone}`)) ?? 'missing helper:'), `hop 1 was done by the baseline's own helper (${baseStamp ?? 'no stamp'})`);
    if (nofull) {
      // The stone install is offered a code-only release whose lock differs and that carries NO full package: it downloads the code package, refuses it
      // (dependencies changed) and has nothing to fall back to. It must end on a notice, still running the stone, with a full package never requested.
      const got = await waitFor(`the stone to ask for the code package of ${s2}`, async () => (first(hitsNow(), `legion-${s2}-app.zip`) >= 0 ? true : null), 600000);
      check(!!got, `the stone install downloaded the code package of ${s2} and looked at it`);
      // The refusal itself. The frozen stone keeps its reason in memory only (it logs nothing for a StageError, and /api/update/status needs the per-launch
      // admin secret), so the reason is shown from what the stone decides on: checkTree refuses with 'full-install' exactly when the dependency hash of the
      // installed lock differs from the one in the staged package (v0.3.0 package.ts). Both are read from the real files here. The stone is done with the
      // package when its staging folder is gone again (the stage is removed on every refusal) with no swap started.
      const stagingGone = await waitFor('the stone to finish with the code package (staging folder removed)', async () => {
        const st = join(up, 'staging');
        if (existsSync(st) && readdirSync(st).length > 0) return null;
        await sleep(3000);
        return existsSync(st) && readdirSync(st).length > 0 ? null : true;
      }, 180000);
      check(!!stagingGone, 'the stone removed its staging folder: it staged the code package and dropped it');
      const stagedLock = readZipEntry(readFileSync(join(preparedDir, 'served', 'stone-stranded-nofull', `legion-${s2}-app.zip`)), `legion-${s2}/package-lock.json`);
      const installedLock = existsSync(join(install, 'package-lock.json')) ? readFileSync(join(install, 'package-lock.json'), 'utf8') : undefined;
      check(!!stagedLock && installedLock !== undefined && dependencyHash(installedLock) !== dependencyHash(stagedLock.toString('utf8')),
        'refusal reason: the dependency hash of the staged package lock differs from the installed lock, so the frozen checkTree throws full-install');
      const served2 = readJson(join(preparedDir, 'served', 'stone-stranded-nofull', 'legion-update-manifest-2.json'));
      check(!!served2 && served2.requiresFullInstall === false && !served2.fullAsset, 'refusal reason: the served manifest names no fullAsset, so the stone has nothing to fall back to');
      await sleep(15000); // a short grace for a retry that must not happen; the wait above is what proves the refusal
      const h2 = await health();
      check(h2?.ok && h2.version === stone, `the install is still the stone ${stone} (notify-only; running ${h2?.version})`);
      check(readJson(join(up, 'journal.json'))?.to !== s2, 'no swap to the refused release was started');
      check(!hitsNow().some((x) => String(x.path).endsWith('-win-x64.zip')), 'no full package was requested (the manifest carried none)');
      check(readFileSync(join(home, 'rehearsal-marker.txt'), 'utf8').startsWith('user data'), 'user data in the data folder survived');
    } else {
      // Hop 2: the code package of s2 has a lock the stone does not hold. The frozen updater refuses it and falls back to the manifest's own full package.
      const h2 = await waitFor(`/health to report ${s2}`, async () => { const h = await health(); return h?.ok && h.version === s2 ? h : null; }, 900000);
      check(!!h2, `hop 2: the code-only release ${s2} starts and reports health (via its carried full package)`);
      check(!!(await committedTo(s2)), 'hop 2 is committed');
      const log2 = applyLog();
      check(log2.split('\n').some((l) => l.includes(`apply ${stone} -> ${s2}`)), `the swap ${stone} -> ${s2} is in the apply log`);
      check(log2.includes('re-running the swap helper'), 'hop 2 used the full-package swap (runtime re-exec)');
      check(readJson(join(up, 'outcome.json'))?.result === 'ok', 'the outcome is ok');
      const hits2 = hitsNow();
      const iApp = first(hits2, `legion-${s2}-app.zip`), iFull = first(hits2, `legion-${s2}-win-x64.zip`);
      check(iApp >= 0 && iFull > iApp, 'the code package was requested first, then the full package (the fallback)');
      const list = readJson(join(preparedDir, 'served', 'stone-stranded', 'PACKAGE-FILES.json'));
      const wrong = [];
      for (const f of list?.files ?? []) { try { if ((await sha(join(install, ...f.path.split('/')))) !== f.sha256) wrong.push(f.path); } catch { wrong.push(f.path); } }
      check(!!list && wrong.length === 0, `the install is the complete full package (${list?.files.length ?? 0} files${wrong.length ? `; wrong: ${wrong.slice(0, 5).join(', ')}` : ''})`);
      check(readFileSync(join(home, 'rehearsal-marker.txt'), 'utf8').startsWith('user data'), 'user data in the data folder survived');
      check(await waitFor('the old copy to be cleaned', async () => !existsSync(join(up, 'prev')), 120000) !== null, '.update/prev was deleted after the healthy start');
      const reexecs = (applyLog().match(/re-running the swap helper/g) ?? []).length;
      // Hop 3: the next code-only release has the same lock and also carries its full package. The user restarts Legion, which checks on start.
      // The code route must be taken; the carried package must not be downloaded.
      killInstalled();
      await sleep(5000);
      writeFileSync(control, 'stone-stranded-2');
      log(`serving the next code-only release ${s3} (same lock, carries its full package); restarting Legion`);
      const appLog2 = openSync(join(work, 'app.log'), 'a');
      spawn(join(install, 'runtime', 'electron', 'electron.exe'), [install, '--disable-gpu', '--disable-software-rasterizer', '--no-sandbox', '--disable-dev-shm-usage'], { env, detached: true, stdio: ['ignore', appLog2, appLog2], windowsHide: true }).unref();
      const h3 = await waitFor(`/health to report ${s3}`, async () => { const h = await health(); return h?.ok && h.version === s3 ? h : null; }, 900000);
      check(!!h3, `hop 3: the code-only release ${s3} starts and reports health`);
      check(!!(await committedTo(s3)), 'hop 3 is committed');
      const hits3 = hitsNow();
      check(first(hits3, `legion-${s3}-app.zip`) >= 0, 'the code package of the next release was downloaded');
      check(!hits3.some((x) => String(x.path).endsWith(`legion-${s3}-win-x64.zip`)), 'its carried full package was NEVER requested (matching lock = code route)');
      check((applyLog().match(/re-running the swap helper/g) ?? []).length === reexecs, 'hop 3 was a code-only swap (no runtime re-exec)');
      check(readFileSync(join(home, 'rehearsal-marker.txt'), 'utf8').startsWith('user data'), 'user data survived the third hop');
    }
  } else if (a.scenario.startsWith('vanished')) {
    const staged = join(up, 'staging', good, 'stage.json');
    const seen = await waitFor('the package to be staged', async () => (existsSync(staged) ? true : null), 600000);
    check(!!seen, 'the candidate was downloaded, checked and staged');
    rmSync(join(up, 'staging', good, 'x', `legion-${good}`, 'runtime'), { recursive: true, force: true });
    log('removed the staged runtime folder before the commit');
    const o = await waitFor('a failed outcome', async () => (readJson(join(up, 'outcome.json'))?.result === 'failed' ? readJson(join(up, 'outcome.json')) : null), 600000);
    check(!!o, 'the swap is refused (outcome failed)');
    check(/incomplete|missing/i.test(o?.reason ?? ''), `the reason says the staged update is incomplete (${o?.reason})`);
    const h1 = await waitFor(`/health to report ${a.baseline} again`, async () => { const h = await health(); return h?.ok && h.version === a.baseline ? h : null; }, 180000);
    check(!!h1, `${a.baseline} is running again`);
    const d = diff(before, await tree(install));
    check(d.length === 0, `the install is byte-identical to the baseline${d.length ? `; differs: ${d.slice(0, 8).join(', ')}` : ''}`);
    check(!existsSync(join(up, 'journal.json')) || readJson(join(up, 'journal.json'))?.state !== 'swapping', 'no swap was left half done');
  } else {
    const o = await waitFor('a failed outcome (files in use)', async () => (readJson(join(up, 'outcome.json'))?.result === 'failed' ? readJson(join(up, 'outcome.json')) : null), 900000);
    check(!!o, 'the swap is refused when a file is in use (outcome failed)');
    check(/in use/i.test(o?.reason ?? ''), `the reason says files are in use (${o?.reason})`);
    const h1 = await waitFor(`/health to report ${a.baseline} again`, async () => { const h = await health(); return h?.ok && h.version === a.baseline ? h : null; }, 180000);
    check(!!h1, `${a.baseline} is running again after the refused swap`);
    const after = await tree(install);
    const d = diff(before, after);
    check(d.length === 0, `the install is byte-identical to the baseline after the refused swap${d.length ? `; differs: ${d.slice(0, 8).join(', ')}` : ''}`);
    check(readFileSync(join(home, 'rehearsal-marker.txt'), 'utf8').startsWith('user data'), 'user data survived');
    log('releasing the file; waiting for the app to try again by itself');
    holder.kill(); holder = null;
    const h2 = await waitFor(`a later attempt to land ${good}`, async () => { const h = await health(); return h?.ok && h.version === good ? h : null; }, 420000);
    // The opening of this attempt is automatic only if the app keeps its staged package and consent; report what happens.
    log(h2 ? `a later attempt landed ${good} without any action` : 'no automatic second attempt within 7 minutes (the first attempt\'s staged package is kept; the owner presses Update)');
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n- locked file: automatic second attempt landed ${good}: ${h2 ? 'yes' : 'no'}\n`);
  }
} catch (e) {
  problems.push(`the scenario stopped: ${e.message}`); log(`FAIL  the scenario stopped: ${e.stack || e.message}`);
} finally {
  try { await report(); } catch (e) { log(`report failed: ${e.message}`); }
  collect();
  try { if (holder) holder.kill(); } catch { /* gone */ }
  killInstalled();
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Rehearsal: ${a.scenario}: ${problems.length ? 'FAILED' : 'passed'}\n${problems.map((p) => `- ${p}`).join('\n')}\n`);
}
if (problems.length) { console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`); process.exit(1); }
console.log(`\nscenario ${a.scenario}: passed`);
