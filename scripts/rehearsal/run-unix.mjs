// Rehearsal-only: drives ONE Mac/Linux scenario on a CI runner, against a throwaway install made by scripts/install/install.sh. The Windows
// scenarios (run-scenario.mjs) are Windows-shaped and stay untouched; this file is the Unix counterpart. The loopback release server, the
// throwaway signing key and the preload are the same ones (serve.mjs, preload.mjs, prepare.mjs).
//   update   a baseline 0.98.0 is installed with THIS checkout's install.sh from a local bare repo tagged v0.98.0 (LEGION_INSTALL_BASE=file://).
//            It is offered the code-only 0.99.0; the update is clicked through the API (auto-install is off). Then: the swap, /health 0.99.0, the
//            relaunched process carries the launch switches, ~/.legion survives. Then 0.99.1 (its main exits) is rolled back and the old version
//            answers again. Last, the installer is run again on the swapped tree and must accept it (only the updater's own changes).
//   frozen   the REAL v0.3.4 is installed with its own install.sh (fetched from raw.githubusercontent at that tag): it has no marker, so it only
//            gets a notice (mode 'checkout', install() answers 409, no package is requested). Then this checkout's install.sh is run over it
//            (the one-time step the release notes ask for): the marker appears, the tree is clean, mode is 'apply' and the update to 0.99.0 works.
//   refuse   no app: an edit in src/ (or an untracked file, or a folder without the marker) makes the installer refuse and leaves the edit; changes
//            the updater itself makes (a CODE_SET file, .update, build-info.json) do not.
//   notify   a dependency-changing release (and a code release whose lock differs) offered off Windows is a notice with zero requests for a
//            *-win-x64.zip; a tampered manifest signature and a downgrade are rejected; a folder without the marker only gets a notice.
// The update API needs the per-launch admin key, which only the app window holds: the app is started with a DevTools port and the calls are made
// from inside its page (as scripts/rehearsal/run-reopen.mjs does).
// usage: node scripts/rehearsal/run-unix.mjs --scenario <update|frozen|refuse|notify> --prepared <dir> --work <dir>
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const scenario = opt('scenario'), preparedDir = opt('prepared') && resolve(opt('prepared')), work = opt('work') && resolve(opt('work'));
if (!scenario || !preparedDir || !work) { console.error('usage: node scripts/rehearsal/run-unix.mjs --scenario <update|frozen|refuse|notify> --prepared <dir> --work <dir>'); process.exit(2); }
if (process.platform === 'win32') { console.error('run-unix.mjs is for macOS and Linux runners'); process.exit(2); }
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 15)) { console.error(`the preload needs module.registerHooks (Node 22.15 or newer); this is ${process.versions.node}`); process.exit(2); }

const prepared = JSON.parse(readFileSync(join(preparedDir, 'prepared.json'), 'utf8'));
const pubKeyFile = join(preparedDir, 'legion-update-k1.pub.pem');
const GOOD = prepared.versions.unix, BAD = prepared.versions.unixbad, BASE = '0.98.0';
const SRV_PORT = 18443, APP_PORT = 4747, CDP_BASE = 9330;
const home = join(work, 'home'), dataHome = join(home, '.legion'), install = join(work, 'legion-install'), site = join(work, 'site'), art = join(work, 'artifacts');
const control = join(work, 'control.txt'), serveLog = join(art, 'serve.log');
const up = join(install, '.update');
// The switches a user's start can carry on these machines; the relaunch after an update must repeat them (src/core/updater/main-logic.ts WINDOW_SWITCHES).
const LAUNCH = process.platform === 'darwin' ? ['--disable-gpu', '--disable-software-rasterizer', '--use-mock-keychain'] : ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${m}`);
const problems = [];
const check = (ok, msg) => { if (ok) log(`ok    ${msg}`); else { problems.push(msg); log(`FAIL  ${msg}`); } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

for (const d of [work, home, dataHome, art, join(dataHome, 'updater')]) mkdirSync(d, { recursive: true });
// auto-install stays off: the update is a click, as on a real Mac in 0.3.5
writeFileSync(join(dataHome, 'updater', 'settings.json'), JSON.stringify({ checkEnabled: true, autoInstallWhenIdle: false, intervalHours: 1 }));
writeFileSync(join(dataHome, 'rehearsal-marker.txt'), 'user data that must survive an update\n');
writeFileSync(control, 'none');
const dataOk = () => read(join(dataHome, 'rehearsal-marker.txt')).startsWith('user data');

/** The environment of every child: this runner's, with the installer's switches cleared the way a user's shell has them. */
const baseEnv = () => {
  const e = { ...process.env, HOME: home, CI: '', ELECTRON_SKIP_BINARY_DOWNLOAD: '' };
  delete e.LEGION_INSTALL_BASE; delete e.ELECTRON_RUN_AS_NODE; delete e.NODE_OPTIONS;
  return e;
};
/** Runs a command, keeps its whole output in the artifacts and returns { status, out }. */
function run(label, cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { cwd: o.cwd, env: o.env ?? baseEnv(), encoding: 'utf8', timeout: o.timeout ?? 900_000, maxBuffer: 256 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  try { writeFileSync(join(art, `${label}.log`), `$ ${cmd} ${args.join(' ')}\n${out}\nexit ${r.status}\n`); } catch { /* best effort */ }
  return { status: r.status, out };
}
const git = (cwd, ...args) => run(`git-${args[0]}`, 'git', args, { cwd });

// ---- the baseline: this checkout, versioned 0.98.0, as a tag in a local bare repo (what install.sh clones with LEGION_INSTALL_BASE=file://) ----
function makeBaselineRepo() {
  const src = join(work, 'baseline-src');
  rmSync(src, { recursive: true, force: true });
  const c = run('baseline-clone', 'git', ['clone', '--quiet', '--no-hardlinks', repoRoot, src]); // copies, not hardlinks: a hardlink race with git's background commit-graph write failed one run
  if (c.status !== 0) throw new Error(`could not clone the checkout: ${c.out}`);
  const patch = (rel, fn) => { const f = join(src, rel); const t = readFileSync(f, 'utf8'); const n = fn(t); if (n === t) throw new Error(`nothing to patch in ${rel}`); writeFileSync(f, n); };
  patch('package.json', (t) => t.replace(/"version":\s*"[^"]+"/, `"version": "${BASE}"`));
  patch('package-lock.json', (t) => { const j = JSON.parse(t); j.version = BASE; if (j.packages?.['']) j.packages[''].version = BASE; return JSON.stringify(j, null, 2) + '\n'; });
  patch('src/shared/config.ts', (t) => t.replace(/(export const VERSION = ')[^']+(')/, `$1${BASE}$2`));
  for (const a of [['-c', 'user.name=ci', '-c', 'user.email=ci@invalid', 'commit', '-q', '-a', '-m', `baseline ${BASE}`], ['tag', `v${BASE}`]]) {
    const r = git(src, ...a); if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.out}`);
  }
  const bare = join(site, 'dnh33', 'legion.git');
  rmSync(site, { recursive: true, force: true }); mkdirSync(join(site, 'dnh33'), { recursive: true });
  const b = run('baseline-bare', 'git', ['clone', '--bare', '--quiet', '--no-hardlinks', src, bare]);
  if (b.status !== 0) throw new Error(`could not make the bare repo: ${b.out}`);
  rmSync(src, { recursive: true, force: true });
  log(`baseline repo: tag v${BASE} in ${bare}`);
}
const siteUrl = () => `file://${site}`;
const installerHere = join(repoRoot, 'scripts', 'install', 'install.sh');
/** This checkout's installer against the local bare repo. */
const runInstaller = (label, version = BASE) => run(label, 'sh', [installerHere, '--no-launch', '--version', version, '--dir', install], { env: { ...baseEnv(), LEGION_INSTALL_BASE: siteUrl() } });

// ---- the release server and the app ----
const children = [];
function startServer() {
  children.push(spawn(process.execPath, [join(here, 'serve.mjs'), '--served', join(preparedDir, 'served'), '--control', control, '--port', String(SRV_PORT), '--log', serveLog], { stdio: 'ignore' }));
}
const serveHits = () => (existsSync(serveLog) ? read(serveLog).trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : []);
const packageHits = () => serveHits().filter((h) => String(h.path ?? '').includes('/releases/download/') || String(h.path ?? '').endsWith('.zip'));
const winHits = () => serveHits().filter((h) => String(h.path ?? '').includes('win-x64'));
const serve = (name) => { writeFileSync(control, name); log(`serving ${name}`); };

let launches = 0, cdp = CDP_BASE;
let electronBin = '';
function appEnv() {
  return { ...baseEnv(), LEGION_HOME: dataHome, LEGION_PORT: String(APP_PORT), REHEARSAL_PORT: String(SRV_PORT), REHEARSAL_PUBKEY_FILE: pubKeyFile, NODE_OPTIONS: `--import ${pathToFileURL(join(here, 'preload.mjs')).href}`, ELECTRON_ENABLE_LOGGING: '1' };
}
/** Starts the installed app the way the launcher does (electron "<dir>" + switches), plus a DevTools port for the API calls. */
function startApp(why) {
  if (!electronBin) electronBin = run('electron-path', 'node', ['-e', 'process.stdout.write(require("electron"))'], { cwd: install }).out.trim().split('\n').pop();
  cdp = CDP_BASE + launches++;
  const fd = openSync(join(art, 'app.log'), 'a');
  const c = spawn(electronBin, [install, ...LAUNCH, `--remote-debugging-port=${cdp}`, '--remote-allow-origins=*'], { env: appEnv(), detached: true, stdio: ['ignore', fd, fd] });
  c.unref();
  log(`started the installed app (${why}), pid ${c.pid}, devtools port ${cdp}`);
}
async function health() { try { const r = await fetch(`http://127.0.0.1:${APP_PORT}/health`, { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() : null; } catch { return null; } }
async function waitFor(what, fn, ms, step = 2000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) { log(`timed out waiting for ${what}`); return null; } await sleep(step); } }
const healthy = async (v, ms = 180_000) => waitFor(`/health ${v}`, async () => { const h = await health(); return h?.ok && h.version === v ? h : null; }, ms);

/** A request from inside the app's own page, which is the only holder of the admin key. */
async function api(method, path, body) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${cdp}/json`, { signal: AbortSignal.timeout(3000) })).json();
    const page = targets.find((t) => t.type === 'page' && /^https?:\/\/127\.0\.0\.1/.test(t.url)) ?? targets.find((t) => t.type === 'page' && !/^devtools:/.test(t.url));
    if (!page?.webSocketDebuggerUrl) return { err: 'no window yet' };
    const expr = `(async()=>{const l=window.legion;if(!l||!l.admin)return {err:'no admin key in the window yet'};const r=await fetch(l.baseUrl+${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'x-legion-admin':l.admin,authorization:'Bearer '+l.token,'content-type':'application/json'}${method === 'GET' ? '' : `,body:${JSON.stringify(JSON.stringify(body ?? {}))}`}});let j=null;try{j=await r.json()}catch(e){};return {status:r.status,json:j}})()`;
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('devtools socket failed')); });
    const msg = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('devtools call timed out')), 240_000);
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) { clearTimeout(t); res(m); } };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });
    try { ws.close(); } catch { /* gone */ }
    return msg.result?.result?.value ?? { err: msg.error?.message ?? msg.result?.exceptionDetails?.text ?? 'no value' };
  } catch (e) { return { err: e.message }; }
}
let lastApiErr = 0;
/** The update status, retrying while the window comes up. */
async function status(ms = 120_000) {
  const st = await waitFor('the window to answer the status call', async () => {
    const r = await api('GET', '/api/update/status');
    if (r?.json && r.status === 200) return r.json;
    if (Date.now() - lastApiErr > 30_000) { lastApiErr = Date.now(); log(`the window did not answer: ${r?.err ?? `HTTP ${r?.status}`} (devtools port ${cdp})`); }
    return null;
  }, ms, 3000);
  return st;
}
/** Asks for a check and returns the status it ends with (the first manual check of a process is not throttled). */
async function checkNow() {
  const r = await api('POST', '/api/update/check');
  if (r?.status === 200 && r.json) return r.json;
  return status(30_000);
}
/** Waits until the status offers `version` (checking now, and again about every 70 s, the throttle being 60 s). */
async function offered(version) {
  let lastCheck = 0, st = null;
  const got = await waitFor(`${version} to be offered`, async () => {
    st = await status(30_000);
    if (st?.available?.version === version) return st;
    if (Date.now() - lastCheck > 70_000) { lastCheck = Date.now(); st = await checkNow(); if (st?.available?.version === version) return st; }
    return null;
  }, 360_000, 5000);
  if (!got && st) log(`last status: ${JSON.stringify({ mode: st.mode, available: st.available, check: st.check, error: st.error })}`);
  return got;
}

// ---- processes ----
function procs() {
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const out = { mains: [], cores: [], helpers: [], children: [], all: [] };
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line); if (!m) continue;
    const pid = Number(m[1]), cmd = m[2];
    if (pid === process.pid || pid === process.ppid || !cmd.includes(`${install}/`) && !cmd.endsWith(install) && !cmd.includes(`${install} `)) continue;
    out.all.push({ pid, cmd });
    if (/apply\.mjs/.test(cmd)) out.helpers.push({ pid, cmd });
    else if (/--type=/.test(cmd)) out.children.push({ pid, cmd });
    else if (/legion-core/.test(cmd)) out.cores.push({ pid, cmd });
    else if (/node_modules\/electron\/dist\//.test(cmd)) out.mains.push({ pid, cmd });
  }
  return out;
}
function killInstalled() {
  for (let i = 0; i < 5; i++) {
    const p = procs().all; if (!p.length) return;
    for (const x of p) { try { process.kill(x.pid, 'SIGKILL'); } catch { /* gone */ } }
    spawnSync('sleep', ['1']);
  }
}

// ---- the install tree ----
const sha = (p) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(p).on('data', (c) => h.update(c)).on('error', rej).on('end', () => res(h.digest('hex'))); });
/** Every file with its size and hash, except what the updater and git own and the (large, untouched) dependencies. */
async function tree(root) {
  const out = {};
  const walk = async (d, rel) => {
    for (const n of readdirSync(d).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      if (!rel && ['.update', '.git', 'node_modules'].includes(n)) continue;
      const p = join(d, n); const st = statSync(p);
      if (st.isDirectory()) await walk(p, r); else out[r] = `${st.size}:${await sha(p)}`;
    }
  };
  await walk(root, '');
  return out;
}
const diff = (x, y) => { const d = []; for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (x[k] !== y[k]) d.push(k); return d; };
const gitClean = () => git(install, 'status', '--porcelain').out.trim() === '';
const markerOk = () => {
  const m = readJson(join(install, '.legion-install.json'));
  return !!m && m.schema === 1 && m.manager === 'install.sh' && m.dir === realpathSync(install) && m.head === read(join(install, '.git', 'HEAD')).trim();
};
const instVersion = () => readJson(join(install, 'package.json'))?.version;

/** The install checks every baseline scenario starts with. */
function baselineInstalled() {
  const r = runInstaller('install-baseline');
  check(r.status === 0, `install.sh from the local repo installed ${BASE} (exit ${r.status})`);
  if (r.status !== 0) { log(r.out.split('\n').slice(-25).join('\n')); throw new Error('the baseline install failed'); }
  check(instVersion() === BASE, `package.json says ${BASE}`);
  check(markerOk(), 'the marker .legion-install.json is valid (schema 1, install.sh, dir, head)');
  check(gitClean(), `git status is clean after the install${gitClean() ? '' : `: ${git(install, 'status', '--porcelain').out.trim().slice(0, 300)}`}`);
  check(existsSync(join(home, '.local', 'bin', 'legion')), 'the launcher exists');
}

/** Click-installs `version` and returns once the new version answers. Used by update and frozen. */
async function updateTo(version, folder, from) {
  serve(folder);
  const st = await offered(version);
  check(!!st, `${version} is offered (mode ${st?.mode}, platform ${st?.platform})`);
  if (!st) throw new Error(`${version} was never offered`);
  check(st.mode === 'apply', `the update mode is apply (got ${st.mode})`);
  check(st.settings?.autoInstallWhenIdle === false, 'auto-install is off');
  const r = await api('POST', '/api/update/install');
  check(r?.status === 200 && r.json?.ok === true, `the install click is accepted (HTTP ${r?.status ?? r?.err}${r?.json?.error ? `, ${r.json.error}` : ''})`);
  const h = await healthy(version, 900_000);
  check(!!h, `${version} answers /health after the swap`);
  if (!h) throw new Error(`${version} never answered`);
  check(!!(await waitFor('the journal to read committed', async () => (readJson(join(up, 'journal.json'))?.state === 'committed' ? true : null), 120_000)), 'the journal says committed');
  check(readJson(join(up, 'outcome.json'))?.result === 'ok', 'the outcome is ok');
  check(instVersion() === version && readJson(join(install, 'build-info.json'))?.version === version, `package.json and build-info.json say ${version}`);
  check(dataOk(), '~/.legion survived (the data marker is intact)');
  check(!!(await waitFor('the old copy to be cleaned', async () => (!existsSync(join(up, 'prev')) ? true : null), 120_000)), '.update/prev was deleted after the healthy start');
  const p = procs();
  check(p.mains.length === 1, `one Electron main for this install after the relaunch (${p.mains.length})`);
  const cmd = p.mains[0]?.cmd ?? '';
  check(LAUNCH.every((s) => cmd.split(' ').includes(s)), `the relaunched process carries the launch switches ${LAUNCH.join(' ')}`);
  check(!/--remote-debugging-port/.test(cmd), 'the relaunch does not carry switches outside the allowlist (no DevTools port)');
  log(`relaunched: ${cmd.slice(0, 300)}`);
  check(winHits().length === 0, 'no *-win-x64.zip was requested');
  check(packageHits().some((x) => String(x.path).endsWith(`legion-${version}-app.zip`) && x.status === 200), 'the code-only package was downloaded');
  return h;
}

function collect() {
  try { cpSync(join(dataHome, 'logs'), join(art, 'legion-logs'), { recursive: true }); } catch { /* none */ }
  try { for (const n of readdirSync(dataHome)) if (/^core\.log/.test(n)) cpSync(join(dataHome, n), join(art, n)); } catch { /* none */ }
  for (const [from, to] of [[join(up, 'apply.log'), 'apply.log'], [join(up, 'journal.json'), 'journal.json'], [join(up, 'outcome.json'), 'outcome.json'], [join(dataHome, 'updater', 'state.json'), 'updater-state.json'], [join(up, 'run', 'job.json'), 'job.json'], [join(install, '.legion-install.json'), 'marker.json']]) {
    try { if (existsSync(from)) cpSync(from, join(art, to)); } catch { /* best effort */ }
  }
  const p = procs().all.map((x) => `${x.pid} ${x.cmd.slice(0, 200)}`);
  try { writeFileSync(join(art, 'procs-at-end.txt'), p.join('\n') + '\n'); } catch { /* best effort */ }
}
async function report() {
  const h = await health();
  const j = readJson(join(up, 'journal.json')), o = readJson(join(up, 'outcome.json'));
  const al = read(join(up, 'apply.log')).split('\n').filter((l) => / apply \S+ -> \S+/.test(l)).map((l) => l.match(/apply \S+ -> \S+/)[0]);
  const line = `REPORT ${scenario} (${process.platform}-${process.arch}): running ${h?.version ?? 'nothing answering'}; install ${instVersion() ?? '-'}; marker ${existsSync(join(install, '.legion-install.json')) ? 'yes' : 'no'}; data folder ${dataOk() ? 'survived' : 'LOST'}; journal ${j?.state ?? '-'}, outcome ${o?.result ?? '-'}; swaps: ${al.join(' | ') || 'none'}; ${Math.round((Date.now() - t0) / 1000)} s`;
  log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${line}\n`);
}

// ================================ scenarios ================================
async function scenarioUpdate() {
  makeBaselineRepo();
  baselineInstalled();
  const nmStamp = await sha(join(install, 'node_modules', '.package-lock.json'));
  startServer();
  startApp('baseline');
  const h0 = await healthy(BASE);
  check(!!h0, `the installed ${BASE} starts and reports health`);
  if (!h0) throw new Error('the baseline never became healthy');
  await updateTo(GOOD, 'unix-good', BASE);
  check((await sha(join(install, 'node_modules', '.package-lock.json'))) === nmStamp, 'node_modules was not touched by the swap');
  check(existsSync(electronBin), 'the Electron binary is still there');

  // the rollback leg: 0.99.1 starts and exits at once
  killInstalled();
  startApp(`${GOOD}, for the bad build`);
  check(!!(await healthy(GOOD)), `${GOOD} starts again`);
  const before = await tree(install);
  serve('unix-bad');
  const st = await offered(BAD);
  check(!!st, `${BAD} is offered`);
  const r = await api('POST', '/api/update/install');
  check(r?.status === 200 && r.json?.ok === true, `the install click is accepted (HTTP ${r?.status ?? r?.err})`);
  const o = await waitFor('a rolled-back outcome', async () => (readJson(join(up, 'outcome.json'))?.result === 'rolled-back' ? readJson(join(up, 'outcome.json')) : null), 900_000);
  check(!!o, `the update to ${BAD} is rolled back (outcome rolled-back)`);
  check(!!(await healthy(GOOD, 240_000)), `${GOOD} answers /health again after the rollback`);
  check(readJson(join(up, 'journal.json'))?.state === 'rolled-back', 'the journal says rolled-back');
  const d = diff(before, await tree(install));
  check(d.length === 0, `the install is byte-identical to before the bad update${d.length ? `; differs: ${d.slice(0, 8).join(', ')}` : ''}`);
  check(!!(await waitFor('the failed version to be recorded', async () => (readJson(join(dataHome, 'updater', 'state.json'))?.failedVersions?.includes(BAD) ? true : null), 60_000)), `${BAD} is recorded as failed (held back)`);
  check(!existsSync(join(up, 'failed')), '.update/failed was removed');
  check(dataOk(), '~/.legion survived the failed update');
  check(winHits().length === 0, 'no *-win-x64.zip was requested');

  // the installer on the swapped tree: only the updater's own changes, so it must go through and put 0.98.0 back
  killInstalled();
  const dirt = git(install, 'status', '--porcelain').out.trim();
  log(`dirt before the installer re-run: ${dirt.replace(/\n/g, ' | ').slice(0, 300) || '(none)'}`);
  const again = runInstaller('install-rerun');
  check(again.status === 0, `install.sh runs again on the swapped tree (exit ${again.status})`);
  if (again.status !== 0) log(again.out.split('\n').slice(-12).join('\n'));
  check(instVersion() === BASE, `package.json is back to ${BASE}`);
  check(markerOk() && gitClean(), 'the marker is valid and git status is clean again');
  check(!existsSync(join(up, 'journal.json')), 'the stale journal was cleared');
  check(dataOk(), '~/.legion is untouched by the installer');
  startApp('after the installer re-run');
  check(!!(await healthy(BASE)), `${BASE} answers /health again`);
  const st2 = await status();
  check(st2?.mode === 'apply', `the mode is apply again (${st2?.mode})`);
}

async function scenarioFrozen() {
  makeBaselineRepo();
  // the REAL v0.3.4 and its own installer, from github.com
  const r = await fetch('https://raw.githubusercontent.com/dnh33/legion/v0.3.4/scripts/install/install.sh');
  check(r.ok, `fetched v0.3.4's install.sh (HTTP ${r.status})`);
  const frozenSh = join(work, 'install-v0.3.4.sh'); writeFileSync(frozenSh, await r.text());
  const ins = run('install-frozen', 'sh', [frozenSh, '--no-launch', '--version', '0.3.4', '--dir', install]);
  check(ins.status === 0, `the real v0.3.4 installed with its own installer (exit ${ins.status})`);
  if (ins.status !== 0) { log(ins.out.split('\n').slice(-25).join('\n')); throw new Error('the v0.3.4 install failed'); }
  check(instVersion() === '0.3.4', 'package.json says 0.3.4');
  check(!existsSync(join(install, '.legion-install.json')), 'v0.3.4 left no marker');
  startServer();
  serve('unix-good');
  startApp('v0.3.4');
  const h0 = await healthy('0.3.4');
  check(!!h0, 'the installed 0.3.4 starts and reports health');
  if (!h0) throw new Error('0.3.4 never became healthy');
  const before = await tree(install);
  const st = await offered(GOOD);
  check(!!st, `${GOOD} is offered to the frozen 0.3.4 (the notice channel works)`);
  check(st?.mode === 'checkout', `the frozen 0.3.4 reports mode checkout (got ${st?.mode})`);
  const i = await api('POST', '/api/update/install');
  check(i?.status === 409, `install() answers 409 (got ${i?.status ?? i?.err})`);
  await sleep(60_000);
  check(packageHits().length === 0 && winHits().length === 0, `no package was requested in 60 s (${packageHits().length} request(s))`);
  const after = await tree(install);
  check(diff(before, after).length === 0, 'the frozen install is unchanged');
  killInstalled();

  // the one-time step: this checkout's installer over the frozen clone. Its origin is github.com; the local repo stands in for it (test only).
  check(git(install, 'remote', 'set-url', 'origin', `${siteUrl()}/dnh33/legion.git`).status === 0, 'origin pointed at the local repo (test only)');
  const dirtyFrozen = git(install, 'status', '--porcelain').out.trim();
  log(`frozen clone before the conversion: ${dirtyFrozen ? dirtyFrozen.replace(/\n/g, ' | ').slice(0, 300) : 'clean'}`);
  const conv = runInstaller('install-convert');
  check(conv.status === 0, `this checkout's install.sh converts the frozen clone (exit ${conv.status})`);
  if (conv.status !== 0) { log(conv.out.split('\n').slice(-12).join('\n')); throw new Error('the conversion failed'); }
  check(instVersion() === BASE, `package.json says ${BASE}`);
  check(markerOk(), 'the marker exists and is valid');
  check(gitClean(), 'git status is clean');
  check(dataOk(), '~/.legion is untouched');
  rmSync(serveLog, { force: true }); writeFileSync(serveLog, '');
  startApp('converted');
  check(!!(await healthy(BASE)), `the converted install starts (${BASE})`);
  await updateTo(GOOD, 'unix-good', BASE);
}

async function scenarioRefuse() {
  makeBaselineRepo();
  baselineInstalled();
  const cfg = join(install, 'src', 'shared', 'config.ts');
  const orig = readFileSync(cfg, 'utf8');
  // an edit in src/ stops the installer and stays
  writeFileSync(cfg, `${orig}\n// my own edit\n`);
  let r = runInstaller('refuse-src');
  check(r.status !== 0 && /local changes/.test(r.out), `an edit in src/ makes the installer refuse (exit ${r.status})`);
  check(read(cfg).includes('// my own edit'), 'the edit is still there');
  check(instVersion() === BASE, 'nothing else was touched');
  writeFileSync(cfg, orig);
  // an untracked file outside the allowed set
  writeFileSync(join(install, 'notes.txt'), 'mine\n');
  r = runInstaller('refuse-untracked');
  check(r.status !== 0 && /local changes/.test(r.out) && existsSync(join(install, 'notes.txt')), 'an untracked file outside the code set makes it refuse and stays');
  rmSync(join(install, 'notes.txt'));
  // what the updater itself changes does not
  const readme = join(install, 'README.md');
  appendFileSync(readme, '\nchanged by an update\n');
  mkdirSync(join(up, 'staging'), { recursive: true });
  writeFileSync(join(up, 'journal.json'), '{"state":"committed"}\n');
  writeFileSync(join(install, 'build-info.json'), '{"version":"0.99.0"}\n');
  check(git(install, 'status', '--porcelain').out.trim() !== '', 'the tree looks like one an update left');
  r = runInstaller('rerun-after-swap');
  check(r.status === 0, `changes in the code set, .update and build-info.json do not stop it (exit ${r.status})`);
  if (r.status !== 0) log(r.out.split('\n').slice(-8).join('\n'));
  check(!read(readme).includes('changed by an update'), 'the code-set file is back to the release');
  check(!existsSync(join(up, 'journal.json')) && !existsSync(join(install, 'build-info.json')), 'the stale journal and build-info.json were cleared');
  check(markerOk() && gitClean(), 'the marker is valid and git status is clean');
  // a folder without the marker keeps the strict rule
  rmSync(join(install, '.legion-install.json'));
  appendFileSync(join(install, 'package.json'), '\n');
  r = runInstaller('refuse-no-marker');
  check(r.status !== 0 && /local changes/.test(r.out), `without the marker any change makes it refuse (exit ${r.status})`);
  check(dataOk(), '~/.legion is untouched');
}

async function scenarioNotify() {
  makeBaselineRepo();
  baselineInstalled();
  startServer();
  const unchanged = await tree(install);
  // package requests made since the current step began (the code release with a different lock does download its code package, to find the lock differs)
  let mark = 0;
  const newPackages = () => packageHits().slice(mark);
  const notice = async (folder, label, fn) => {
    mark = packageHits().length;
    killInstalled();
    serve(folder);
    startApp(label);
    check(!!(await healthy(BASE)), `${BASE} starts for ${label}`);
    await fn();
    check(winHits().length === 0, `no *-win-x64.zip was requested so far (${label})`);
  };
  // (e) a dependency-changing release with a signed Windows package: a notice, never the package
  await notice('stone', 'a dependency release', async () => {
    const st = await offered(GOOD);
    check(!!st, `${GOOD} (requires a full install) is offered as news`);
    check(st?.available?.requiresFullInstall === true && st?.available?.canFullInstall === false, `it is a notice: canFullInstall ${st?.available?.canFullInstall}`);
    const i = await api('POST', '/api/update/install');
    check(i?.status === 409 && /run the installer again/.test(i?.json?.error ?? ''), `install() answers 409 with the installer line (HTTP ${i?.status}: ${(i?.json?.error ?? i?.err ?? '').slice(0, 90)})`);
    await sleep(30_000);
    const s2 = await status();
    check(!s2?.staged && !s2?.readyToApply, 'nothing was staged');
    check(newPackages().length === 0, `no package of any kind was requested (${newPackages().length})`);
  });
  // a code release whose lock differs and that carries a Windows package: the code route is refused, the package is not fetched
  await notice('stone-stranded', 'a code release with a different lock', async () => {
    const st = await offered(prepared.versions.stranded);
    check(!!st, `${prepared.versions.stranded} (different lock, carries a Windows package) is offered`);
    const i = await api('POST', '/api/update/install');
    log(`install answered HTTP ${i?.status ?? i?.err}: ${JSON.stringify(i?.json ?? {}).slice(0, 200)}`);
    const s2 = await status();
    check(!s2?.staged && !s2?.readyToApply, 'nothing was staged');
    check(i?.status === 409 || i?.json?.ok === false, 'the install was refused');
    check(/run the installer again/.test(s2?.error ?? i?.json?.error ?? ''), `the installer line is shown (${(s2?.error ?? '').slice(0, 90)})`);
  });
  // (f) a tampered signature
  await notice('unix-badsig', 'a tampered manifest', async () => {
    const st = await checkNow();
    check(!st?.available, 'nothing is offered');
    check(/^rejected/.test(st?.check?.lastResult ?? ''), `the check says rejected (${st?.check?.lastResult})`);
    await sleep(15_000);
    check(newPackages().length === 0, 'no package was requested');
  });
  // a downgrade
  await notice('unix-old', 'an older release', async () => {
    const st = await checkNow();
    check(!st?.available, `nothing is offered (${st?.check?.lastResult})`);
    check(newPackages().length === 0, 'no package was requested');
  });
  // a folder without the marker (a hand-made clone) only gets a notice
  mark = packageHits().length;
  killInstalled();
  rmSync(join(install, '.legion-install.json'));
  serve('unix-good');
  startApp('no marker');
  check(!!(await healthy(BASE)), `${BASE} starts without the marker`);
  const st = await offered(GOOD);
  check(st?.mode === 'checkout', `mode is checkout without the marker (got ${st?.mode})`);
  const i = await api('POST', '/api/update/install');
  check(i?.status === 409, `install() answers 409 (${i?.status ?? i?.err})`);
  await sleep(20_000);
  check(newPackages().length === 0, 'no package was requested');
  killInstalled();
  const d = diff(unchanged, await tree(install)).filter((k) => k !== '.legion-install.json'); // the marker was removed on purpose
  check(d.length === 0, `the install is unchanged after every notice${d.length ? `; differs: ${d.slice(0, 8).join(', ')}` : ''}`);
  check(dataOk(), '~/.legion survived');
}

try {
  log(`scenario ${scenario} on ${process.platform}-${process.arch}, node ${process.versions.node}, display ${process.env.DISPLAY ?? '(none)'}`);
  const fn = { update: scenarioUpdate, frozen: scenarioFrozen, refuse: scenarioRefuse, notify: scenarioNotify }[scenario];
  if (!fn) throw new Error(`unknown scenario ${scenario}`);
  await fn();
} catch (e) {
  problems.push(`aborted: ${e.message}`);
  log(`FAIL  aborted: ${e.stack ?? e.message}`);
} finally {
  try { await report(); } catch { /* best effort */ }
  try { collect(); } catch { /* best effort */ }
  killInstalled();
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
}
log(problems.length ? `${problems.length} problem(s):\n  ${problems.join('\n  ')}` : 'all checks passed');
process.exit(problems.length ? 1 : 0);
