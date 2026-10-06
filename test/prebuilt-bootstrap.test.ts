/**
 * The prebuilt-package route of setup, in the real PowerShell: package-bootstrap.ps1 against a fake release server on 127.0.0.1 (the mirror only works with
 * LEGION_TEST_MODE=1 AND a loopback http address) and the real setup.ps1 up to the shortcuts. Runs wherever a PowerShell exists; github.com is never contacted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { allPowerShells, q } from './ps-helpers.js';
import { makeZip, sha256 } from './node-fake.js';
import { builtTree, fakeElectronDist, fakeNodeModules, load, put, REPO, tmp } from './prebuilt-helpers.js';

const shells = allPowerShells();
const posix = process.platform !== 'win32';
const lib = (n: string): string => join(REPO, 'scripts', 'lib', n);

interface Run { status: number | null; out: string; json?: any }
function ps(exe: string, file: string, env: Record<string, string | undefined>, args: string[] = []): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(exe, ['-NoProfile', '-File', file, ...args], { env: { ...process.env, ...env } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('close', (status) => {
      const last = out.trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop(); let json: any; try { json = last ? JSON.parse(last) : undefined; } catch { /* not json */ }
      resolve({ status, out, json });
    });
  });
}
function snippet(exe: string, dir: string, body: string, env: Record<string, string | undefined> = {}): Promise<Run> {
  const f = join(dir, `s${Math.random().toString(36).slice(2)}.ps1`);
  writeFileSync(f, [`$ErrorActionPreference = 'Stop'`, `. ${q(lib('legion-procs.ps1'))}; . ${q(lib('safe-io.ps1'))}; . ${q(lib('package-bootstrap.ps1'))}`, body].join('\n'));
  return ps(exe, f, env);
}

interface Fake { url: string; hits: string[]; mode: { v: 'good' | 'redirect' | 'oversize' | 'truncated' }; close(): Promise<void> }
async function fakeRelease(zip: Buffer, name: string): Promise<Fake> {
  const hits: string[] = []; const mode = { v: 'good' as 'good' | 'redirect' | 'oversize' | 'truncated' };
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url !== `/dnh33/legion/releases/download/v0.9.0/${name}`) { res.writeHead(404); res.end('no'); return; }
    if (mode.v === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:9/evil.zip' }); res.end(); return; }
    if (mode.v === 'truncated') { res.writeHead(200, { 'content-length': String(zip.length) }); res.write(zip.subarray(0, 40)); setTimeout(() => res.destroy(), 20); return; }
    if (mode.v === 'oversize') { res.writeHead(200, { 'content-length': String(50 * 1024 * 1024) }); res.end(Buffer.alloc(100)); return; }
    res.writeHead(200, { 'content-length': String(zip.length) }); res.end(zip);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, hits, mode, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

let built: { zip: Buffer; name: string; sha: string; file: string } | undefined;
async function goodPackage() {
  if (built) return built;
  const { buildPackage } = await load('scripts/build-package.mjs');
  const out = tmp('prebuilt-ps-out-');
  const r = await buildPackage({ repo: REPO, root: builtTree(), out, publishedAt: '2026-10-20T10:00:00Z', commit: 'abc', dirty: false, nodeModules: fakeNodeModules(), electronDist: fakeElectronDist(), electronVersion: '44.5.1', selfcheck: false });
  const zip = readFileSync(r.zip); built = { zip, name: 'legion-0.9.0-win-x64.zip', sha: sha256(zip), file: r.zip };
  return built;
}
const env = (dir: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => {
  const home = join(dir, 'home'); mkdirSync(home, { recursive: true });
  return { HOME: home, USERPROFILE: home, TEMP: dir, TMP: dir, TMPDIR: dir, LOCALAPPDATA: join(home, 'AppData', 'Local'), ...extra };
};
const GET = (o: { path?: string; url?: string; sha?: string; yes?: boolean; inter?: boolean; ask?: boolean; temp: string }): string => `
$script:asked = 0
$r = Get-LegionPackageFolder -PackagePath ${q(o.path ?? '')} -PackageUrl ${q(o.url ?? '')} -Sha256 ${q(o.sha ?? '')} -Ask { param($q, $d) $script:asked++; ${o.ask ? '$true' : '$false'} } -Say { param($m, $c) } -AssumeYes ${o.yes ? '$true' : '$false'} -Interactive ${o.inter === false ? '$false' : '$true'} -TempRoot ${q(o.temp)}
@{ ok = $r.Ok; dir = $r.Dir; temp = $r.Temp; message = $r.Message; asked = $script:asked } | ConvertTo-Json -Compress`;

for (const exe of shells) {
  test(`[${exe}] -PackageUrl: only https github.com release addresses with the exact path pass; everything else is refused with a reason`, async () => {
    const dir = tmp('prebuilt-ps-');
    const good = 'https://github.com/dnh33/legion/releases/download/v0.2.0/legion-0.2.0-win-x64.zip';
    const bad = ['http://github.com/dnh33/legion/releases/download/v0.2.0/legion-0.2.0-win-x64.zip', 'https://evil.example/dnh33/legion/releases/download/v0.2.0/legion-0.2.0-win-x64.zip',
      'https://github.com.evil.example/dnh33/legion/releases/download/v0.2.0/legion-0.2.0-win-x64.zip', 'https://github.com@evil.example/dnh33/legion/releases/download/v0.2.0/legion-0.2.0-win-x64.zip',
      'https://github.com:8443/dnh33/legion/releases/download/v0.2.0/legion-0.2.0-win-x64.zip', 'https://objects.githubusercontent.com/dnh33/legion/releases/download/v0.2.0/legion-0.2.0-win-x64.zip',
      'https://github.com/other/legion/releases/download/v0.2.0/legion-0.2.0-win-x64.zip', 'https://github.com/dnh33/legion/releases/download/v0.2.0/legion-0.2.1-win-x64.zip',
      'https://github.com/dnh33/legion/releases/download/v0.2.0/legion-0.2.0-app.zip', 'https://github.com/dnh33/legion/releases/download/v0.2.0/legion-0.2.0-win-x64.zip?x=1',
      'https://github.com/dnh33/legion/archive/main.zip', 'ftp://github.com/x', 'not a url', 'https://github.com/dnh33/legion/releases/download/v0.2.0/../../x/legion-0.2.0-win-x64.zip'];
    const body = `@{ good = Test-PackageUrl ${q(good)}; bad = @(${bad.map((b) => `(Test-PackageUrl ${q(b)})`).join(',')}) } | ConvertTo-Json -Compress`;
    const r = await snippet(exe, dir, body, env(dir));
    assert.equal(r.json?.good, null, r.out);
    assert.equal(r.json.bad.length, bad.length);
    const { checkPackageUrl } = await (await import('./prebuilt-helpers.js')).lib(); // the JS mirror of the rule agrees on every input
    assert.equal(checkPackageUrl(good), null); for (const b of bad) assert.equal(typeof checkPackageUrl(b), 'string', `JS mirror should refuse ${b}`);
    r.json.bad.forEach((x: unknown, i: number) => assert.equal(typeof x, 'string', `should be refused: ${bad[i]}`));
  });

  test(`[${exe}] the mirror override does nothing without LEGION_TEST_MODE=1 (a stray variable in a user's environment changes nothing)`, async () => {
    const dir = tmp('prebuilt-ps-');
    const r = await snippet(exe, dir, `@{ off = (Test-PackageUrl 'http://127.0.0.1:1234/dnh33/legion/releases/download/v0.9.0/legion-0.9.0-win-x64.zip') } | ConvertTo-Json -Compress`, env(dir, { LEGION_TEST_PKG_MIRROR: 'http://127.0.0.1:1234' }));
    assert.equal(typeof r.json?.off, 'string', r.out);
  });

  test(`[${exe}] local zip with the right sha256 (given, or from SHA256SUMS.txt) is unpacked; folder kind is package; no question asked`, async () => {
    const dir = tmp('prebuilt-ps-'); const p = await goodPackage();
    const a = await snippet(exe, dir, GET({ path: p.file, sha: p.sha, temp: dir }), env(dir));
    assert.equal(a.json?.ok, true, a.out); assert.equal(a.json.asked, 0); assert.ok(existsSync(join(a.json.dir, 'build-info.json')));
    const kit = tmp('prebuilt-kit-'); copyFileSync(p.file, join(kit, p.name)); writeFileSync(join(kit, 'SHA256SUMS.txt'), `${p.sha}  ${p.name}\n`);
    const b = await snippet(exe, dir, GET({ path: join(kit, p.name), temp: dir, yes: true, inter: false }), env(dir));
    assert.equal(b.json?.ok, true, b.out);
    const k = await snippet(exe, dir, `Get-LegionFolderKind ${q(a.json.dir)}`, env(dir)); assert.match(k.out, /package/);
  });

  test(`[${exe}] a wrong sha256 stops BEFORE anything is unpacked (nothing but the temp folder is touched, and it is removed)`, async () => {
    const dir = tmp('prebuilt-ps-'); const p = await goodPackage();
    const r = await snippet(exe, dir, GET({ path: p.file, sha: 'a'.repeat(64), temp: dir }), env(dir));
    assert.equal(r.json?.ok, false); assert.match(r.json.message, /does not match the SHA-256 you gave.*Nothing was unpacked/);
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('legion-setup-')), [], 'temp removed');
    const junk = await snippet(exe, dir, GET({ path: p.file, sha: 'zz', temp: dir }), env(dir));
    assert.equal(junk.json?.ok, false); assert.match(junk.json.message, /64 hex/);
  });

  test(`[${exe}] no checksum: -Yes and non-interactive runs are refused (-Yes never answers "does this match the page?"); an interactive yes is accepted, an interactive no is not`, async () => {
    const dir = tmp('prebuilt-ps-'); const p0 = await goodPackage();
    const lone = join(tmp('prebuilt-lone-'), p0.name); copyFileSync(p0.file, lone); const p = { ...p0, file: lone }; // no SHA256SUMS.txt next to it
    const y = await snippet(exe, dir, GET({ path: p.file, yes: true, temp: dir }), env(dir)); assert.equal(y.json?.ok, false); assert.match(y.json.message, /checksum/i); assert.equal(y.json.asked, 0);
    const n = await snippet(exe, dir, GET({ path: p.file, inter: false, temp: dir }), env(dir)); assert.equal(n.json?.ok, false); assert.equal(n.json.asked, 0);
    const no = await snippet(exe, dir, GET({ path: p.file, ask: false, temp: dir }), env(dir)); assert.equal(no.json?.ok, false); assert.equal(no.json.asked, 1);
    const yes = await snippet(exe, dir, GET({ path: p.file, ask: true, temp: dir }), env(dir)); assert.equal(yes.json?.ok, true, yes.out); assert.equal(yes.json.asked, 1);
  });

  test(`[${exe}] download: only after a yes; -Yes is the yes; no terminal and no -Yes means no; a refused address and a missing hash never reach the network`, async () => {
    const dir = tmp('prebuilt-ps-'); const p = await goodPackage(); const fake = await fakeRelease(p.zip, p.name);
    const e = env(dir, { LEGION_TEST_MODE: '1', LEGION_TEST_PKG_MIRROR: fake.url });
    const url = `${fake.url}/dnh33/legion/releases/download/v0.9.0/${p.name}`;
    try {
      const no = await snippet(exe, dir, GET({ url, sha: p.sha, ask: false, temp: dir }), e);
      assert.equal(no.json?.ok, false); assert.equal(no.json.asked, 1); assert.equal(fake.hits.length, 0, 'no download after a no');
      const quiet = await snippet(exe, dir, GET({ url, sha: p.sha, inter: false, temp: dir }), e);
      assert.equal(quiet.json?.ok, false); assert.equal(quiet.json.asked, 0, 'nobody to ask'); assert.equal(fake.hits.length, 0, 'no terminal, no -Yes: no download');
      const nosha = await snippet(exe, dir, GET({ url, yes: true, temp: dir }), e);
      assert.equal(nosha.json?.ok, false); assert.match(nosha.json.message, /needs -PackageSha256/); assert.equal(fake.hits.length, 0);
      const evil = await snippet(exe, dir, GET({ url: 'https://evil.example/x/legion-0.9.0-win-x64.zip', sha: p.sha, yes: true, temp: dir }), e);
      assert.equal(evil.json?.ok, false); assert.equal(fake.hits.length, 0);
      const yes = await snippet(exe, dir, GET({ url, sha: p.sha, yes: true, temp: dir }), e);
      assert.equal(yes.json?.ok, true, yes.out); assert.equal(fake.hits.length, 1);
      const ask = await snippet(exe, dir, GET({ url, sha: p.sha, ask: true, temp: dir }), e);
      assert.equal(ask.json?.ok, true, ask.out); assert.equal(ask.json.asked, 1);
    } finally { await fake.close(); }
  });

  test(`[${exe}] download: wrong hash (file deleted, nothing unpacked), redirect off the list, truncated body and oversize body are all refused`, async () => {
    const dir = tmp('prebuilt-ps-'); const p = await goodPackage(); const fake = await fakeRelease(p.zip, p.name);
    const e = env(dir, { LEGION_TEST_MODE: '1', LEGION_TEST_PKG_MIRROR: fake.url, LEGION_TEST_PKG_ZIP_MAX: '1000000' });
    const url = `${fake.url}/dnh33/legion/releases/download/v0.9.0/${p.name}`;
    try {
      const bad = await snippet(exe, dir, GET({ url, sha: 'b'.repeat(64), yes: true, temp: dir }), e);
      assert.equal(bad.json?.ok, false); assert.match(bad.json.message, /does not match the SHA-256/); assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('legion-setup-')), []);
      for (const m of ['redirect', 'truncated', 'oversize'] as const) {
        fake.mode.v = m; const r = await snippet(exe, dir, GET({ url, sha: p.sha, yes: true, temp: dir }), e);
        assert.equal(r.json?.ok, false, m); assert.match(r.json.message, /download failed|refused|truncated/i, m);
      }
    } finally { await fake.close(); }
  });

  test(`[${exe}] a hostile zip with the RIGHT hash is still refused: path escape, two top folders, not a package; nothing is written outside the temp folder`, async () => {
    const dir = tmp('prebuilt-ps-'); const outside = join(dir, 'outside'); mkdirSync(outside);
    const cases: Array<[string, Buffer]> = [
      ['escape', makeZip([{ name: 'legion-0.9.0/../../evil.txt', data: Buffer.from('x') }, { name: 'legion-0.9.0/a', data: Buffer.from('x') }])],
      ['absolute', makeZip([{ name: '/etc/evil.txt', data: Buffer.from('x') }])],
      ['two tops', makeZip([{ name: 'legion-0.9.0/build-info.json', data: Buffer.from('{"kind":"package","platform":"win32-x64"}') }, { name: 'legion-0.9.0/runtime/electron/electron.exe', data: Buffer.from('x') }, { name: 'legion-0.9.1/b', data: Buffer.from('x') }])],
      ['not a package', makeZip([{ name: 'legion-0.9.0/package.json', data: Buffer.from('{}') }])],
    ];
    for (const [name, zip] of cases) {
      const f = join(dir, `${name.replace(' ', '-')}.zip`); writeFileSync(f, zip);
      const r = await snippet(exe, dir, GET({ path: f, sha: sha256(zip), temp: dir }), env(dir));
      assert.equal(r.json?.ok, false, name); assert.match(r.json.message, /unsafe|could not be unpacked|exactly one|not a Legion Windows package/i, name);
    }
    assert.ok(!existsSync(join(dir, 'evil.txt')) && !existsSync(join(dir, '..', 'evil.txt')));
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('legion-setup-')), []);
  });

  test(`[${exe}] a lettered patch (0.2.5-g) is accepted for the zip's folder and the release address; other suffixes are refused`, async () => {
    const dir = tmp('prebuilt-ps-');
    const url = (v: string, w = v) => `https://github.com/dnh33/legion/releases/download/v${v}/legion-${w}-win-x64.zip`;
    const good = [url('0.2.5-g'), url('0.2.5-a'), url('0.2.5-z')];
    const bad = [url('0.2.5-'), url('0.2.5-gg'), url('0.2.5-G'), url('0.2.5-1'), url('0.2.5-g1'), url('0.2.5-g', '0.2.5'), url('0.2.5-g/x'), url('..'), url('0.2.5-g.1')];
    const body = `@{ good = @(${good.map((g) => `(Test-PackageUrl ${q(g)})`).join(',')}); bad = @(${bad.map((b) => `(Test-PackageUrl ${q(b)})`).join(',')}) } | ConvertTo-Json -Compress`;
    const r = await snippet(exe, dir, body, env(dir));
    assert.deepEqual(r.json?.good, [null, null, null], r.out);
    r.json.bad.forEach((x: unknown, i: number) => assert.equal(typeof x, 'string', `should be refused: ${bad[i]}`));
    const { checkPackageUrl } = await (await import('./prebuilt-helpers.js')).lib();
    for (const g of good) assert.equal(checkPackageUrl(g), null, `JS mirror should accept ${g}`);
    for (const b of bad) assert.equal(typeof checkPackageUrl(b), 'string', `JS mirror should refuse ${b}`);
    // the unpacked folder name uses the same rule
    const mk = (top: string) => makeZip([{ name: `${top}/build-info.json`, data: Buffer.from('{"kind":"package","platform":"win32-x64"}') }, { name: `${top}/runtime/electron/electron.exe`, data: Buffer.from('x') }]);
    const okZip = mk('legion-0.2.5-g'); const fOk = join(dir, 'ok.zip'); writeFileSync(fOk, okZip);
    const ok = await snippet(exe, dir, GET({ path: fOk, sha: sha256(okZip), temp: dir }), env(dir));
    assert.equal(ok.json?.ok, true, ok.out);
    for (const top of ['legion-0.2.5-', 'legion-0.2.5-gg', 'legion-0.2.5-G', 'legion-0.2.5-g.1']) {
      const z = mk(top); const f = join(dir, `${top}.zip`); writeFileSync(f, z);
      const r2 = await snippet(exe, dir, GET({ path: f, sha: sha256(z), temp: dir }), env(dir));
      assert.equal(r2.json?.ok, false, top); assert.match(r2.json.message, /exactly one/i, top);
    }
  });

  test(`[${exe}] Get-LegionFolderKind: package, source, unknown`, async () => {
    const dir = tmp('prebuilt-ps-'); const src = tmp('prebuilt-src-'); put(src, 'package.json', '{}'); put(src, 'src/a.ts', '');
    const pkg = tmp('prebuilt-pk-'); put(pkg, 'build-info.json', JSON.stringify({ kind: 'package', platform: 'win32-x64' })); put(pkg, 'runtime/electron/electron.exe', '');
    const thin = tmp('prebuilt-th-'); put(thin, 'build-info.json', JSON.stringify({ version: '1.0.0' })); put(thin, 'runtime/electron/electron.exe', '');
    const r = await snippet(exe, dir, `@{ p = Get-LegionFolderKind ${q(pkg)}; s = Get-LegionFolderKind ${q(src)}; u = Get-LegionFolderKind ${q(tmp())}; t = Get-LegionFolderKind ${q(thin)} } | ConvertTo-Json -Compress`, env(dir));
    assert.deepEqual(r.json, { p: 'package', s: 'source', u: 'unknown', t: 'unknown' }, r.out);
  });

  test(`[${exe}] the process matcher finds a package's runtime\\electron\\electron.exe (main and core) and nothing else's`, async () => {
    const dir = tmp('prebuilt-ps-');
    const body = `
$procs = @(
  [pscustomobject]@{ ProcessId = 10; Name = 'electron.exe'; ExecutablePath = 'C:\\L\\Legion\\runtime\\electron\\electron.exe'; CommandLine = '"C:\\L\\Legion\\runtime\\electron\\electron.exe" "C:\\L\\Legion"' },
  [pscustomobject]@{ ProcessId = 11; Name = 'electron.exe'; ExecutablePath = 'C:\\L\\Legion\\runtime\\electron\\electron.exe'; CommandLine = '"C:\\L\\Legion\\runtime\\electron\\electron.exe" C:\\L\\Legion\\dist\\src\\bin\\legion-core.js' },
  [pscustomobject]@{ ProcessId = 12; Name = 'electron.exe'; ExecutablePath = 'C:\\Other\\runtime\\electron\\electron.exe'; CommandLine = '' },
  [pscustomobject]@{ ProcessId = 13; Name = 'electron.exe'; ExecutablePath = 'C:\\Users\\a\\AppData\\Local\\Programs\\Code\\Code.exe'; CommandLine = '' })
$found = @(Select-LegionProcesses -Processes $procs -RootCheck { param($r) $r -eq 'C:\\L\\Legion' })
@{ ids = @($found | ForEach-Object { $_.ProcessId }) } | ConvertTo-Json -Compress`;
    const r = await snippet(exe, dir, body, env(dir));
    assert.deepEqual(r.json?.ids, [10, 11], r.out);
  });

  if (posix) {
    test(`[${exe}] Install-LegionPackageFolder runs the package's own installer on its own runtime: installs, reports a blocked file with exit code 3, never touches the data folder`, async () => {
      const dir = tmp('prebuilt-ps-'); const p = await goodPackage();
      const un = await snippet(exe, dir, GET({ path: p.file, sha: p.sha, temp: dir }), env(dir)); const src = un.json.dir as string;
      const data = join(dir, 'data'); mkdirSync(data); writeFileSync(join(data, 'config.json'), '{"authToken":"keep"}');
      const dest = join(dir, 'Install Dir', 'Legion');
      const ok = await snippet(exe, dir, `$r = Install-LegionPackageFolder -Src ${q(src)} -InstallDir ${q(dest)} -DataDirs @(${q(data)}) -Say { param($m, $c) }; @{ ok = $r.Ok; code = $r.Code; msg = $r.Message } | ConvertTo-Json -Compress`, env(dir));
      assert.equal(ok.json?.ok, true, ok.out);
      assert.ok(existsSync(join(dest, 'runtime', 'electron', 'electron.exe')) && existsSync(join(dest, 'package.json')));
      assert.equal(readFileSync(join(data, 'config.json'), 'utf8'), '{"authToken":"keep"}');
      const bad = await snippet(exe, dir, `$r = Install-LegionPackageFolder -Src ${q(src)} -InstallDir ${q(data)} -DataDirs @(${q(data)}) -Say { param($m, $c) }; @{ ok = $r.Ok; code = $r.Code; msg = $r.Message } | ConvertTo-Json -Compress`, env(dir));
      assert.equal(bad.json?.ok, false); assert.equal(bad.json.code, 2); assert.match(bad.json.msg, /data folder/);
      rmSync(join(src, 'dist-ui', 'index.html'));
      const blocked = await snippet(exe, dir, `$r = Install-LegionPackageFolder -Src ${q(src)} -InstallDir ${q(join(dir, 'L2'))} -Say { param($m, $c) }; @{ ok = $r.Ok; code = $r.Code; msg = $r.Message } | ConvertTo-Json -Compress`, env(dir));
      assert.equal(blocked.json?.code, 3); assert.match(blocked.json.msg, /antivirus.*index\.html.*did not retry/s);
      assert.equal(existsSync(join(dir, 'L2', 'package.json')), false);
    });

    test(`[${exe}] setup.ps1 from an installer kit (setup + scripts + one package zip + SHA256SUMS.txt): no Node, no npm, no build; installs the package (stops at the Windows-only shortcuts here)`, async () => {
      const dir = tmp('prebuilt-ps-'); const p = await goodPackage();
      const kit = join(dir, 'kit'); mkdirSync(join(kit, 'scripts', 'lib'), { recursive: true });
      for (const f of ['setup.ps1', 'uninstall.ps1']) copyFileSync(join(REPO, 'scripts', f), join(kit, 'scripts', f));
      for (const f of readdirSync(join(REPO, 'scripts', 'lib')).filter((n) => n.endsWith('.ps1'))) copyFileSync(join(REPO, 'scripts', 'lib', f), join(kit, 'scripts', 'lib', f));
      copyFileSync(p.file, join(kit, p.name)); writeFileSync(join(kit, 'SHA256SUMS.txt'), `${p.sha}  ${p.name}\n`);
      const dest = join(dir, 'Legion'); const e = env(dir);
      const r = await ps(exe, join(kit, 'scripts', 'setup.ps1'), e, ['-InstallDir', dest, '-Yes', '-NoLaunch']);
      assert.match(r.out, /Not needed: this is a prebuilt package/); assert.match(r.out, /package checked and unpacked/); assert.match(r.out, /Package installed and checked/);
      assert.doesNotMatch(r.out, /Checking Node\.js[^]*Node \d+\.\d+\.\d+ OK/); assert.doesNotMatch(r.out, /npm ci|Installing dependencies|Building/);
      assert.ok(existsSync(join(dest, 'runtime', 'electron', 'electron.exe')) && existsSync(join(dest, 'node_modules')));
      assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('legion-setup-')), [], 'the temp unpack folder is removed');
    });

    test(`[${exe}] setup.ps1 with no checksum for a kit zip, run with -Yes: refused, nothing installed`, async () => {
      const dir = tmp('prebuilt-ps-'); const p = await goodPackage();
      const kit = join(dir, 'kit'); mkdirSync(join(kit, 'scripts', 'lib'), { recursive: true });
      copyFileSync(join(REPO, 'scripts', 'setup.ps1'), join(kit, 'scripts', 'setup.ps1'));
      for (const f of readdirSync(join(REPO, 'scripts', 'lib')).filter((n) => n.endsWith('.ps1'))) copyFileSync(join(REPO, 'scripts', 'lib', f), join(kit, 'scripts', 'lib', f));
      copyFileSync(p.file, join(kit, p.name));
      const dest = join(dir, 'Legion');
      const r = await ps(exe, join(kit, 'scripts', 'setup.ps1'), env(dir), ['-InstallDir', dest, '-Yes', '-NoLaunch']);
      assert.notEqual(r.status, 0); assert.match(r.out, /No checksum to compare with/); assert.equal(existsSync(dest), false);
    });
  }
}
