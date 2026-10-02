/** Static contracts of the package route (they run on every machine), the updater compatibility of the update zip, and the small units around them. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, createWriteStream, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus } from '../src/core/bus.js';
import { SettingsService } from '../src/core/settings.js';
import { checkTree } from '../src/core/updater/package.js';
import { swapIn } from '../src/core/updater/apply.js';
import { builtTree, fakeElectronDist, fakeNodeModules, installer, load, lib, put, REPO, sha, tmp } from './prebuilt-helpers.js';
import { defaultConfig } from '../src/shared/config.js';

const read = (rel: string): string => readFileSync(join(REPO, ...rel.split('/')), 'utf8');
const setup = read('scripts/setup.ps1'); const boot = read('scripts/lib/package-bootstrap.ps1');
const between = (s: string, a: string, b: string): string => { const i = s.indexOf(a); const j = s.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, `markers ${a} .. ${b}`); return s.slice(i, j); };

test('contract: the package branch of setup.ps1 has no Node check, no npm, no build and no robocopy mirror; the source branch still has them', () => {
  const pkgBranch = between(setup, "if ($kind -eq 'package' -or $wantZip) {\n    # PACKAGE", '} else {\n  # 3) Copy the source');
  assert.doesNotMatch(pkgBranch.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'), /robocopy|npm|Initialize-LegionNode|\/MIR|node\.exe/i);
  assert.match(pkgBranch, /Install-LegionPackageFolder/);
  const srcBranch = between(setup, '} else {\n  # 3) Copy the source', '# 5) Claude Code');
  assert.match(srcBranch, /robocopy/); assert.match(srcBranch, /npm ci/); assert.match(srcBranch, /npm run build/);
  assert.match(setup, /if \(\$kind -eq 'package' -or \$wantZip\) \{\n    Step 'Checking Node\.js'\n    Say 'Not needed/, 'the Node step is skipped for a package');
  assert.doesNotMatch(boot.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'), /robocopy|npm\b|\bgit\b/i);
});

test('contract: a zip is obtained (hash checked, unpacked) BEFORE Legion is stopped, and unpacked only after the hash compare', () => {
  assert.ok(setup.indexOf('Get-LegionPackageFolder') < setup.indexOf('Stop-LegionProcesses'), 'download and check happen while Legion still runs');
  const fn = between(boot, 'function Get-LegionPackageFolder', 'function Invoke-PackageInstaller');
  assert.ok(fn.indexOf('Get-Sha256Hex $zip') < fn.indexOf('Expand-ZipSafe'), 'hash before unpack');
  assert.ok(fn.indexOf('does not match the SHA-256 you gave') < fn.indexOf('Expand-ZipSafe'));
  assert.ok(fn.indexOf('Invoke-BoundedDownload') < fn.indexOf('Get-Sha256Hex $zip'));
  assert.match(fn, /-MaxEntries \$script:LegionPkgEntriesMax -MaxTotalBytes \$script:LegionPkgUnpackMax/);
  const confirm = between(fn, "& $Say \"SHA-256 of $zipName", '# 2) unpack safely');
  assert.ok(confirm.indexOf('$AssumeYes') < confirm.indexOf('& $Ask'), '-Yes is refused before the question can be answered by it');
  const dl = between(fn, 'if (-not $AssumeYes) {', '$zip = Join-Path $temp $zipName');
  assert.match(dl, /not \$Interactive/); assert.match(dl, /& \$Ask \$q \$false/, 'the default answer to the download question is no');
});

test('contract: download hosts, redirect limit, size cap and the exact release path are pinned in package-bootstrap.ps1 (and equal the JS constants)', async () => {
  assert.match(boot, /\$script:LegionPkgRedirectHosts = @\('github\.com', 'objects\.githubusercontent\.com', 'release-assets\.githubusercontent\.com'\)/);
  assert.match(boot, /\$script:LegionPkgMaxRedirects = 3/); assert.match(boot, /\$script:LegionPkgZipMax = 450MB/); assert.match(boot, /\/dnh33\/legion\/releases\/download\//);
  const { REDIRECT_HOSTS, MAX_REDIRECTS, CAPS } = await lib();
  assert.deepEqual([...REDIRECT_HOSTS], ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']); assert.equal(MAX_REDIRECTS, 3); assert.equal(CAPS.zipBytes, 450 * 1024 * 1024);
  const { ALLOWED_HOSTS } = await import('../src/core/updater/config.js'); assert.deepEqual([...ALLOWED_HOSTS], [...REDIRECT_HOSTS], 'one allowlist for the updater and the installer');
  assert.match(boot, /RequireHttps \$https/); assert.match(boot, /\$https = \$true/);
  assert.match(boot, /LEGION_TEST_MODE -eq '1'/); assert.match(boot, /\^http:\/\/127\\\.0\\\.0\\\.1/);
});

test('contract: the package route registers nothing system-wide: no registry, no PATH, no service or task, no elevation, no kill by name', () => {
  for (const [name, t] of [['setup.ps1', setup], ['package-bootstrap.ps1', boot], ['package-install.mjs', read('scripts/package-install.mjs')]] as const) {
    assert.doesNotMatch(t, /\bHKCU\b|\bHKLM\b|Set-ItemProperty|New-ItemProperty|\bsetx\b|SetEnvironmentVariable|New-Service|\bsc\.exe\b|schtasks|-Verb\s+RunAs|Unblock-File|Add-MpPreference|Set-MpPreference|Stop-Process\s+-Name|taskkill[^\n]*\/IM/i, name);
  }
  assert.doesNotMatch(read('scripts/package-install.mjs'), /execSync|exec\(|shell:\s*true/, 'the installer starts only the two programs it smoke-tests, without a shell');
});

test('contract: shortcuts of a package target runtime\\electron\\electron.exe with the install folder as argument', () => {
  assert.match(setup, /\$electron = Join-Path \$InstallDir 'runtime\\electron\\electron\.exe'/);
  assert.match(setup, /\$s\.TargetPath = \$electron/);
});

test('contract: start-legion.cmd starts a package without Node or npm, and still serves a source tree as before', () => {
  const t = read('start-legion.cmd'); const pk = t.indexOf('runtime\\electron\\electron.exe');
  assert.ok(pk > 0 && pk < t.indexOf('where node'), 'package branch first');
  assert.match(t.slice(0, t.indexOf('where node')), /exit \/b 0/); assert.match(t, /npm run build/);
});

test('settings: the view carries install info only when the core passes it; the Connections snippet branches on packaged', () => {
  const mk = (install?: { dir: string; packaged: boolean }) => new SettingsService({ config: defaultConfig(), bus: new EventBus(), configPath: join(tmp(), 'c.json'), dataDir: tmp(), ...(install ? { install } : {}) }).view();
  assert.equal('install' in mk(), false);
  assert.deepEqual(mk({ dir: 'C:\\L', packaged: true }).install, { dir: 'C:\\L', packaged: true });
  const ui = read('ui/src/components/Settings.tsx');
  assert.match(ui, /s\.install\?\.packaged/); assert.match(ui, /ELECTRON_RUN_AS_NODE: '1'/); assert.match(ui, /command: 'node'/, 'source installs unchanged');
  assert.match(read('src/bin/legion-core.ts'), /install: \{ dir: installRoot, packaged: isPackageInstall\(installRoot\) \}/);
});

test('swap: a full-package install may name node_modules and runtime, never .update, a path, or a dot name; a failed swap puts node_modules back', async () => {
  const dest = tmp('prebuilt-sw-'); const staged = tmp('prebuilt-st-');
  for (const bad of ['..', '.', 'a/b', 'a\\b', 'C:x', '.update', '']) await assert.rejects(swapIn({ installDir: dest, stagedDir: staged, from: '1', to: '2', names: [bad] }), /refusing to swap|incomplete/, bad || '(empty)');
  put(dest, 'package.json', '{"v":1}'); put(dest, 'dist/a.js', 'old'); put(dest, 'node_modules/old/i.js', 'old');
  put(staged, 'package.json', '{"v":2}'); put(staged, 'dist/a.js', 'new'); put(staged, 'node_modules/new/i.js', 'new');
  await assert.rejects(swapIn({ installDir: dest, stagedDir: staged, from: '1', to: '2', names: ['dist', 'package.json', 'node_modules'], retryMs: 10, step: (l) => { if (l === 'before-install:node_modules') throw new Error('boom'); } }), /boom/);
  assert.equal(readFileSync(join(dest, 'node_modules/old/i.js'), 'utf8'), 'old'); assert.equal(readFileSync(join(dest, 'dist/a.js'), 'utf8'), 'old'); assert.equal(readFileSync(join(dest, 'package.json'), 'utf8'), '{"v":1}');
});

test('updater: the update zip from the build is accepted by the updater\'s own tree check (known names only, lock hash, version), and carries the package kind', async () => {
  const { buildPackage } = await load('scripts/build-package.mjs');
  const out = tmp('prebuilt-up-'); const root = builtTree('0.9.0');
  const r = await buildPackage({ repo: REPO, root, out, publishedAt: '2026-10-20T10:00:00Z', commit: 'abc', dirty: false, nodeModules: fakeNodeModules(), electronDist: fakeElectronDist(), electronVersion: '44.5.1', selfcheck: false });
  const { extractZip } = await load('dist/src/core/blender/zip.js');
  const dir = tmp('prebuilt-upx-'); const fd = openSync(r.appZip, 'r');
  await extractZip({ size: fstatSync(fd).size, read: async (o: number, l: number) => { const b = Buffer.alloc(l); const n = readSync(fd, b, 0, l, o); return b.subarray(0, n); }, stream: (s: number, e: number) => createReadStream(r.appZip, { start: s, end: e }) },
    { mkdirp: (d: string) => mkdirSync(d, { recursive: true }), openWrite: (f: string) => createWriteStream(f, { flags: 'wx' }) }, dir, 'legion-0.9.0', { maxEntries: 20000, maxUnpackedBytes: 4e8 });
  const m = JSON.parse(readFileSync(join(out, 'legion-update-manifest.json'), 'utf8'));
  const tree = join(dir, 'legion-0.9.0');
  assert.doesNotThrow(() => checkTree(tree, m, sha(readFileSync(join(root, 'package-lock.json')))));
  assert.deepEqual(readdirSync(tree).filter((n) => ['node_modules', 'runtime', 'PACKAGE-FILES.json'].includes(n)), []);
  assert.equal(JSON.parse(readFileSync(join(tree, 'build-info.json'), 'utf8')).kind, 'package');
  void installer;
});
