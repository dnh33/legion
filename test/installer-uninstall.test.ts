import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { allPowerShells, q, repoRoot, runPs, tempDir, writeFiles } from './ps-helpers.js';

// F8: the real uninstall.ps1 on real temp folders (a Windows-only API is never reached: shortcut folders sit in the temp HOME).

const shells = allPowerShells();
const LEGION_INSTALL = {
  'package.json': '{ "name": "legion" }',
  'dist/src/bin/legion-core.js': '//',
  'scripts/uninstall.ps1': '#',
  'uninstall.cmd': 'rem',
};

function setupUninstall(dir: string): string {
  // like uninstall.cmd does: the script and the helper together in one folder
  const t = join(dir, 'tmpu');
  mkdirSync(t, { recursive: true });
  copyFileSync(join(repoRoot, 'scripts', 'uninstall.ps1'), join(t, 'uninstall.ps1'));
  copyFileSync(join(repoRoot, 'scripts', 'lib', 'legion-procs.ps1'), join(t, 'legion-procs.ps1'));
  return join(t, 'uninstall.ps1');
}

function run(exe: string, script: string, dir: string, args: string[], extraEnv: Record<string, string> = {}): { status: number | null; out: string } {
  const profile = join(dir, 'profile');
  mkdirSync(profile, { recursive: true });
  const env = { ...process.env, HOME: profile, USERPROFILE: profile, TEMP: dir, TMP: dir, LOCALAPPDATA: join(profile, 'AppData', 'Local'), ...extraEnv };
  delete (env as Record<string, string | undefined>).LEGION_HOME;
  Object.assign(env, extraEnv);
  const r = spawnSync(exe, ['-NoProfile', '-File', script, ...args], { encoding: 'utf8', env, input: '' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

for (const exe of shells) {
  test(`uninstall: a missing helper gives a readable error and removes nothing (${exe})`, () => {
    const dir = tempDir();
    try {
      writeFiles(dir, { 'install/package.json': '{ "name": "legion" }', 'install/scripts/uninstall.ps1': '#', 'alone/x': '' });
      copyFileSync(join(repoRoot, 'scripts', 'uninstall.ps1'), join(dir, 'alone', 'uninstall.ps1'));
      const r = run(exe, join(dir, 'alone', 'uninstall.ps1'), dir, ['-InstallDir', join(dir, 'install'), '-Yes']);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /helper script legion-procs\.ps1 was not found/);
      assert.match(r.out, /Run setup\.cmd again/);
      assert.doesNotMatch(r.out, /CommandNotFoundException|At line:|\bat <ScriptBlock>/);
      assert.ok(existsSync(join(dir, 'install', 'package.json')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`uninstall: removes a real install, but never a source checkout (.git) or a foreign folder (${exe})`, () => {
    const dir = tempDir();
    try {
      writeFiles(dir, {
        ...Object.fromEntries(Object.entries(LEGION_INSTALL).map(([k, v]) => [`inst/${k}`, v])),
        ...Object.fromEntries(Object.entries(LEGION_INSTALL).map(([k, v]) => [`checkout/${k}`, v])),
        'checkout/.git/HEAD': 'ref',
        'foreign/package.json': '{ "name": "other" }',
        'foreign/scripts/uninstall.ps1': '#',
        'foreign/dist/src/bin/legion-core.js': '//',
        'nopkg/scripts/uninstall.ps1': '#',
      });
      const script = setupUninstall(dir);
      const inst = run(exe, script, dir, ['-InstallDir', join(dir, 'inst'), '-Yes']);
      assert.equal(inst.status, 0, inst.out);
      assert.equal(existsSync(join(dir, 'inst')), false, 'the install is removed');

      const co = run(exe, script, dir, ['-InstallDir', join(dir, 'checkout'), '-Yes']);
      assert.equal(co.status, 0, co.out);
      assert.match(co.out, /source checkout/);
      assert.ok(existsSync(join(dir, 'checkout', '.git', 'HEAD')), 'the checkout and its .git survive');
      assert.ok(existsSync(join(dir, 'checkout', 'package.json')));

      for (const bad of ['foreign', 'nopkg']) {
        const r = run(exe, script, dir, ['-InstallDir', join(dir, bad), '-Yes']);
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, /does not look like a Legion install/);
        assert.ok(existsSync(join(dir, bad)), `${bad} survives`);
      }
      const root = run(exe, script, dir, ['-InstallDir', process.platform === 'win32' ? 'C:\\' : '/', '-Yes']);
      assert.equal(root.status, 1, root.out);
      assert.match(root.out, /refusing/);
      const prof = run(exe, script, dir, ['-InstallDir', join(dir, 'profile'), '-Yes']);
      assert.equal(prof.status, 1, prof.out);
      assert.ok(existsSync(join(dir, 'profile')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`uninstall -Purge: LEGION_HOME without config.json is not deleted; with it, it is (${exe})`, () => {
    const dir = tempDir();
    try {
      const mk = (name: string): void => writeFiles(dir, Object.fromEntries(Object.entries(LEGION_INSTALL).map(([k, v]) => [`${name}/${k}`, v])));
      mk('instA'); mk('instB');
      writeFiles(dir, { 'foreign-home/Documents/precious.txt': 'x', 'real-home/config.json': '{}', 'real-home/workspaces/a.txt': 'x' });
      const script = setupUninstall(dir);
      const a = run(exe, script, dir, ['-InstallDir', join(dir, 'instA'), '-Purge', '-Yes'], { LEGION_HOME: join(dir, 'foreign-home') });
      assert.equal(a.status, 0, a.out);
      assert.match(a.out, /data folder NOT deleted/);
      assert.ok(existsSync(join(dir, 'foreign-home', 'Documents', 'precious.txt')));
      assert.equal(existsSync(join(dir, 'instA')), false);

      const b = run(exe, script, dir, ['-InstallDir', join(dir, 'instB'), '-Purge', '-Yes'], { LEGION_HOME: join(dir, 'real-home') });
      assert.equal(b.status, 0, b.out);
      assert.equal(existsSync(join(dir, 'real-home')), false, 'Legion data with config.json is purged');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`Get-PurgeVerdict: roots and the profile are refused (${exe})`, () => {
    const dir = tempDir();
    try {
      writeFiles(dir, { 'profile/.legion/config.json': '{}', 'x/y': '' });
      const body = [
        `$p = ${q(join(dir, 'profile'))}`,
        `$o = [ordered]@{}`,
        `$o.root = (Get-PurgeVerdict -DataDir ${q(process.platform === 'win32' ? 'C:\\' : '/')} -UserProfile $p).Ok`,
        `$o.profile = (Get-PurgeVerdict -DataDir $p -UserProfile $p).Ok`,
        `$o.parent = (Get-PurgeVerdict -DataDir ${q(dir)} -UserProfile $p).Ok`,
        `$o.default = (Get-PurgeVerdict -DataDir (Join-Path $p '.legion') -UserProfile $p).Ok`,
        `$o.envNoMarker = (Get-PurgeVerdict -DataDir ${q(join(dir, 'x'))} -UserProfile $p -FromEnv $true).Ok`,
        `$o | ConvertTo-Json -Compress`,
      ].join('\n');
      assert.deepEqual(runPs<Record<string, boolean>>(exe, body, dir), { root: false, profile: false, parent: false, default: true, envNoMarker: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('generated uninstall.cmd: checks both copies, cleans %TEMP%\\legion-uninstall, survives its own deletion', () => {
  const s = readFileSync(join(repoRoot, 'scripts', 'setup.ps1'), 'utf8').replace(/\r\n/g, '\n');
  const m = s.match(/\$unCmd = @\(([\s\S]*?)\) -join/);
  assert.ok(m, 'template found');
  const t = m[1];
  const iCopy1 = t.indexOf('uninstall.ps1" "%TMPU%');
  const iCopy2 = t.indexOf('legion-procs.ps1" "%TMPU%');
  assert.ok(iCopy1 > 0 && iCopy2 > iCopy1);
  const between = t.slice(iCopy1, iCopy2);
  assert.match(between, /if errorlevel 1 goto copyfail/, 'the first copy is checked');
  assert.match(t.slice(iCopy2, iCopy2 + 160), /if errorlevel 1 goto copyfail/, 'the second copy is checked');
  assert.match(t, /rd \/s \/q "%TMPU%"/, 'the temp folder is removed');
  assert.match(t, /echo Could not copy the uninstall script/);
  // the run line, the clean-up and the pause are one line, so cmd never reads from the deleted file again
  assert.match(t, /-InstallDir "%~dp0\." %PURGE% & cd \/d "%TEMP%" & rd \/s \/q "%TMPU%"[^\n]*& pause & exit \/b 0/);
  assert.doesNotMatch(s, /[^\x00-\x7f]/);
});
