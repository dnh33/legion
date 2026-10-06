import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { allPowerShells, q, repoRoot, tempDir } from './ps-helpers.js';
import { fakeSystemNode, goodNodeZip, makeZip, PIN, startFakeNode, type Fake, type Mode } from './node-fake.js';

// The real node-bootstrap.ps1 / setup.ps1 / uninstall.ps1 against a fake nodejs.org on 127.0.0.1 (the mirror only works with the test flag).
// Runs wherever a PowerShell exists (Windows PowerShell 5.1 and pwsh on the Windows runner; pwsh here); the real nodejs.org is never contacted.
const shells = allPowerShells();
const lib = (n: string): string => join(repoRoot, 'scripts', 'lib', n);
const noShell = shells.length === 0 ? 'no PowerShell on this machine' : false;

interface Run { status: number | null; out: string; json?: any }
function ps(exe: string, file: string, args: string[], env: Record<string, string | undefined>): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(exe, ['-NoProfile', '-File', file, ...args], { env: { ...process.env, ...env } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('close', (status) => {
      const last = out.trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop();
      let json: any; try { json = last ? JSON.parse(last) : undefined; } catch { /* not json */ }
      resolve({ status, out, json });
    });
  });
}

/** Runs a snippet after dot-sourcing the libs, with PATH set to `path` inside the script (so the shell itself is found first). */
function snippet(exe: string, dir: string, body: string, env: Record<string, string | undefined>, path: string[] = []): Promise<Run> {
  const f = join(dir, `s${Math.random().toString(36).slice(2)}.ps1`);
  writeFileSync(f, [
    `$ErrorActionPreference = 'Stop'`,
    `$env:PATH = ${q(path.join(delimiter))}`,
    `. ${q(lib('legion-procs.ps1'))}; . ${q(lib('safe-io.ps1'))}; . ${q(lib('node-bootstrap.ps1'))}`,
    body,
  ].join('\n'));
  return ps(exe, f, [], env);
}

const baseEnv = (dir: string, fake?: Fake, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => {
  const profile = join(dir, 'profile'); mkdirSync(profile, { recursive: true });
  return {
    HOME: profile, USERPROFILE: profile, TEMP: dir, TMP: dir, TMPDIR: dir, LOCALAPPDATA: join(profile, 'AppData', 'Local'),
    LEGION_TEST_MODE: fake ? '1' : undefined, LEGION_TEST_NODE_MIRROR: fake?.url, LEGION_TEST_ARCH: 'x64', ...extra,
  };
};

const INIT = (install: string, answer: boolean): string => `
$script:asked = 0
$r = Initialize-LegionNode -InstallDir ${q(install)} -Ask { param($q, $d) $script:asked++; ${answer ? '$true' : '$false'} } -Say { param($m, $c) }
@{ ok = $r.Ok; nodeDir = $r.NodeDir; message = $r.Message; asked = $script:asked } | ConvertTo-Json -Compress`;

const zipGood = goodNodeZip();
const runtimeNode = (install: string): string => join(install, 'runtime', 'node');
const leftovers = (install: string): string[] => { const r = join(install, 'runtime'); return existsSync(r) ? readdirSync(r).filter((n) => n.startsWith('.staging')) : []; };

// Windows PowerShell and pwsh run side by side: the two groups share nothing (own temp folders, own fake server on port 0,
// no environment changes), so one waits for the other only because node:test runs a file's tests in order. Inside each
// shell the tests stay in order, as before. 243 s -> about half.
describe('node bootstrap, each shell', { concurrency: true }, () => { for (const exe of shells) describe(exe, () => {
  test(`[${exe}] no Node + user says yes: downloads, verifies the sha256, installs into runtime\\node, marker last`, async () => {
    const dir = tempDir(); const fake = await startFakeNode(zipGood); const install = join(dir, 'Legion');
    try {
      const r = await snippet(exe, dir, INIT(install, true), baseEnv(dir, fake));
      assert.equal(r.json?.ok, true, r.out); assert.equal(r.json.asked, 1);
      assert.ok(existsSync(join(runtimeNode(install), 'node.exe')));
      assert.ok(existsSync(join(runtimeNode(install), '.legion-owned')));
      assert.deepEqual(leftovers(install), [], 'staging removed');
      assert.deepEqual(fake.hits.sort(), [`/dist/v${PIN}/SHASUMS256.txt`, `/dist/v${PIN}/node-v${PIN}-win-x64.zip`].sort());
    } finally { await fake.close(); }
  });

  test(`[${exe}] re-run is idempotent: no question, no download`, async () => {
    const dir = tempDir(); const fake = await startFakeNode(zipGood); const install = join(dir, 'Legion');
    try {
      assert.equal((await snippet(exe, dir, INIT(install, true), baseEnv(dir, fake))).json?.ok, true);
      const before = fake.hits.length;
      const r = await snippet(exe, dir, INIT(install, false), baseEnv(dir, fake));
      assert.equal(r.json?.ok, true, r.out); assert.equal(r.json.asked, 0); assert.equal(fake.hits.length, before);
      assert.equal(r.json.nodeDir, runtimeNode(install));
    } finally { await fake.close(); }
  });

  test(`[${exe}] a good system Node is used and nothing is downloaded`, async () => {
    const dir = tempDir(); const fake = await startFakeNode(zipGood); const install = join(dir, 'Legion');
    try {
      fakeSystemNode(join(dir, 'sys'), '22.22.0');
      const r = await snippet(exe, dir, INIT(install, true), baseEnv(dir, fake), [join(dir, 'sys')]);
      assert.equal(r.json?.ok, true, r.out); assert.equal(r.json.asked, 0); assert.equal(r.json.nodeDir, '');
      assert.equal(fake.hits.length, 0); assert.ok(!existsSync(join(install, 'runtime')));
    } finally { await fake.close(); }
  });

  test(`[${exe}] a too-old system Node (20.9.0) is not good enough: it asks`, async () => {
    const dir = tempDir(); const fake = await startFakeNode(zipGood); const install = join(dir, 'Legion');
    try {
      fakeSystemNode(join(dir, 'sys'), '20.9.0');
      const r = await snippet(exe, dir, INIT(install, false), baseEnv(dir, fake), [join(dir, 'sys')]);
      assert.equal(r.json?.ok, false); assert.equal(r.json.asked, 1); assert.match(r.json.message, /winget install OpenJS\.NodeJS\.LTS/);
      assert.equal(fake.hits.length, 0);
    } finally { await fake.close(); }
  });

  test(`[${exe}] the user says no: nothing downloaded, nothing installed, winget line printed`, async () => {
    const dir = tempDir(); const fake = await startFakeNode(zipGood); const install = join(dir, 'Legion');
    try {
      const r = await snippet(exe, dir, INIT(install, false), baseEnv(dir, fake));
      assert.equal(r.json?.ok, false); assert.equal(r.json.asked, 1); assert.match(r.json.message, /winget install OpenJS\.NodeJS\.LTS/);
      assert.equal(fake.hits.length, 0); assert.ok(!existsSync(runtimeNode(install)));
    } finally { await fake.close(); }
  });

  const failing: Array<{ mode: Mode; zip?: Buffer; what: RegExp; env?: Record<string, string> }> = [
    { mode: 'badsha', what: /does not match the official checksum/ },
    { mode: 'nosums', what: /no checksum for/ },
    { mode: 'truncated', what: /truncated|unexpected|closed|aborted|ended/i },
    { mode: 'oversize', what: /over the limit/, env: { LEGION_TEST_NODE_ZIP_MAX: '4096' } },
    { mode: 'redirect', what: /redirect/ },
    { mode: 'good', zip: makeZip([{ name: `node-v${PIN}-win-x64/node.exe`, data: Buffer.from('x') }, { name: `node-v${PIN}-win-x64/../../evil.txt`, data: Buffer.from('pwn') }]), what: /unsafe zip entry/ },
    { mode: 'good', zip: makeZip([{ name: '/abs/evil.txt', data: Buffer.from('pwn') }]), what: /unsafe zip entry/ },
    { mode: 'good', zip: makeZip([{ name: `node-v${PIN}-win-x64/a\\..\\..\\evil.txt`, data: Buffer.from('pwn') }]), what: /unsafe zip entry/ },
    { mode: 'good', zip: makeZip([{ name: 'C:evil.txt', data: Buffer.from('pwn') }]), what: /unsafe zip entry/ },
    { mode: 'good', zip: makeZip([{ name: `node-v${PIN}-win-x64/readme.txt`, data: Buffer.from('no node.exe here') }]), what: /does not contain/ },
  ];
  for (const f of failing) {
    test(`[${exe}] refused and nothing installed: ${f.mode} ${f.what}`, async () => {
      const dir = tempDir(); const fake = await startFakeNode(zipGood); const install = join(dir, 'Legion');
      try {
        fake.setMode(f.mode, f.zip);
        const r = await snippet(exe, dir, INIT(install, true), baseEnv(dir, fake, f.env));
        assert.equal(r.json?.ok, false, r.out); assert.match(r.json.message, f.what); assert.match(r.json.message, /winget install/);
        assert.ok(!existsSync(runtimeNode(install)), 'nothing installed');
        assert.deepEqual(leftovers(install), [], 'staging cleaned');
        assert.ok(!existsSync(join(dir, 'evil.txt')) && !existsSync(join(install, 'evil.txt')) && !existsSync(join(install, '..', 'evil.txt')));
      } finally { await fake.close(); }
    });
  }

  test(`[${exe}] production ignores the mirror variable unless the test flag is set (and a non-loopback mirror is ignored even with it)`, async () => {
    const dir = tempDir();
    const show = `$s = Get-NodeSource; @{ base = $s.Base; https = $s.Https; test = $s.Test } | ConvertTo-Json -Compress`;
    const noFlag = await snippet(exe, dir, show, { LEGION_TEST_MODE: undefined, LEGION_TEST_NODE_MIRROR: 'http://127.0.0.1:4444' });
    assert.equal(noFlag.json?.base, `https://nodejs.org/dist/v${PIN}/`); assert.equal(noFlag.json.test, false);
    const wrongFlag = await snippet(exe, dir, show, { LEGION_TEST_MODE: '0', LEGION_TEST_NODE_MIRROR: 'http://127.0.0.1:4444' });
    assert.equal(wrongFlag.json?.base, `https://nodejs.org/dist/v${PIN}/`);
    const evil = await snippet(exe, dir, show, { LEGION_TEST_MODE: '1', LEGION_TEST_NODE_MIRROR: 'http://evil.example:80' });
    assert.equal(evil.json?.base, `https://nodejs.org/dist/v${PIN}/`);
    const evil2 = await snippet(exe, dir, show, { LEGION_TEST_MODE: '1', LEGION_TEST_NODE_MIRROR: 'https://127.0.0.1:4444' });
    assert.equal(evil2.json?.base, `https://nodejs.org/dist/v${PIN}/`);
    const ok = await snippet(exe, dir, show, { LEGION_TEST_MODE: '1', LEGION_TEST_NODE_MIRROR: 'http://127.0.0.1:4444' });
    assert.equal(ok.json?.base, `http://127.0.0.1:4444/dist/v${PIN}/`);
    // the test-only caps are ignored without the flag too
    const cap = await snippet(exe, dir, `$script:LegionNodeZipMax`, { LEGION_TEST_MODE: undefined, LEGION_TEST_NODE_ZIP_MAX: '1' });
    assert.match(cap.out, /125829120/);
  });

  test(`[${exe}] setup.ps1 -NodeOnly: -Yes answers yes (downloads); without -Yes and no terminal the answer is no`, async () => {
    const dir = tempDir(); const fake = await startFakeNode(zipGood);
    try {
      const yesDir = join(dir, 'yes'); mkdirSync(yesDir);
      const setupEnv = (d: string): Record<string, string | undefined> => ({ ...baseEnv(d, fake), PATH: process.env.PATH });
      // PATH must not hold a node, but the shell must still start: run through a wrapper that clears PATH first
      const wrap = (d: string, extra: string): string => {
        const f = join(d, 'wrap.ps1');
        writeFileSync(f, `$env:PATH = ''; & ${q(join(repoRoot, 'scripts', 'setup.ps1'))} -InstallDir ${q(join(d, 'Legion'))} -NodeOnly ${extra}; exit $LASTEXITCODE`);
        return f;
      };
      const yes = await ps(exe, wrap(yesDir, '-Yes'), [], setupEnv(yesDir));
      assert.equal(yes.status, 0, yes.out); assert.ok(existsSync(join(runtimeNode(join(yesDir, 'Legion')), '.legion-owned')), yes.out);
      assert.equal(fake.hits.length, 2);
      const noDir = join(dir, 'no'); mkdirSync(noDir);
      const hitsBefore = fake.hits.length;
      const no = await ps(exe, wrap(noDir, ''), [], setupEnv(noDir));
      assert.notEqual(no.status, 0, no.out); assert.match(no.out, /winget install OpenJS\.NodeJS\.LTS/);
      assert.equal(fake.hits.length, hitsBefore); assert.ok(!existsSync(runtimeNode(join(noDir, 'Legion'))));
    } finally { await fake.close(); }
  });

  test(`[${exe}] uninstall removes the runtime only when Legion owns it, and never through a link`, async () => {
    const dir = tempDir(); const fake = await startFakeNode(zipGood); const install = join(dir, 'Legion');
    try {
      assert.equal((await snippet(exe, dir, INIT(install, true), baseEnv(dir, fake))).json?.ok, true);
      const rm = (): Promise<Run> => snippet(exe, dir, `$r = Remove-LegionRuntime -InstallDir ${q(install)}; @{ removed = $r.Removed; reason = $r.Reason } | ConvertTo-Json -Compress`, {});
      // unmarked folder: left alone
      const marker = join(runtimeNode(install), '.legion-owned'); const saved = readFileSync(marker);
      writeFileSync(marker, saved); // keep
      const { renameSync, rmSync } = await import('node:fs');
      renameSync(marker, join(dir, 'marker.bak'));
      const notOurs = await rm();
      assert.equal(notOurs.json?.removed, false, notOurs.out); assert.ok(existsSync(join(runtimeNode(install), 'node.exe')));
      renameSync(join(dir, 'marker.bak'), marker);
      // owned: removed
      const done = await rm();
      assert.equal(done.json?.removed, true, done.out); assert.ok(!existsSync(runtimeNode(install)));
      assert.ok(!existsSync(join(install, 'runtime')), 'empty runtime folder removed too');
      // a link where runtime\node would be: the link goes, the target and its files stay
      const target = join(dir, 'precious'); mkdirSync(target); writeFileSync(join(target, 'keep.txt'), 'keep');
      mkdirSync(join(install, 'runtime'), { recursive: true });
      symlinkSync(target, runtimeNode(install), process.platform === 'win32' ? 'junction' : 'dir');
      const viaLink = await rm();
      assert.equal(viaLink.json?.removed, true, viaLink.out);
      assert.ok(existsSync(join(target, 'keep.txt')), 'the link target was not touched');
      assert.ok(!existsSync(runtimeNode(install)));
      rmSync(dir, { recursive: true, force: true });
    } finally { await fake.close(); }
  });
}); });

test('PowerShell tests need a PowerShell', { skip: noShell }, () => { assert.ok(shells.length > 0); });

// Seen on a busy PC (2026-10-06): right after unpacking and running node.exe -v, something (an antivirus scan, the just-exited
// node.exe) still holds a file in the unpacked folder, and moving it into runtime\node failed with "Access ... is denied".
// Known Windows behaviour with the same bounded-retry fix: https://github.com/cloudsmith-io/cloudsmith-cli-install-script/pull/14
test('a folder held open for a moment is still moved into place; a hold that does not end gives up with the real error', { skip: noShell }, async () => {
  const exe = shells[0]!; const dir = tempDir();
  const from = join(dir, 'unpack', 'node'); mkdirSync(from, { recursive: true }); writeFileSync(join(from, 'node.exe'), 'x');
  const ready = join(dir, 'held'); const release = join(dir, 'release');
  const holder = join(dir, 'hold.ps1');
  writeFileSync(holder, [
    `$fs = [System.IO.File]::Open(${q(join(from, 'node.exe'))}, 'Open', 'Read', 'Read')`,
    `Set-Content -LiteralPath ${q(ready)} 'x'`,
    `$until = (Get-Date).AddSeconds(60); while (-not (Test-Path -LiteralPath ${q(release)}) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 50 }`,
    `$fs.Dispose()`,
  ].join('\n'));
  const held = ps(exe, holder, [], {});
  while (!existsSync(ready)) await new Promise((r) => setTimeout(r, 50));
  // without patience the move fails while the file is held (checked by exception type: the message is in the system language)
  const once = await snippet(exe, dir, `try { Move-DirectoryPatiently -From ${q(from)} -To ${q(join(dir, 'once'))} -Attempts 1; 'MOVED' } catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; 'FAILED ' + $e.GetType().Name }`, {});
  assert.match(once.out, /FAILED (UnauthorizedAccess|IO)Exception/, once.out);
  // a hold that outlasts the wait gives up with the real error, it does not hang
  const short = await snippet(exe, dir, `try { Move-DirectoryPatiently -From ${q(from)} -To ${q(join(dir, 'short'))} -Attempts 3 -DelayMs 50; 'MOVED' } catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; 'FAILED ' + $e.GetType().Name }`, {});
  assert.match(short.out, /FAILED (UnauthorizedAccess|IO)Exception/, short.out);
  // with patience it waits for the hold to end, then moves
  const patient = snippet(exe, dir, `Move-DirectoryPatiently -From ${q(from)} -To ${q(join(dir, 'final'))} -Attempts 200 -DelayMs 100; 'MOVED'`, {});
  await new Promise((r) => setTimeout(r, 700));
  writeFileSync(release, 'x');
  const r = await patient;
  assert.match(r.out, /MOVED/, r.out);
  assert.ok(existsSync(join(dir, 'final', 'node.exe')), 'the folder is in place');
  await held;
});
