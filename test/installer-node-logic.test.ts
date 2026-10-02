import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './ps-helpers.js';
import { resolveNodeBin } from '../src/electron/resolve-node.js';

// Pure logic and static contract of the installer bootstrap (runs everywhere, no PowerShell needed).
const read = (p: string): string => readFileSync(join(repoRoot, p), 'utf8').replace(/\r\n/g, '\n');
const PS_FILES = ['scripts/setup.ps1', 'scripts/uninstall.ps1', ...readdirSync(join(repoRoot, 'scripts', 'lib')).filter((f) => f.endsWith('.ps1')).map((f) => `scripts/lib/${f}`)];

test('the Node version truth: the script minimum equals package.json engines, and the pin is Node 24 LTS', () => {
  const engines = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node;
  assert.match(engines, /^>=\d+\.\d+$/);
  const min = /\$script:LegionNodeMin = '(\d+\.\d+\.\d+)'/.exec(read('scripts/lib/node-bootstrap.ps1'))![1]!;
  assert.equal(`>=${min.split('.').slice(0, 2).join('.')}`, engines, 'node-bootstrap.ps1 LegionNodeMin must follow package.json engines.node');
  const pin = /\$script:LegionNodeVersion = '(\d+\.\d+\.\d+)'/.exec(read('scripts/lib/node-bootstrap.ps1'))![1]!;
  assert.match(pin, /^24\./);
  assert.equal(read('scripts/lib/node-bootstrap.ps1').match(/\$script:LegionNodeVersion = /g)!.length, 1, 'the pin lives in one place');
  assert.doesNotMatch(read('scripts/setup.ps1'), /\[int\]\(\$ver\.Split/, 'the old major-only "20+" check is gone');
});

test('every URL in the setup scripts names only nodejs.org (the Node download); the test loopback is the only other host', () => {
  const allowed = new Set(['nodejs.org', '127.0.0.1']);
  const seen = new Map<string, string[]>();
  for (const f of PS_FILES) for (const m of read(f).matchAll(/https?:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) { const h = m[1]!.toLowerCase(); seen.set(h, [...(seen.get(h) ?? []), f]); }
  for (const [h, files] of seen) assert.ok(allowed.has(h), `unexpected host ${h} in ${files.join(', ')}`);
  assert.ok(seen.has('nodejs.org'));
  for (const f of seen.get('nodejs.org')!) assert.ok(['scripts/lib/node-bootstrap.ps1', 'scripts/setup.ps1'].includes(f), `nodejs.org in ${f}`);
  const nb = read('scripts/lib/node-bootstrap.ps1');
  assert.match(nb, /MaxRedirects 0/, 'nodejs.org downloads refuse every redirect');
  assert.doesNotMatch(nb, /MaxRedirects [1-9]/);
  assert.match(nb, /LEGION_TEST_MODE -eq '1'/, 'the mirror override is gated by the test flag');
  assert.match(nb, /\^http:\/\/127\\\.0\\\.0\\\.1/, 'and by loopback http only');
});

test('the bootstrap downloads through the bounded downloader only: no auto-redirect, no Invoke-WebRequest, no Invoke-Expression, no kill by name', () => {
  const io = read('scripts/lib/safe-io.ps1');
  assert.match(io, /AllowAutoRedirect = \$false/);
  assert.match(io, /AllowedHosts/);
  for (const f of PS_FILES) {
    const t = read(f);
    assert.doesNotMatch(t, /[^\x00-\x7f]/, `${f} must stay ASCII for Windows PowerShell 5.1`);
    assert.doesNotMatch(t, /Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\birm\b|Net\.WebClient|Start-BitsTransfer|Invoke-Expression|\biex\b|DownloadString|DownloadFile/i, `${f}: use Invoke-BoundedDownload`);
    assert.doesNotMatch(t, /Stop-Process\s+(-Name|-InputObject)|taskkill[^\n]*\/IM|Get-Process\s+(-Name\s+)?(node|electron)\b/i, f);
  }
  // no system change: no registry writes, no machine/user PATH edits, no installer run
  for (const f of ['scripts/lib/node-bootstrap.ps1', 'scripts/lib/safe-io.ps1']) {
    assert.doesNotMatch(read(f), /SetEnvironmentVariable|\bsetx\b|New-ItemProperty|Set-ItemProperty|HKLM|HKCU|msiexec|Start-Process|Start-Job/i, f);
  }
});

test('setup.ps1 resolves Node before npm, passes -Yes as the go-ahead, keeps runtime\\ and .update\\ out of the robocopy mirror, and never runs git', () => {
  const s = read('scripts/setup.ps1');
  assert.match(s, /Initialize-LegionNode -InstallDir \$InstallDir/);
  assert.ok(s.indexOf('Initialize-LegionNode') < s.indexOf('npm ci'), 'Node is settled before npm runs');
  assert.match(s, /function Ask[^]*if \(\$Yes\) \{ return \$true \}/, '-Yes answers yes to the download question');
  assert.match(s, /\$env:PATH = \$nodeRes\.NodeDir \+ \[System\.IO\.Path\]::PathSeparator \+ \$env:PATH/, 'process-only PATH');
  assert.match(s, /\(Join-Path \$InstallDir 'runtime'\), \(Join-Path \$InstallDir '\.update'\)/);
  assert.doesNotMatch(s, /\bgit\b(?! checkout)[^\n]*(clone|pull|fetch|checkout)|&\s*git\b|Get-Command git/i, 'setup never runs git');
  assert.match(read('setup-yes.cmd'), /setup\.ps1" -Yes/);
  assert.match(s, /Release package: already built/);
  assert.match(read('scripts/uninstall.ps1'), /Remove-LegionRuntime -InstallDir \$InstallDir/);
  assert.match(read('.gitignore'), /^\/runtime\/$/m);
});

test('the Electron shell starts the core with Legion\'s own Node when setup installed one (resolveNodeBin)', () => {
  const root = join('x', 'Legion');
  const have = (...ps: string[]) => (p: string) => ps.includes(p);
  const exe = join(root, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  const marker = join(root, 'runtime', 'node', '.legion-owned');
  assert.equal(resolveNodeBin(root, { LEGION_NODE: 'C:\\mine\\node.exe' }, have(exe, marker)), 'C:\\mine\\node.exe', 'the user\'s LEGION_NODE wins');
  assert.equal(resolveNodeBin(root, {}, have(exe, marker)), exe);
  assert.equal(resolveNodeBin(root, {}, have(exe)), 'node', 'no marker: not Legion\'s, not used');
  assert.equal(resolveNodeBin(root, {}, have(marker)), 'node');
  assert.equal(resolveNodeBin(root, {}, have()), 'node');
  assert.match(read('src/electron/main.ts'), /resolveNodeBin\(root\)/);
});
