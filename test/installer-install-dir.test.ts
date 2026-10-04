import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { allPowerShells, q, repoRoot, runPs, tempDir, writeFiles } from './ps-helpers.js';

// F2: setup mirrors the source into the install folder with robocopy /MIR, which deletes whatever else is there.
// These run the REAL Get-InstallDirVerdict / Get-TrimmedFullPath / Test-DriveRoot and the real setup.ps1 -DryRun on temp folders.

interface V { Ok: boolean; Reason: string }
const shells = allPowerShells();
const hostRoot = process.platform === 'win32' ? 'C:\\' : '/';

for (const exe of shells) {
  test(`install folder verdict: allow new / empty / Legion, refuse foreign, roots, profile, data, LEGION_HOME (${exe})`, () => {
    const dir = tempDir();
    try {
      const profile = join(dir, 'profile');
      const data = join(profile, '.legion');
      const home = join(dir, 'custom-home');
      writeFiles(dir, {
        'legion-install/package.json': '{ "name": "legion" }',
        'legion-install/anything/else.txt': 'x',
        'foreign/Documents/report.docx': 'precious',
        'foreign/package.json': '{ "name": "my-site" }',
        'afile': 'x',
        'profile/Documents/x.txt': 'x',
        'profile/.legion/config.json': '{}',
        'custom-home/config.json': '{}',
      });
      mkdirSync(join(dir, 'empty'));
      const cases: Record<string, string> = {
        missing: join(dir, 'does-not-exist'),
        empty: join(dir, 'empty'),
        legion: join(dir, 'legion-install'),
        foreign: join(dir, 'foreign'),
        file: join(dir, 'afile'),
        root: hostRoot,
        profileItself: profile,
        profileParent: dir,
        profileChild: join(profile, 'Programs', 'Legion'),
        dataItself: data,
        insideData: join(data, 'app'),
        homeItself: home,
        insideHome: join(home, 'app'),
        blank: '',
      };
      const body = [
        `$p = ${q(profile)}; $d = ${q(data)}; $h = ${q(home)}`,
        `$out = [ordered]@{}`,
        ...Object.entries(cases).map(([k, v]) =>
          `$out[${q(k)}] = Get-InstallDirVerdict -Dir ${q(v)} -UserProfile $p -DataDir $d -LegionHome $h`),
        `$out | ConvertTo-Json -Compress -Depth 4`,
      ].join('\n');
      const r = runPs<Record<string, V>>(exe, body, dir);
      const ok = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.Ok]));
      assert.deepEqual(ok, {
        missing: true, empty: true, legion: true,
        foreign: false, file: false, root: false,
        profileItself: false, profileParent: false, profileChild: true,
        dataItself: false, insideData: false, homeItself: false, insideHome: false, blank: false,
      });
      assert.match(r.foreign.Reason, /not empty and is not a Legion install/);
      assert.match(r.root.Reason, /drive root/);
      assert.match(r.profileItself.Reason, /user profile/);
      assert.match(r.dataItself.Reason, /Legion data folder/);
      assert.match(r.homeItself.Reason, /LEGION_HOME|Legion data folder/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`drive roots are recognised as roots, including the C: and C:\\ forms (${exe})`, () => {
    const dir = tempDir();
    try {
      const body = [
        `$o = [ordered]@{}`,
        ...['C:', 'C:\\', 'c:/', 'D:\\x', 'C:\\Users', 'C:\\Users\\', 'relative\\path'].map((p) => `$o[${q(p)}] = Test-DriveRoot ${q(p)}`),
        `$o | ConvertTo-Json -Compress`,
      ].join('\n');
      const r = runPs<Record<string, boolean>>(exe, body, dir);
      assert.deepEqual(r, { 'C:': true, 'C:\\': true, 'c:/': true, 'D:\\x': false, 'C:\\Users': false, 'C:\\Users\\': false, 'relative\\path': false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`Get-TrimmedFullPath trims a trailing separator but never turns a root into a drive-relative path (${exe})`, () => {
    const dir = tempDir();
    try {
      const body = [
        `$o = [ordered]@{}`,
        `$o['root'] = Get-TrimmedFullPath ${q(hostRoot)}`,
        `$o['trail'] = Get-TrimmedFullPath ${q(join(dir, 'sub') + (process.platform === 'win32' ? '\\' : '/'))}`,
        `$o | ConvertTo-Json -Compress`,
      ].join('\n');
      const r = runPs<{ root: string; trail: string }>(exe, body, dir);
      assert.equal(r.root, hostRoot, 'a root stays a root (never "C:")');
      assert.equal(r.trail, join(dir, 'sub'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`setup.ps1 -DryRun prints the resolved path and the decision, and refuses a foreign folder before touching anything (${exe})`, () => {
    const dir = tempDir('legion setup ');   // a path with a space
    try {
      writeFiles(dir, { 'foreign/Documents/report.docx': 'precious', 'ok-empty/.keep': '' });
      rmSync(join(dir, 'ok-empty', '.keep'));
      const env = { ...process.env, LEGION_HOME: join(dir, 'home') };
      const run = (installDir: string): { status: number | null; out: string } => {
        const r = spawnSync(exe, ['-NoProfile', '-File', join(repoRoot, 'scripts', 'setup.ps1'), '-DryRun', '-Yes', '-InstallDir', installDir],
          { encoding: 'utf8', env, stdin: 'ignore' } as never);
        return { status: r.status, out: `${r.stdout}${r.stderr}` };
      };
      const bad = run(join(dir, 'foreign'));
      assert.equal(bad.status, 1, bad.out);
      assert.ok(bad.out.includes(join(dir, 'foreign')), 'prints the resolved path');
      assert.match(bad.out, /install dir check: REFUSED/);
      assert.match(bad.out, /Refusing to install into/);
      assert.ok(!bad.out.includes('Checking Node.js'), 'refused before doing anything else');

      const homeRefused = run(join(dir, 'home'));
      assert.equal(homeRefused.status, 1, homeRefused.out);
      assert.match(homeRefused.out, /LEGION_HOME|Legion data folder/);

      const good = run(join(dir, 'ok-empty'));
      assert.match(good.out, /install dir check: OK - the folder is empty/);
      assert.ok(good.out.includes('Checking Node.js'), 'went on to the next step');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('F2 guard is wired in before robocopy and the old Test-Under helper is gone', () => {
  const s = readFileSync(join(repoRoot, 'scripts', 'setup.ps1'), 'utf8').replace(/\r\n/g, '\n');
  const iVerdict = s.indexOf('Get-InstallDirVerdict');
  const iRobo = s.indexOf('& robocopy');
  assert.ok(iVerdict > 0 && iRobo > iVerdict, 'verdict is computed before robocopy');
  assert.ok(s.indexOf('Get-InstallDirVerdict') < s.indexOf("Step 'Checking for a running Legion'"), 'and before any process is stopped');
  assert.doesNotMatch(s, /Test-Under\b/);
  assert.doesNotMatch(s, /TrimEnd\('\\'\)/, 'no bare TrimEnd of a backslash that turns C:\\ into C:');
});

test('setup.ps1 checks a bare drive letter as typed, before GetFullPath can turn "C:" into the current folder', () => {
  const s = readFileSync(join(repoRoot, 'scripts', 'setup.ps1'), 'utf8').replace(/\r\n/g, '\n');
  const iRoot = s.indexOf('if (Test-DriveRoot $InstallDir)');
  const iFull = s.indexOf('$InstallDir = Get-TrimmedFullPath $InstallDir');
  assert.ok(iRoot > 0 && iFull > iRoot);
});

for (const exe of shells) {
  test(`setup.ps1 refuses "C:" and "C:\\" as typed (${exe})`, () => {
    for (const target of ['C:', 'C:\\', 'c:/']) {
      const r = spawnSync(exe, ['-NoProfile', '-File', join(repoRoot, 'scripts', 'setup.ps1'), '-DryRun', '-Yes', '-InstallDir', target], { encoding: 'utf8' });
      assert.equal(r.status, 1, `${target}: ${r.stdout}${r.stderr}`);
      assert.match(`${r.stdout}${r.stderr}`, /drive root/);
    }
  });
}

// The one that actually bit (2026-10-04): the install folder was a git WORKTREE, so it had package.json named legion,
// passed the "is this a Legion install" test, and got installed into. The app then could never update itself, and every
// push to main landed inside the installed app. A clone has the same shape and the same failure.
for (const exe of shells) {
  test(`install folder verdict: REFUSES a git checkout, worktree or clone, even when it looks like a Legion install (${exe})`, () => {
    const dir = tempDir();
    try {
      writeFiles(dir, {
        // A worktree's .git is a FILE with a gitdir: line; a clone's is a directory. Both must be refused.
        'wt/package.json': '{ "name": "legion" }',
        'wt/dist/app.js': 'built',
        'wt/.git': 'gitdir: D:/somewhere/.git/worktrees/wt',
        'clone/package.json': '{ "name": "legion" }',
        'clone/dist/app.js': 'built',
      });
      mkdirSync(join(dir, 'clone', '.git'), { recursive: true });
      const body = [
        `$p = ${q(join(dir, 'profile'))}; $d = ${q(join(dir, 'data'))}; $h = ${q(join(dir, 'home'))}`,
        `$out = [ordered]@{}`,
        `$out[${q('worktree')}] = Get-InstallDirVerdict -Dir ${q(join(dir, 'wt'))} -UserProfile $p -DataDir $d -LegionHome $h`,
                `$out[${q('clone')}] = Get-InstallDirVerdict -Dir ${q(join(dir, 'clone'))} -UserProfile $p -DataDir $d -LegionHome $h`,
        `$out | ConvertTo-Json -Compress -Depth 4`,
      ].join('\n');
      const r = runPs<Record<string, V>>(exe, body, dir);
      assert.equal(r.worktree.Ok, false, 'a git worktree must never be accepted as an install folder');
      assert.equal(r.clone.Ok, false, 'a git clone must never be accepted as an install folder');
      assert.match(r.worktree.Reason, /git .*checkout|unable to update itself/i);
      assert.match(r.clone.Reason, /git .*checkout|unable to update itself/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
