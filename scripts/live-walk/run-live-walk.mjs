// Live walk: installs an OLD published Legion with its own install.ps1, then lets the app's OWN updater take it through the REAL
// GitHub releases (0.2.7 -> the 0.3.0 stepping stone -> the newest release), asserting health, version, data and the install folder at each hop.
// Nothing is faked: no loopback server, no throwaway key, no preload, no LEGION_INSTALL_BASE. The app is started the way a shortcut starts it,
// with one extra variable, LEGION_HOME (an isolated data folder). The rehearsal's test-only switches are refused here (see refuseTestSwitches).
// usage: node run-live-walk.mjs --install <dir> --work <dir> --from <version> [--to latest|<version>] [--stone <version>]
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { args, die, readZipEntry } from '../lib/release-lib.mjs';
import { planHops } from './plan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const a = args(process.argv.slice(2), { install: 'v', work: 'v', from: 'v', to: 'v', stone: 'v' });
for (const k of ['install', 'work', 'from']) if (!a[k]) die(`--${k} is required`);
const install = resolve(a.install), work = resolve(a.work);
const APP_PORT = 4747;
const RELEASES = 'https://github.com/dnh33/legion/releases';

/** The live walk must exercise the production update path. Any rehearsal or test switch in the environment would bend it, so it is a hard stop. */
const FORBIDDEN_ENV = ['LEGION_REHEARSAL', 'LEGION_INSTALL_BASE', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'];
for (const k of Object.keys(process.env)) if (FORBIDDEN_ENV.includes(k) || k.startsWith('REHEARSAL_')) die(`${k} is set. The live walk runs the production path and refuses test switches.`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const problems = [];
const check = (ok, msg) => { if (ok) log(`ok    ${msg}`); else { problems.push(msg); log(`FAIL  ${msg}`); } return ok; };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const sha = (p) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(p).on('data', (c) => h.update(c)).on('error', rej).on('end', () => res(h.digest('hex'))); });
async function health() { try { const r = await fetch(`http://127.0.0.1:${APP_PORT}/health`, { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() : null; } catch { return null; } }
async function waitFor(what, fn, ms) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) { log(`timed out waiting for ${what}`); return null; } await sleep(3000); } }
const ps = (cmd) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
/** Stops what runs from the install folder and the swap helpers it left in the temp folder. Runner only; the runner is thrown away after the job. */
function killInstalled() {
  const esc = (s) => s.replace(/'/g, "''");
  ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like '${esc(install)}\\*' -or $_.ExecutablePath -like '${esc(tmpdir())}\\legion-apply-*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
}

async function get(url, opts = {}) {
  for (let i = 1; ; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(120000), ...opts }); if (r.ok || r.status < 500 || i >= 3) return r; } catch (e) { if (i >= 3) throw e; }
    await sleep(3000 * i);
  }
}
async function download(url, dest) {
  const r = await get(url);
  if (!r.ok || !r.body) throw new Error(`${url} answered ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
}
async function latestVersion() {
  const r = await get(`${RELEASES}/latest`, { redirect: 'manual' });
  const m = /\/releases\/tag\/v(\d+\.\d+\.\d+)$/.exec(r.headers.get('location') ?? '');
  if (!m) throw new Error(`no version in the latest-release redirect (status ${r.status}, location ${r.headers.get('location')})`);
  return m[1];
}
const manifestOf = async (v, second) => {
  const r = await get(`${RELEASES}/download/v${v}/legion-update-manifest${second ? '-2' : ''}.json`);
  if (!r.ok) throw new Error(`manifest of v${v} answered ${r.status}`);
  return r.json();
};

mkdirSync(work, { recursive: true });
const home = join(work, 'home'), art = join(work, 'artifacts'), dl = join(work, 'download');
for (const d of [home, art, dl, join(home, 'updater')]) mkdirSync(d, { recursive: true });
const up = join(install, '.update');
const results = [];
let appPid = 0;

/** Every file of the hop's package must be in the install with the same bytes. A code package lists its files by unpacking; a full package carries PACKAGE-FILES.json. */
async function checkInstallAgainstRelease(version, manifest) {
  const second = manifest;
  const m = await manifestOf(version, second);
  const full = !!m.requiresFullInstall && !!m.fullAsset;
  const asset = full ? m.fullAsset : m.asset;
  const zip = join(dl, asset.name);
  await download(`${RELEASES}/download/v${version}/${asset.name}`, zip);
  const got = await sha(zip);
  const sizeOk = statSync(zip).size === asset.size;
  const files = [];
  if (full) {
    const list = JSON.parse(readZipEntry(readFileSync(zip), `legion-${version}/PACKAGE-FILES.json`)?.toString('utf8') ?? 'null');
    for (const f of list?.files ?? []) files.push({ rel: f.path, sha256: f.sha256 });
  } else {
    const x = join(dl, `x-${version}`); mkdirSync(x, { recursive: true });
    const t = spawnSync('tar', ['-xf', zip, '-C', x], { encoding: 'utf8' });
    if (t.status !== 0) throw new Error(`could not unpack ${asset.name}: ${t.stderr}`);
    const top = join(x, `legion-${version}`);
    const walk = async (d, rel) => { for (const n of readdirSync(d).sort()) { const p = join(d, n), r = rel ? `${rel}/${n}` : n; if (statSync(p).isDirectory()) await walk(p, r); else files.push({ rel: r, sha256: await sha(p) }); } };
    await walk(top, '');
    rmSync(x, { recursive: true, force: true });
  }
  rmSync(zip, { force: true });
  const wrong = [];
  for (const f of files) { try { if ((await sha(join(install, ...f.rel.split('/')))) !== f.sha256) wrong.push(f.rel); } catch { wrong.push(f.rel); } }
  return { full, asset: asset.name, manifestSha: asset.sha256 === got && sizeOk, count: files.length, wrong };
}

function collect() {
  try { cpSync(join(home, 'logs'), join(art, 'logs'), { recursive: true }); } catch { /* none */ }
  try { for (const n of readdirSync(home)) if (/^core\.log/.test(n)) cpSync(join(home, n), join(art, n)); } catch { /* none */ }
  for (const [from, to] of [[join(up, 'apply.log'), 'apply.log'], [join(up, 'journal.json'), 'journal.json'], [join(up, 'outcome.json'), 'outcome.json'], [join(home, 'updater', 'state.json'), 'updater-state.json'], [join(work, 'app.log'), 'app.log']]) {
    try { if (existsSync(from)) cpSync(from, join(art, to)); } catch { /* best effort */ }
  }
  // Lines worth a look in the installed copy's own logs: each must be fixed, explained or listed by the reviewer.
  const found = [];
  for (const d of [join(home, 'logs'), home]) {
    let names = []; try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!/\.(log|txt)$/i.test(n) && !/^core\.log/.test(n)) continue;
      let text = ''; try { if (!statSync(join(d, n)).isFile()) continue; text = readFileSync(join(d, n), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) if (/\b(error|warn(ing)?|fatal|unhandled|EBUSY|EPERM|ENOENT)\b/i.test(line)) found.push(`${n}: ${line.trim().slice(0, 240)}`);
    }
  }
  const seen = [...new Set(found)];
  log(`LOGS: ${seen.length} error/warning line(s) in the installed copy's logs`);
  for (const l of seen.slice(0, 60)) log(`LOG   ${l}`);
  return seen;
}

function summary(hops, logLines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const rows = results.map((r) => `| ${r.hop} | ${r.version} | ${r.running ?? '-'} | ${r.health} | ${r.installWhole} | ${r.data} | ${r.state} | ${r.route} |`);
  const head = `\n### Live walk ${a.from} -> ${hops.map((h) => h.version).join(' -> ')}: ${problems.length ? 'FAILED' : 'passed'}\n\n| Hop | Expected | Running | Health | Install whole | Data | Journal / outcome / failed | Route |\n|---|---|---|---|---|---|---|---|\n`;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${head}${rows.join('\n')}\n${problems.length ? `\nProblems:\n${problems.map((p) => `- ${p}`).join('\n')}\n` : ''}\nInstalled copy's logs: ${logLines.length} error/warning line(s)\n\`\`\`\n${logLines.slice(0, 40).join('\n')}\n\`\`\`\n`);
}

let hops = [];
let logLines = [];
try {
  const to = !a.to || a.to === 'latest' ? await latestVersion() : a.to;
  const stone = a.stone ?? readJson(join(here, '..', 'stepping-stones.json'))?.stones?.at(-1);
  hops = planHops({ from: a.from, to, stone });
  log(`live walk: ${a.from} -> ${hops.map((h) => `${h.version} (${h.manifest} manifest name)`).join(' -> ')}, installed at ${install}`);

  const bi = readJson(join(install, 'build-info.json'));
  check(bi?.version === a.from, `the install is ${a.from} (build-info.json says ${bi?.version})`);
  // A user's settings, as the defaults would make them after consent: check on launch, install by itself when idle. No other switch.
  writeFileSync(join(home, 'updater', 'settings.json'), JSON.stringify({ checkEnabled: true, autoInstallWhenIdle: true, intervalHours: 1 }));
  const marker = `user data that must survive every update ${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 16)}\n`;
  writeFileSync(join(home, 'livewalk-marker.txt'), marker);
  const dataOk = () => { try { return readFileSync(join(home, 'livewalk-marker.txt'), 'utf8') === marker; } catch { return false; } };

  const env = { ...process.env, CI: '', LEGION_HOME: home, ELECTRON_ENABLE_LOGGING: '1', ELECTRON_DISABLE_GPU: '1' };
  const appLog = openSync(join(work, 'app.log'), 'a');
  const child = spawn(join(install, 'runtime', 'electron', 'electron.exe'), [install, '--disable-gpu', '--disable-software-rasterizer', '--no-sandbox', '--disable-dev-shm-usage'], { env, detached: true, stdio: ['ignore', appLog, appLog], windowsHide: true });
  appPid = child.pid ?? 0; child.unref();
  log(`started the installed app, pid ${appPid}`);
  const h0 = await waitFor('the baseline app to answer /health', async () => { const h = await health(); return h?.ok ? h : null; }, 180000);
  check(!!h0 && h0.version === a.from, `the installed ${a.from} starts and reports health (got ${h0?.version})`);
  if (!h0) throw new Error('the baseline never became healthy');

  let n = 0;
  for (const hop of hops) {
    n++;
    const row = { hop: `${n} (${hop.manifest} name)`, version: hop.version, health: 'no', installWhole: '-', data: '-', state: '-', route: '-' };
    results.push(row);
    log(`hop ${n}: waiting for the app to find, download and apply ${hop.version} from the real release (no override)`);
    const h = await waitFor(`/health to report ${hop.version}`, async () => { const x = await health(); return x?.ok && x.version === hop.version ? x : null; }, 1500000);
    row.running = (await health())?.version ?? 'nothing answering';
    row.health = h ? 'yes' : 'NO';
    if (!check(!!h, `hop ${n}: ${hop.version} starts and reports health`)) { row.state = readJson(join(up, 'journal.json'))?.state ?? '-'; throw new Error(`hop ${n} never reached ${hop.version}`); }
    const committed = await waitFor('the journal to read committed', async () => { const j = readJson(join(up, 'journal.json')); return j?.state === 'committed' && j.to === hop.version ? j : null; }, 180000);
    check(!!committed, `hop ${n}: the journal says committed to ${hop.version}`);
    const outcome = readJson(join(up, 'outcome.json')); const st = readJson(join(home, 'updater', 'state.json'));
    copyState(n);
    check(!outcome || outcome.result === 'ok', `hop ${n}: no rollback or failure (outcome ${outcome?.result ?? 'none written'}${outcome?.reason ? `: ${outcome.reason}` : ''})`);
    check((st?.failedVersions ?? []).length === 0, `hop ${n}: no version is held back in updater state (failedVersions ${JSON.stringify(st?.failedVersions ?? [])})`);
    row.state = `${committed?.state ?? readJson(join(up, 'journal.json'))?.state ?? '-'} / ${outcome?.result ?? 'none'} / ${(st?.failedVersions ?? []).length} failed`;
    check(readJson(join(install, 'package.json'))?.version === hop.version && readJson(join(install, 'build-info.json'))?.version === hop.version, `hop ${n}: package.json and build-info.json say ${hop.version}`);
    const applyLog = existsSync(join(up, 'apply.log')) ? readFileSync(join(up, 'apply.log'), 'utf8') : '';
    row.route = applyLog.split('\n').filter((l) => l.includes(`-> ${hop.version}`)).length ? (applyLog.includes('re-running the swap helper') ? 'full package' : 'code package') : '?';
    if (row.route !== '?') log(`hop ${n}: route seen in apply.log up to now: ${row.route}`);
    const whole = await checkInstallAgainstRelease(hop.version, hop.manifest === 'second');
    row.installWhole = whole.wrong.length ? `NO (${whole.wrong.length} differ)` : `yes (${whole.count} files, ${whole.full ? 'full' : 'code'} package)`;
    check(whole.manifestSha, `hop ${n}: the real ${whole.asset} on GitHub matches the size and sha256 in its release manifest`);
    check(whole.wrong.length === 0 && whole.count > 0, `hop ${n}: the install folder holds all ${whole.count} files of ${whole.asset}${whole.wrong.length ? `; wrong: ${whole.wrong.slice(0, 5).join(', ')}` : ''}`);
    row.data = dataOk() ? 'survived' : 'LOST';
    check(dataOk(), `hop ${n}: user data in the data folder survived`);
    check(await waitFor('the old copy to be cleaned', async () => !existsSync(join(up, 'prev')), 180000) !== null, `hop ${n}: .update/prev was deleted after the healthy start`);
    if (n === hops.length && whole.full) {
      const claude = spawnSync(join(install, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'), ['--version'], { encoding: 'utf8', timeout: 30000 });
      check(claude.status === 0, `the bundled claude.exe runs (${(claude.stdout || claude.stderr || '').trim().slice(0, 40)})`);
    }
  }
} catch (e) {
  problems.push(`the walk stopped: ${e.message}`); log(`FAIL  the walk stopped: ${e.stack || e.message}`);
} finally {
  try { logLines = collect(); } catch (e) { log(`collect failed: ${e.message}`); }
  try { summary(hops, logLines); } catch { /* best effort */ }
  killInstalled();
}
function copyState(n) { try { cpSync(join(home, 'updater', 'state.json'), join(art, `updater-state-after-hop-${n}.json`)); } catch { /* none */ } try { cpSync(join(up, 'journal.json'), join(art, `journal-after-hop-${n}.json`)); } catch { /* none */ } }
if (problems.length) { console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`); process.exit(1); }
console.log('\nlive walk: passed');
