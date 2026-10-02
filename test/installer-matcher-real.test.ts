import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { allPowerShells, q, runPs, runPsAsync, tempDir, writeFiles } from './ps-helpers.js';

// F1: the REAL Test-LegionRoot on REAL temp folders, and the REAL Stop-LegionProcesses on a throwaway child.
// Runs once per PowerShell found (powershell = 5.1 on Windows, pwsh = 7); skipped where there is none.

const LEGION_SRC = {
  'package.json': '{ "name": "legion", "version": "1.0.0" }',
  'src/electron/main.ts': '// main',
  'src/bin/legion-core.ts': '// core',
};
const LEGION_BUILT = {
  'package.json': '{ "name": "legion" }',
  'dist/src/electron/main.js': '//',
  'dist/src/bin/legion-core.js': '//',
};

const shells = allPowerShells();

for (const exe of shells) {
  test(`Test-LegionRoot on real folders: Legion yes, decoy Electron app no (${exe})`, () => {
    const dir = tempDir();
    try {
      writeFiles(join(dir, 'src-layout'), LEGION_SRC);
      writeFiles(join(dir, 'built-layout'), LEGION_BUILT);
      // a different Electron+TypeScript app with the same file layout, including a core entry point
      writeFiles(join(dir, 'decoy'), { ...LEGION_SRC, 'package.json': '{ "name": "other-app" }' });
      writeFiles(join(dir, 'decoy-prefix'), { ...LEGION_SRC, 'package.json': '{ "name": "legion-fork" }' });
      writeFiles(join(dir, 'decoy-case'), { ...LEGION_SRC, 'package.json': '{ "name": "Legion" }' });
      writeFiles(join(dir, 'no-core'), { 'package.json': LEGION_SRC['package.json'], 'src/electron/main.ts': '//' });
      writeFiles(join(dir, 'no-main'), { 'package.json': LEGION_SRC['package.json'], 'src/bin/legion-core.ts': '//' });
      writeFiles(join(dir, 'bad-json'), { ...LEGION_SRC, 'package.json': '{ not json' });
      writeFiles(join(dir, 'no-name'), { ...LEGION_SRC, 'package.json': '{ "version": "1" }' });
      writeFiles(join(dir, 'no-package'), { 'src/electron/main.ts': '//', 'src/bin/legion-core.ts': '//' });
      const names = ['src-layout', 'built-layout', 'decoy', 'decoy-prefix', 'decoy-case', 'no-core', 'no-main', 'bad-json', 'no-name', 'no-package', 'missing'];
      const body = [
        `$base = ${q(dir)}`,
        `$h = [ordered]@{}`,
        ...names.map((n) => `$h[${q(n)}] = [bool](Test-LegionRoot (Join-Path $base ${q(n)}))`),
        `$h['empty'] = [bool](Test-LegionRoot '')`,
        `$h | ConvertTo-Json -Compress`,
      ].join('\n');
      const r = runPs<Record<string, boolean>>(exe, body, dir);
      assert.deepEqual(r, {
        'src-layout': true, 'built-layout': true,
        decoy: false, 'decoy-prefix': false, 'decoy-case': false,
        'no-core': false, 'no-main': false, 'bad-json': false, 'no-name': false, 'no-package': false, missing: false,
        empty: false,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`Select-LegionProcesses with the real root check ignores a decoy Electron app (${exe})`, () => {
    const dir = tempDir();
    try {
      const legion = join(dir, 'Legion Real');
      const decoy = join(dir, 'decoy-app');
      writeFiles(legion, LEGION_SRC);
      writeFiles(decoy, { ...LEGION_SRC, 'package.json': '{ "name": "decoy-app" }' });
      const electron = (root: string): string => `${root}\\node_modules\\electron\\dist\\electron.exe`;
      const procs = [
        { ProcessId: 1, Name: 'electron.exe', ExecutablePath: electron(legion), CommandLine: 'x' },
        { ProcessId: 2, Name: 'electron.exe', ExecutablePath: electron(decoy), CommandLine: 'x' },
      ];
      writeFiles(dir, { 'procs.json': JSON.stringify(procs) });
      const body = [
        `$procs = @(Get-Content -Raw -LiteralPath ${q(join(dir, 'procs.json'))} | ConvertFrom-Json)`,
        `$found = @(Select-LegionProcesses -Processes $procs -SelfPid 0)`,
        `@{ pids = @($found | ForEach-Object { $_.ProcessId }) } | ConvertTo-Json -Compress`,
      ].join('\n');
      assert.deepEqual(runPs<{ pids: number[] }>(exe, body, dir).pids, [1]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`Stop-LegionProcesses stops the listed throwaway process and nothing else (${exe})`, async () => {
    const dir = tempDir();
    const idle = (): ReturnType<typeof spawn> => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const victim = idle();
    const bystander = idle();
    try {
      assert.ok(victim.pid && bystander.pid);
      const body = [
        `$found = @([pscustomobject]@{ ProcessId = ${victim.pid}; Name = 'node.exe'; Root = 'x' })`,
        `$left = @(Stop-LegionProcesses -Found $found -WaitSeconds 15)`,
        `@{ left = $left } | ConvertTo-Json -Compress`,
      ].join('\n');
      const out = JSON.parse(await runPsAsync(exe, body, dir)) as { left: number[] };
      assert.deepEqual(out.left ?? [], []);
      const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
      // let node reap the killed child
      for (let i = 0; i < 50 && alive(victim.pid); i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(alive(victim.pid), false, 'listed process is gone');
      assert.equal(alive(bystander.pid), true, 'unlisted process is untouched');
    } finally {
      victim.kill('SIGKILL');
      bystander.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('real PowerShell availability is reported', (t) => {
  if (shells.length === 0) t.skip('no PowerShell on this machine; the Windows CI job runs these');
});

// F6: the chain of processes that started setup is never on the kill list.
for (const exe of shells) {
  test(`Get-AncestorPids walks the parent chain; Select-LegionProcesses -ExcludePids keeps those PIDs off the list (${exe})`, () => {
    const dir = tempDir();
    try {
      const legion = join(dir, 'Legion Real');
      writeFiles(legion, LEGION_SRC);
      const exePath = `${legion}\\node_modules\\electron\\dist\\electron.exe`;
      // 50 = this setup; 40 = powershell started by an agent shell 30; 20 = Legion electron main (grandparent chain); 10 = another Legion process
      const procs = [
        { ProcessId: 50, ParentProcessId: 40, Name: 'powershell.exe', ExecutablePath: null, CommandLine: null },
        { ProcessId: 40, ParentProcessId: 30, Name: 'cmd.exe', ExecutablePath: null, CommandLine: null },
        { ProcessId: 30, ParentProcessId: 20, Name: 'node.exe', ExecutablePath: null, CommandLine: null },
        { ProcessId: 20, ParentProcessId: 1, Name: 'electron.exe', ExecutablePath: exePath, CommandLine: 'x' },
        { ProcessId: 10, ParentProcessId: 1, Name: 'electron.exe', ExecutablePath: exePath, CommandLine: 'x' },
        { ProcessId: 60, ParentProcessId: 61, Name: 'a.exe', ExecutablePath: null, CommandLine: null },   // a loop 60 <-> 61
        { ProcessId: 61, ParentProcessId: 60, Name: 'b.exe', ExecutablePath: null, CommandLine: null },
      ];
      writeFiles(dir, { 'procs.json': JSON.stringify(procs) });
      const body = [
        `$procs = @(Get-Content -Raw -LiteralPath ${q(join(dir, 'procs.json'))} | ConvertFrom-Json)`,
        `$anc = @(Get-AncestorPids -Processes $procs -StartPid 50)`,
        `$loop = @(Get-AncestorPids -Processes $procs -StartPid 60)`,
        `$none = @(Get-AncestorPids -Processes $procs -StartPid 999)`,
        `$all = @(Select-LegionProcesses -Processes $procs -SelfPid 50)`,
        `$kept = @(Select-LegionProcesses -Processes $procs -SelfPid 50 -ExcludePids $anc)`,
        `@{ anc = $anc; loop = $loop; none = $none; all = @($all | ForEach-Object { $_.ProcessId }); kept = @($kept | ForEach-Object { $_.ProcessId }) } | ConvertTo-Json -Compress`,
      ].join('\n');
      const r = runPs<{ anc: number[]; loop: number[]; none: number[]; all: number[]; kept: number[] }>(exe, body, dir);
      assert.deepEqual(r.anc, [40, 30, 20, 1]);
      assert.deepEqual([...r.all].sort((a, b) => a - b), [10, 20]);
      assert.deepEqual(r.kept, [10], 'the Legion process that started setup (20) is excluded');
      assert.deepEqual(r.loop, [61], 'a parent loop ends instead of spinning');
      assert.deepEqual(r.none ?? [], []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
