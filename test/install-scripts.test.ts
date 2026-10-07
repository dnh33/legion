import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Static properties of the one-line installers (scripts/install). They run for real in CI against the real latest release
// (see .github/workflows/ci.yml); these tests pin what must never change about their shape.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const raw = (p: string): string => readFileSync(join(root, p), 'utf8');
const ps1 = raw('scripts/install/install.ps1').replace(/\r\n/g, '\n');
const sh = raw('scripts/install/install.sh');
const lastLine = (s: string): string => s.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '').pop() ?? '';

test('both installers end by calling their one function, so a cut-off download runs nothing', () => {
  assert.equal(lastLine(ps1), 'Install-Legion @args');
  assert.equal(lastLine(sh), 'main "$@"');
  assert.equal((ps1.match(/^Install-Legion @args/gm) ?? []).length, 1);
  assert.equal((sh.match(/^main "\$@"/gm) ?? []).length, 1);
  // nothing but comments, the function and (sh) tiny helper definitions before the call: no top-level command in install.ps1
  const topLevelPs1 = ps1.split('\n').filter((l) => l !== '' && !/^\s/.test(l) && !l.startsWith('#') && l.trimEnd() !== '}' && !l.startsWith('function Install-Legion {'));
  assert.deepEqual(topLevelPs1, ['Install-Legion @args']);
});

test('install.sh is POSIX sh with LF only', () => {
  assert.ok(sh.startsWith('#!/bin/sh\n'));
  assert.ok(!sh.includes('\r'), 'no CR bytes');
  assert.match(sh, /^set -eu$/m);
  assert.doesNotMatch(sh, /^\s*sudo\s/m, 'never runs sudo');
});

test('the installers never use the GitHub API and only talk to dnh33/legion releases', () => {
  for (const s of [ps1, sh]) {
    assert.doesNotMatch(s, /api\.github\.com/);
    assert.match(s, /\/dnh33\/legion/);
  }
  assert.match(ps1, /\$repo = '\/dnh33\/legion\/releases'/);
  assert.match(ps1, /\$base = 'https:\/\/github\.com'/);
  assert.match(sh, /repo_path=\/dnh33\/legion/);
  assert.match(sh, /base=\$\{LEGION_INSTALL_BASE:-https:\/\/github\.com\}/);
  assert.match(ps1, /\$env:LEGION_INSTALL_BASE/);
  // every literal address in either script is on github.com or one of the docs pages it names
  for (const u of [...(ps1 + sh).matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0])) {
    assert.match(u, /^https:\/\/(github\.com|getlegion\.xyz|nodejs\.org|git-scm\.com)/, `unexpected address ${u}`);
  }
});

test('install.ps1 states the SHA-256 check honestly and never claims a signature', () => {
  assert.match(ps1, /checked against the release's SHA-256/);
  assert.match(ps1, /not code-signed/);
  assert.doesNotMatch(ps1, /\b(signed by|verified signature|trusted)\b/i);
  // the hash is compared before the zip is unpacked
  assert.ok(ps1.indexOf('Get-FileSha256 $zip') < ps1.indexOf('Expand-ZipSafe -Zip'));
  assert.match(ps1, /Nothing was unpacked or installed/);
});

test('install.ps1 does not use iex itself, and runs setup through a file with the policy bypassed', () => {
  const code = ps1.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /\b(iex|Invoke-Expression)\b/i);
  assert.match(code, /'-ExecutionPolicy', 'Bypass', '-File', \$setup, '-Yes'/);
  assert.match(code, /\$ErrorActionPreference = 'Stop'/);
});

// The smoke jobs install the live latest release, so they live in their own workflow, not in the per-push gate (docs/CI.md).
const installYml = raw('.github/workflows/install.yml').replace(/\r\n/g, '\n');
const ciYml = raw('.github/workflows/ci.yml').replace(/\r\n/g, '\n');
const esc = (x: string): string => x.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
const smokeJobs = ['install-windows', 'install-unix'];

test('install.yml runs on installer-path changes, nightly and by hand, never on pull_request_target', () => {
  assert.doesNotMatch(installYml.replace(/^s*#.*$/gm, ""), /pull_request_target/);
  assert.match(installYml, /^on:\n {2}pull_request:\n {4}paths:\n/m);
  assert.match(installYml, /^ {2}push:\n {4}branches: \[main\]\n {4}paths:\n/m);
  assert.equal((installYml.match(/^ {6}- scripts\/install\/\*\*$/gm) ?? []).length, 2, 'both triggers filter on the installer paths');
  for (const p of ['scripts/setup.ps1', 'scripts/lib/package-*', 'scripts/lib/legion-procs.ps1', '.github/workflows/install.yml']) {
    assert.equal((installYml.match(new RegExp("^ {6}- " + esc(p) + "$", "gm")) ?? []).length, 2, `${p} in both path filters`);
  }
  assert.match(installYml, /^ {2}schedule:\n {4}- cron: '17 3 \* \* \*'$/m);
  assert.match(installYml, /^ {2}workflow_dispatch:$/m);
  assert.match(installYml, /^permissions:\n {2}contents: read$/m);
  assert.match(installYml, /^concurrency:\n {2}group: install-/m);
  assert.match(installYml, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.equal((installYml.match(/persist-credentials: false/g) ?? []).length, (installYml.match(/actions\/checkout@/g) ?? []).length);
  for (const job of smokeJobs) assert.match(installYml, new RegExp(`^ {2}${job}:\n(?: {4}.*\n)*? {4}timeout-minutes: [0-9]+`, 'm'), `${job} has a time limit`);
  // every action is pinned to a full commit SHA
  for (const m of installYml.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `unpinned action ${m[1]}`);
});

test('install.yml clears CI and ELECTRON_SKIP_BINARY_DOWNLOAD for install.sh and asserts the Electron binary exists', () => {
  const unix = installYml.slice(installYml.indexOf('  install-unix:'));
  assert.match(unix, /^ {6}CI: ""$/m);
  assert.match(unix, /^ {6}ELECTRON_SKIP_BINARY_DOWNLOAD: ""$/m);
  assert.match(unix, /require\("electron"\)/);
  assert.match(unix, /test -x "\$electron"/);
  assert.match(unix, /export HOME="\$RUNNER_TEMP\/home"/);
  assert.match(unix, /test -x "\$HOME\/\.local\/bin\/legion"/);
  assert.match(installYml, /name: Windows PowerShell 5\.1 only, update over the existing install/);
});

// The release build (ladder 33): Actions builds and uploads ONE artifact; signing and publishing stay on the PC (docs/SHIPPING.md).
const releaseYml = raw('.github/workflows/release-build.yml').replace(/\r\n/g, '\n');

test('release-build.yml builds on a v* tag or by hand, read-only, with no secrets, no cache and no release upload', () => {
  const code = releaseYml.replace(/^\s*#.*$/gm, '');
  assert.match(releaseYml, /^on:\n {2}push:\n {4}tags: \['v\*'\]\n {2}workflow_dispatch:$/m);
  assert.doesNotMatch(code, /pull_request/);
  assert.match(releaseYml, /^permissions:\n {2}contents: read\n\n/m, 'only contents: read, nothing else');
  assert.doesNotMatch(code, /permissions:\s*\n\s+\w+: write|: write\b|write-all/);
  assert.doesNotMatch(code, /secrets\.|GITHUB_TOKEN|github\.token/, 'no secrets or token used');
  assert.doesNotMatch(code, /cache:|actions\/cache/, 'a release is never built from a restored cache');
  assert.doesNotMatch(code, /gh release|softprops|action-gh-release|upload-release|release-sign|\.pem|\.key/i, 'no publishing or signing here');
  for (const m of releaseYml.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `unpinned action ${m[1]}`);
  assert.equal((releaseYml.match(/persist-credentials: false/g) ?? []).length, (releaseYml.match(/actions\/checkout@/g) ?? []).length);
  assert.match(releaseYml, /^ {4}runs-on: windows-latest$/m, 'build-package.mjs only builds on Windows x64');
  assert.match(releaseYml, /^ {4}timeout-minutes: [0-9]+$/m);
  assert.match(releaseYml, /^ {6}CI: ""$/m, 'CI cleared so postinstall downloads Electron');
  assert.match(releaseYml, /^ {6}ELECTRON_SKIP_BINARY_DOWNLOAD: ""$/m);
  // untrusted text reaches the shell only through env, never through ${{ }} inside a run block
  for (const m of releaseYml.matchAll(/^( +)run: \|\n((?:\1 {2}.*\n|\n)*)/gm)) assert.doesNotMatch(m[2], /\$\{\{/, 'expression inside a run block');
  for (const m of releaseYml.matchAll(/^ +run: (?!\|)(.*)$/gm)) assert.doesNotMatch(m[1], /\$\{\{/, 'expression inside a run line');
  assert.match(releaseYml, /if-no-files-found: error/);
  // the runner context is not available in job-level env (GitHub's context table); using it there fails validation
  assert.doesNotMatch(releaseYml, /^ {6}\w+: .*\$\{\{ *runner\./m, 'runner.* in job-level env');
});

test('release-build.yml builds a release only from a commit on main, and names any other build a dry run', () => {
  assert.match(releaseYml, /fetch-depth: 0\n/);
  const push = releaseYml.slice(releaseYml.indexOf("if ($env:EVENT -eq 'push') {"));
  assert.match(push, /^ {12}git merge-base --is-ancestor HEAD origin\/main\n {12}if \(\$LASTEXITCODE -ne 0\) \{ throw/m);
  assert.match(releaseYml, /\$artifact = if \(\$env:EVENT -eq 'push'\) \{ "legion-\$v-release" \} else \{ "legion-\$v-DRYRUN-/);
  assert.match(releaseYml, /^ {10}name: \$\{\{ steps\.v\.outputs\.artifact \}\}$/m, 'the artifact is named by the build kind');
});

test('ci.yml keeps only the fast syntax check for the installers; the smoke jobs moved to install.yml', () => {
  assert.match(ciYml, /^ {2}install-script-lint:\n {4}name: install scripts \(syntax\)$/m);
  for (const job of smokeJobs) {
    assert.doesNotMatch(ciYml, new RegExp(`^ {2}${job}:`, 'm'), `${job} must not be in ci.yml`);
    assert.match(installYml, new RegExp(`^ {2}${job}:`, 'm'), `${job} is in install.yml`);
  }
  assert.doesNotMatch(ciYml, /releases\/latest/, 'the per-push gate does not depend on the live release');
  assert.doesNotMatch(ciYml, /install\.ps1 -NoLaunch|install\.sh --no-launch/);
});

test('install.sh checks the Electron binary after npm ci and makes the launcher folder', () => {
  const ci = sh.indexOf('npm ci --no-audit');
  const check = sh.indexOf('require("electron")');
  const build = sh.indexOf('npm run build ||');
  assert.ok(ci > 0 && check > ci && check < build, 'the Electron check sits between npm ci and the build');
  assert.match(sh, /\[ ! -x "\$electron" \]/);
  assert.match(sh, /The Electron binary is missing/);
  const mkdir = sh.indexOf('mkdir -p "$bindir"');
  assert.ok(mkdir > 0 && mkdir < sh.indexOf('write_launcher "$dir" "$launcher"'), 'the launcher folder is made before the launcher is written');
});

test('the source-install Node floor is 22.12 everywhere the installer states it', () => {
  assert.doesNotMatch(sh, /20\.10/);
  assert.match(sh, /22\.12/);
  const readme = raw('README.md');
  assert.match(readme, /Node\.js 22\.12 or newer, for a source install only/);
  assert.doesNotMatch(readme.split('### One-line install')[1].split('### Windows, from a release')[0], /20\.10/);
});
