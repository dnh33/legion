// Rehearsal-only: drives ONE scenario against a throwaway install of a published release, on a CI runner.
//   success   the candidate (0.99.0) is staged, swapped in and reports healthy; user data survives; the old copy is cleaned
//   rollback  the candidate's first start fails (0.99.1): the previous version is restored byte for byte and the failed one is held back
//   locked    a file under node_modules is held open during the swap: the update is refused cleanly, the old version keeps running
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
import { args, die } from '../lib/release-lib.mjs';

const a = args(process.argv.slice(2), { scenario: 'v', install: 'v', prepared: 'v', work: 'v', baseline: 'v' });
for (const k of ['scenario', 'install', 'prepared', 'work', 'baseline']) if (!a[k]) die(`--${k} is required`);
if (!['success', 'rollback', 'locked'].includes(a.scenario)) die('--scenario must be success, rollback or locked');
const here = dirname(fileURLToPath(import.meta.url));
const install = resolve(a.install), work = resolve(a.work), preparedDir = resolve(a.prepared);
const prepared = { ...JSON.parse(readFileSync(join(preparedDir, 'prepared.json'), 'utf8')), pubKeyFile: join(preparedDir, 'legion-update-k1.pub.pem') };
const PORT = 18443, APP_PORT = 4747;
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
  NODE_OPTIONS: `--import ${pathToFileURL(join(here, 'preload.mjs')).href}`,
  ELECTRON_ENABLE_LOGGING: '1', ELECTRON_DISABLE_GPU: '1',
};
delete env.ELECTRON_RUN_AS_NODE;

function collect() {
  for (const [from, to] of [[join(up, 'apply.log'), 'apply.log'], [join(up, 'journal.json'), 'journal.json'], [join(up, 'outcome.json'), 'outcome.json'], [join(home, 'updater', 'state.json'), 'updater-state.json'], [join(work, 'app.log'), 'app.log']]) {
    try { if (existsSync(from)) cpSync(from, join(art, to)); } catch { /* best effort */ }
  }
}

let holder = null;
try {
  log(`scenario ${a.scenario}: baseline ${a.baseline} installed at ${install}`);
  check(readJson(join(install, 'build-info.json'))?.version === a.baseline, `the install is ${a.baseline}`);
  const before = await tree(install);
  log(`baseline tree hashed: ${Object.keys(before).length} files`);

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
    lockedRel = target.slice(install.length + 1).replace(/\/g, '/');
    log(`holding ${target} open`);
    holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(here, 'hold-file.ps1'), '-Path', target], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    await new Promise((res) => { holder.stdout.on('data', (d) => { if (String(d).includes('locked')) res(); }); setTimeout(res, 20000); });
  }

  writeFileSync(control, a.scenario === 'rollback' ? 'bad' : 'good');
  log(`serving the ${a.scenario === 'rollback' ? 'bad' : 'good'} candidate; waiting for the app to find, stage and apply it`);

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
  collect();
  try { if (holder) holder.kill(); } catch { /* gone */ }
  killInstalled();
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Rehearsal: ${a.scenario}: ${problems.length ? 'FAILED' : 'passed'}\n${problems.map((p) => `- ${p}`).join('\n')}\n`);
}
if (problems.length) { console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`); process.exit(1); }
console.log(`\nscenario ${a.scenario}: passed`);
