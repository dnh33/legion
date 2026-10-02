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
