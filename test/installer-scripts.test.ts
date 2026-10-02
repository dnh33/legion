import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Windows installer cannot run here. These tests pin its contract (static) and, where a PowerShell exists
// (always on the Windows CI runner), run the pure process-matching logic for real.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');

test('setup-yes.cmd runs setup.ps1 with -Yes, bypassing the execution policy, and does not pause', () => {
  const s = read('setup-yes.cmd');
  assert.match(s, /powershell[^\n]*-ExecutionPolicy Bypass[^\n]*-File "%~dp0scripts\\setup\.ps1" -Yes/i);
  assert.doesNotMatch(s, /^\s*pause\b/im);
  assert.doesNotMatch(s, /\bset \/p\b/i);
});

test('setup.cmd does not wait for a key when -Yes is passed or stdin is redirected', () => {
  const s = read('setup.cmd');
  assert.match(s, /"%%~A"=="-Yes"/i);
  assert.match(s, /\[Console\]::IsInputRedirected/);
  assert.match(s, /if not defined LEGION_NONINT \(\s*echo\.\s*pause/);
  assert.match(s, /exit \/b %LEGION_RC%/);
  assert.equal((s.match(/\bpause\b/g) ?? []).length, 1, 'only the one guarded pause');
});

test('setup.ps1 never blocks without a terminal, and stops Legion by PID through the shared matcher', () => {
  const s = read('scripts/setup.ps1');
  assert.match(s, /\[Console\]::IsInputRedirected/);
  assert.match(s, /if \(\$script:NonInteractive\) \{[^\n]*return \$default/);
  assert.match(s, /Select-LegionProcesses -Processes \$procs -SelfPid \$PID/);
  assert.match(s, /Stop-LegionProcesses/);
  // not scoped to the install folder any more, and never kills by image name
  assert.doesNotMatch(s, /Test-Under \$p\.ExecutablePath \$InstallDir/);
  for (const f of ['scripts/setup.ps1', 'scripts/uninstall.ps1', 'scripts/lib/legion-procs.ps1']) {
    const t = read(f);
    assert.doesNotMatch(t, /Stop-Process\s+(-Name|-InputObject)|taskkill[^\n]*\/IM|Get-Process\s+(-Name\s+)?(node|electron)\b/i, f);
    assert.doesNotMatch(t, /[^\x00-\x7f]/, `${f} must stay ASCII for Windows PowerShell 5.1`);
  }
  assert.match(read('scripts/lib/legion-procs.ps1'), /Stop-Process -Id \$f\.ProcessId/);
});

test('setup creates Desktop and Start-menu shortcuts pointing into the install dir; uninstall removes both and the folder', () => {
  const s = read('scripts/setup.ps1');
  assert.match(s, /GetFolderPath\('Desktop'\)/);
  assert.match(s, /GetFolderPath\('Programs'\)\) 'Legion\.lnk'/);
  assert.match(s, /\$s\.TargetPath = \$electron/);
  assert.match(s, /\$electron = Join-Path \$InstallDir 'node_modules\\electron\\dist\\electron\.exe'/);
  assert.match(s, /\$s\.Arguments = '"' \+ \$InstallDir \+ '"'/);
  assert.match(s, /\$s\.WorkingDirectory = \$InstallDir/);
  const u = read('scripts/uninstall.ps1');
  assert.match(u, /GetFolderPath\('Desktop'\)\) 'Legion\.lnk'/);
  assert.match(u, /GetFolderPath\('Programs'\)\) 'Legion\.lnk'/);
  assert.match(u, /Remove-Item -LiteralPath \$l -Force/);
  assert.match(u, /Remove-Item -LiteralPath \$InstallDir -Recurse -Force/);
  assert.match(u, /does not look like a Legion install; refusing/);
  assert.match(u, /Test-PathUnder \$target \$InstallDir/);
});

test('uninstall.cmd (written by setup) ships the helper next to the copied script', () => {
  const s = read('scripts/setup.ps1');
  assert.match(s, /scripts\\lib\\legion-procs\.ps1" "%TMPU%\\legion-procs\.ps1"/);
  assert.match(s, /-File "%TMPU%\\uninstall\.ps1" -InstallDir "%~dp0\."/);
  assert.match(read('scripts/uninstall.ps1'), /legion-procs\.ps1/);
});

function findPowerShell(): string | null {
  for (const exe of ['pwsh', 'powershell']) {
    const r = spawnSync(exe, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return exe;
  }
  return null;
}

interface P { ProcessId: number; Name: string; ExecutablePath: string | null; CommandLine: string | null }
const ps = (id: number, name: string, exe: string | null, cmd: string | null): P => ({ ProcessId: id, Name: name, ExecutablePath: exe, CommandLine: cmd });

test('process matcher: only Legion processes, from any folder (runs in real PowerShell when available)', (t) => {
  const exe = findPowerShell();
  if (!exe) { t.skip('no PowerShell on this machine; runs on the Windows CI runner'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'legion-ps-'));
  try {
    const procs: P[] = [
      ps(10, 'electron.exe', 'C:\\Users\\a\\AppData\\Local\\Programs\\Legion\\node_modules\\electron\\dist\\electron.exe', '"C:\\Users\\a\\AppData\\Local\\Programs\\Legion\\node_modules\\electron\\dist\\electron.exe" "C:\\Users\\a\\AppData\\Local\\Programs\\Legion"'),
      ps(11, 'electron.exe', 'C:\\Users\\a\\AppData\\Local\\Programs\\Legion\\node_modules\\electron\\dist\\electron.exe', '"...electron.exe" --type=renderer'),
      ps(12, 'electron.exe', 'D:\\dev\\legion\\node_modules\\electron\\dist\\electron.exe', '"D:\\dev\\legion\\node_modules\\electron\\dist\\electron.exe" "D:\\dev\\legion\\."'),
      ps(13, 'node.exe', 'C:\\Program Files\\nodejs\\node.exe', '"C:\\Program Files\\nodejs\\node.exe" "D:\\My Stuff\\legion\\dist\\src\\bin\\legion-core.js"'),
      ps(14, 'NODE.EXE', 'C:\\Program Files\\nodejs\\node.exe', 'node D:\\dev\\legion\\dist\\src\\bin\\legion-core.js'),
      // never matched
      ps(20, 'Code.exe', 'C:\\Users\\a\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', 'Code.exe'),
      ps(21, 'electron.exe', 'D:\\other-app\\node_modules\\electron\\dist\\electron.exe', '"electron.exe" "D:\\other-app"'),
      ps(22, 'node.exe', 'C:\\Program Files\\nodejs\\node.exe', 'node D:\\dev\\site\\node_modules\\vite\\bin\\vite.js'),
      ps(23, 'node.exe', 'C:\\Program Files\\nodejs\\node.exe', 'node D:\\dev\\legion\\dist\\src\\bin\\legion-mcp-stdio.js'),
      ps(24, 'electron.exe', null, null),
      ps(25, 'node.exe', null, null),
      ps(26, 'node.exe', 'C:\\Program Files\\nodejs\\node.exe', 'node C:\\x\\dist\\src\\bin\\legion-core.js.bak'),
      ps(99, 'electron.exe', 'D:\\dev\\legion\\node_modules\\electron\\dist\\electron.exe', 'self'),
    ];
    const casesFile = join(dir, 'procs.json');
    writeFileSync(casesFile, JSON.stringify(procs));
    const script = join(dir, 'run.ps1');
    const lib = join(root, 'scripts', 'lib', 'legion-procs.ps1');
    assert.ok(existsSync(lib));
    writeFileSync(script, [
      `. '${lib.replace(/'/g, "''")}'`,
      `$procs = @(Get-Content -Raw -LiteralPath '${casesFile.replace(/'/g, "''")}' | ConvertFrom-Json)`,
      `$check = { param($r) $r -notlike '*other-app*' }`,
      `$all = @(Select-LegionProcesses -Processes $procs -SelfPid 99 -RootCheck $check)`,
      `$one = @(Select-LegionProcesses -Processes $procs -SelfPid 99 -RootCheck $check -OnlyUnder 'C:\\Users\\a\\AppData\\Local\\Programs\\Legion')`,
      `$roots = @($all | ForEach-Object { $_.Root })`,
      `@{ all = @($all | ForEach-Object { $_.ProcessId }); one = @($one | ForEach-Object { $_.ProcessId }); roots = $roots } | ConvertTo-Json -Compress`,
    ].join('\n'));
    const r = spawnSync(exe, ['-NoProfile', '-File', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = JSON.parse(r.stdout.trim().split('\n').pop() as string) as { all: number[]; one: number[]; roots: string[] };
    assert.deepEqual([...out.all].sort((a, b) => a - b), [10, 11, 12, 13, 14]);
    assert.deepEqual([...out.one].sort((a, b) => a - b), [10, 11]);
    assert.ok(out.roots.includes('D:\\My Stuff\\legion'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
