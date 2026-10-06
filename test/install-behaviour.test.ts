/**
 * The one-line installers, run for real against nothing but a local fake: install.ps1 against a fake release server on 127.0.0.1
 * (LEGION_INSTALL_BASE) with a stub setup, and the helpers and argument handling of install.sh in a POSIX shell.
 * github.com is never contacted and nothing real is installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip, sha256 } from './node-fake.js';
import { q, tempDir } from './ps-helpers.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const installPs1 = join(root, 'scripts', 'install', 'install.ps1');
const installSh = join(root, 'scripts', 'install', 'install.sh');
const sh = readFileSync(installSh, 'utf8');

// ---------------------------------------------------------------- install.ps1 against a fake release server (Windows only)
const winPs = process.platform === 'win32' ? ['powershell', 'pwsh'].filter((e) => spawnSync(e, ['-NoProfile', '-Command', 'exit 0']).status === 0) : [];
const VERSION = '0.9.0';
const ZIP_NAME = `legion-${VERSION}-win-x64.zip`;
const STUB_SETUP = `param([switch]$Yes, [switch]$NoLaunch, [string]$InstallDir)
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Set-Content -LiteralPath (Join-Path $InstallDir 'marker.txt') -Value ("setup ran yes=$Yes nolaunch=$NoLaunch")
`;

type Mode = 'good' | 'badhash' | 'loop' | 'offhost';
interface Fake { base: string; hits: string[]; mode: { v: Mode }; close(): Promise<void> }
async function fakeServer(zip: Buffer): Promise<Fake> {
  const hits: string[] = []; const mode = { v: 'good' as Mode };
  const dl = `/dnh33/legion/releases/download/v${VERSION}/`;
  let port = 0;
  const server: Server = createServer((req, res) => {
    const u = req.url ?? ''; hits.push(u);
    if (u === '/dnh33/legion/releases/latest') { res.writeHead(302, { location: `/dnh33/legion/releases/tag/v${VERSION}` }); res.end(); return; }
    if (u === `${dl}SHA256SUMS.txt`) { res.writeHead(200); res.end(`${mode.v === 'badhash' ? '0'.repeat(64) : sha256(zip)}  ${ZIP_NAME}\n`); return; }
    if (u === `${dl}${ZIP_NAME}`) {
      if (mode.v === 'loop') { res.writeHead(302, { location: u }); res.end(); return; }
      if (mode.v === 'offhost') { res.writeHead(302, { location: `http://localhost:${port}/evil.zip` }); res.end(); return; }
      res.writeHead(200, { 'content-length': String(zip.length) }); res.end(zip); return;
    }
    if (u === '/evil.zip') { res.writeHead(200); res.end(zip); return; }
    res.writeHead(404); res.end('no');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, hits, mode, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

function fakeZip(): Buffer {
  const top = `legion-${VERSION}`;
  return makeZip([
    { name: `${top}/scripts/setup.ps1`, data: Buffer.from(STUB_SETUP) },
    { name: `${top}/scripts/lib/safe-io.ps1`, data: readFileSync(join(root, 'scripts', 'lib', 'safe-io.ps1')) },
  ]);
}

interface Run { out: string; temp: string; inst: string }
function runInstaller(exe: string, base: string, extra = ''): Promise<Run> {
  const dir = tempDir('install-fake-'); const temp = join(dir, 'tmp'); mkdirSync(temp, { recursive: true });
  const inst = join(dir, 'Legion install');
  // the script block form, as `irm | iex` with options; the shell must live to print SURVIVED
  const cmd = `try { & ([scriptblock]::Create((Get-Content -Raw -LiteralPath ${q(installPs1)}))) -NoLaunch -InstallDir ${q(inst)} ${extra} } catch { 'THREW: ' + $_.Exception.Message }; 'SURVIVED'`;
  return new Promise((res) => {
    const child = spawn(exe, ['-NoProfile', '-Command', cmd], { env: { ...process.env, LEGION_INSTALL_BASE: base, TEMP: temp, TMP: temp }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('close', () => res({ out, temp, inst }));
  });
}
const leftovers = (temp: string): string[] => readdirSync(temp).filter((n) => n.startsWith('legion-install-'));

for (const exe of winPs) {
  test(`[${exe}] install.ps1 against a fake release: latest redirect, hash ok, stub setup runs, temp removed`, async () => {
    const f = await fakeServer(fakeZip());
    try {
      const r = await runInstaller(exe, f.base);
      assert.match(r.out, /Note: LEGION_INSTALL_BASE is set/);
      assert.match(r.out, /Version: 0\.9\.0/);
      assert.match(r.out, /it matches/);
      assert.match(r.out, /SURVIVED/);
      assert.doesNotMatch(r.out, /THREW/);
      assert.equal(readFileSync(join(r.inst, 'marker.txt'), 'utf8').trim(), 'setup ran yes=True nolaunch=True');
      assert.deepEqual(leftovers(r.temp), []);
    } finally { await f.close(); }
  });

  test(`[${exe}] install.ps1: a wrong SHA-256 unpacks nothing, runs no setup, and the shell survives`, async () => {
    const f = await fakeServer(fakeZip()); f.mode.v = 'badhash';
    try {
      const r = await runInstaller(exe, f.base, '-Version 0.9.0');
      assert.match(r.out, /THREW: .*does not match the release's SHA-256/);
      assert.match(r.out, /Nothing was unpacked or installed/);
      assert.match(r.out, /SURVIVED/);
      assert.equal(existsSync(join(r.inst, 'marker.txt')), false);
      assert.deepEqual(leftovers(r.temp), []);
    } finally { await f.close(); }
  });

  test(`[${exe}] install.ps1: a redirect loop is refused after 3 hops`, async () => {
    const f = await fakeServer(fakeZip()); f.mode.v = 'loop';
    try {
      const r = await runInstaller(exe, f.base, '-Version 0.9.0');
      assert.match(r.out, /THREW: .*Too many redirects/);
      assert.match(r.out, /SURVIVED/);
      assert.equal(f.hits.filter((h) => h.endsWith(ZIP_NAME)).length, 4, 'the first request plus exactly 3 redirects');
      assert.equal(existsSync(join(r.inst, 'marker.txt')), false);
      assert.deepEqual(leftovers(r.temp), []);
    } finally { await f.close(); }
  });

  test(`[${exe}] install.ps1: a redirect to a host that is not allowed is refused without a request to it`, async () => {
    const f = await fakeServer(fakeZip()); f.mode.v = 'offhost';
    try {
      const r = await runInstaller(exe, f.base, '-Version 0.9.0');
      assert.match(r.out, /THREW: .*Refusing host localhost/);
      assert.match(r.out, /SURVIVED/);
      assert.ok(!f.hits.includes('/evil.zip'), 'the off-list host was never requested');
      assert.equal(existsSync(join(r.inst, 'marker.txt')), false);
      assert.deepEqual(leftovers(r.temp), []);
    } finally { await f.close(); }
  });

  test(`[${exe}] install.ps1: a version with a trailing line break is refused`, async () => {
    const f = await fakeServer(fakeZip());
    try {
      const r = await runInstaller(exe, f.base, '-Version ("0.9.0" + [char]10)');
      assert.match(r.out, /THREW: .*not a version number/);
      assert.equal(f.hits.length, 0, 'nothing was requested');
    } finally { await f.close(); }
  });
}

if (winPs.length === 0) test('install.ps1 fake-server tests need Windows PowerShell', { skip: 'not Windows: install.ps1 runs setup through Windows PowerShell' }, () => { /* skipped */ });

// ---------------------------------------------------------------- install.sh helpers and argument handling, in sh
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const skipSh = hasSh ? false : 'no sh on this machine';
/** A path as sh wants it (Git for Windows' sh needs /c/... for an absolute path, not C:/...). */
const px = (p: string): string => (process.platform === 'win32' ? spawnSync('cygpath', ['-u', p], { encoding: 'utf8' }).stdout.trim() : p);
const fn = (name: string): string => {
  const m = sh.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'));
  assert.ok(m, `${name} is defined at the top level of install.sh`);
  return m[0];
};

test('install.sh launcher: a folder with quotes, $, backticks and spaces is written as data, never run', { skip: skipSh }, () => {
  const work = tempDir('install-launcher-');
  const evil = `${px(work)}/a'b''c' $(touch PWNED) \`touch PWNED2\` "x" $HOME`;
  const launcher = `${px(work)}/legion`;
  // write the launcher, drop its last (exec) line, source the rest and print the folder variable
  const r = spawnSync('sh', ['-c', `${fn('write_launcher')}\nwrite_launcher "$EVIL" "$1"\nsed '$d' "$1" > "$1.head"\ncd "$2"\n. "$1.head"\nprintf '%s' "$dir"`, 'sh', launcher, px(work)], { encoding: 'utf8', env: { ...process.env, EVIL: evil } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, evil, 'the folder reads back exactly');
  assert.equal(existsSync(join(work, 'PWNED')), false);
  assert.equal(existsSync(join(work, 'PWNED2')), false);
  const body = readFileSync(join(work, 'legion'), 'utf8');
  assert.match(body, /^dir='.*'$/m);
  assert.match(body, /^exec "\$dir\/node_modules\/\.bin\/electron" "\$dir" "\$@"$/m);
});

test('install.sh launcher: pasting the folder inside double quotes, as the old writer did, does run code (negative control)', { skip: skipSh }, () => {
  const dir = tempDir('install-launcher-neg-'); const work = px(dir);
  const old = `printf 'x="%s"\\n' "$1" > "$2"; cd "$3"; sh "$2" >/dev/null 2>&1`;
  spawnSync('sh', ['-c', old, 'sh', 'a$(touch PWNED)', `${work}/l`, work], { encoding: 'utf8' });
  assert.equal(existsSync(join(dir, 'PWNED')), true, 'the old form injects, so the escaping test above can fail');
});

test('install.sh Node floor: 22.12 and newer pass; 22.11, 20.19 and older are refused', { skip: skipSh }, () => {
  const script = `${fn('node_version_ok')}\nnode_version_ok "$1"`;
  const ok = (v: string): boolean => spawnSync('sh', ['-c', script, 'sh', v], { encoding: 'utf8' }).status === 0;
  for (const v of ['22.12.0', '22.12.1', '22.20.0', '23.0.0', '24.21.0']) assert.equal(ok(v), true, v);
  for (const v of ['22.11.9', '22.0.0', '20.19.0', '20.10.0', '18.20.4', '21.7.0']) assert.equal(ok(v), false, v);
});

test('install.sh stops on bad options and bad folders before anything is downloaded', { skip: skipSh }, () => {
  const wdir = tempDir('install-args-'); const work = px(wdir);
  const home = `${work}/home`; mkdirSync(join(wdir, 'home'));
  // LEGION_INSTALL_BASE points at a dead port: if a test ever got as far as the network it would fail loudly, not reach GitHub.
  const run = (...args: string[]) => spawnSync('sh', [installSh, ...args], { encoding: 'utf8', cwd: wdir, env: { ...process.env, HOME: home, LEGION_INSTALL_BASE: 'http://127.0.0.1:9' } });

  // a folder starting with '-' is refused unless it comes after --
  let r = run('--dir', '-rf');
  assert.notEqual(r.status, 0); assert.match(r.stderr, /starts with a dash/);
  assert.equal(existsSync(join(wdir, '-rf')), false);
  r = run('--', 'extra');
  assert.notEqual(r.status, 0); assert.match(r.stderr, /Unexpected argument/);

  // a version with a line break is not a version (the check is on the whole string, not per line)
  // (the value goes in through the environment: Windows splits a command-line argument that holds a line break)
  r = spawnSync('sh', ['-c', 'exec sh "$0" --no-launch --dir rel --version "$V"', px(installSh)], { encoding: 'utf8', cwd: wdir, env: { ...process.env, HOME: home, V: '1.0.0\nx', LEGION_INSTALL_BASE: 'http://127.0.0.1:9' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a version number|Node\.js|npm|git is not/); // the tool checks may stop it first on a bare machine; never the network
  assert.doesNotMatch(r.stdout + r.stderr, /Fetching Legion|Updating/);

  // a relative --dir is resolved against the working directory before it is used
  run('--no-launch', '--dir', 'rel dir', '--version', 'bad');
  assert.ok(existsSync(join(wdir, 'rel dir')), 'the relative folder was made under the working directory');

  // an existing git folder that is not Legion's own clone is not touched; neither is a non-empty non-git folder
  const other = join(wdir, 'other'); mkdirSync(other);
  spawnSync('git', ['init', '-q', other]); spawnSync('git', ['-C', other, 'remote', 'add', 'origin', 'https://example.invalid/x.git']);
  writeFileSync(join(other, 'keep.txt'), 'mine');
  r = run('--no-launch', '--dir', px(other), '--version', '1.0.0');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /its origin is 'https:\/\/example\.invalid\/x\.git'|Node\.js .* is too old/);
  assert.equal(readFileSync(join(other, 'keep.txt'), 'utf8'), 'mine');
  assert.doesNotMatch(r.stdout, /Updating/);

  // a clone of the right origin with a local change is not touched; the same clone, clean, is accepted (and then fails only at the dead network)
  const mine = join(wdir, 'mine'); mkdirSync(mine);
  spawnSync('git', ['init', '-q', mine]); spawnSync('git', ['-C', mine, 'remote', 'add', 'origin', 'http://127.0.0.1:9/dnh33/legion.git']);
  writeFileSync(join(mine, 'edit.txt'), 'local work');
  r = run('--no-launch', '--dir', px(mine), '--version', '1.0.0');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /has local changes/);
  assert.equal(readFileSync(join(mine, 'edit.txt'), 'utf8'), 'local work');
  rmSync(join(mine, 'edit.txt'));
  r = run('--no-launch', '--dir', px(mine), '--version', '1.0.0');
  assert.match(r.stdout, /Updating .* to v1\.0\.0/);
  assert.match(r.stderr, /Could not fetch v1\.0\.0/);
});
