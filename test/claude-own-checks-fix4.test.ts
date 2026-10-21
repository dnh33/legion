// test/claude-own-checks-fix4.test.ts: fix round A+B 4 for "Claude agents follow Claude's own permission checks" (0.3.8).
// F1: a heredoc body or a PowerShell here-string is skipped as data only when nothing in it can run; otherwise it is read.
// F2: padding cannot step around the Full card for a PowerShell or cmd recursive delete of the project folder.
// F3: a delete of a sibling or of a subfolder of the project is not a delete of the project folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gatesRig } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import { criticalDeleteRead, longCatastrophic, MAX_READABLE } from '../src/core/exec/shell-floor.js';

const using = async (o: Parameters<typeof gatesRig>[0], body: (r: GatesRig) => Promise<void>) => {
  const r = await gatesRig(o);
  try { await body(r); } finally { r.stop(); }
};

const PRESETS: Array<[string, Parameters<typeof gatesRig>[0]]> = [
  ['Full', { preset: 'bypass', follow: true }],
  ['Smart', { app: 'smart', follow: true }],
  ['Ask', { own: 'ask' }],
  ['Accept edits', { own: 'auto-edits' }],
];

const PAD = 'x'.repeat(12_000);
const SPACE = ' '.repeat(11_000);
const winPath = (r: GatesRig): string => r.projectDir().replace(/\//g, '\\');

// ------------------------------------------------------------------ F1: a body that can run is read

/** [name, shell, tool, command]: each is over 10,000 characters, and each would run something disastrous. */
const RUNS: Array<[string, 'sh' | 'pwsh', string, string]> = [
  ['unquoted heredoc, substitution in the body', 'sh', 'Bash', `cat <<EOF\n$(rm -rf /)\n${PAD}\nEOF`],
  ['unquoted heredoc, substitution after the padding', 'sh', 'Bash', `cat <<EOF\n${PAD}\n$(rm -rf /)\nEOF`],
  ['unquoted heredoc, backticks in the body', 'sh', 'Bash', `cat <<EOF\n\`rm -rf /\`\n${PAD}\nEOF`],
  ['quoted heredoc fed to bash', 'sh', 'Bash', `bash <<'EOF'\n${PAD}\nrm -rf /\nEOF`],
  ['heredoc fed to bash', 'sh', 'Bash', `bash <<EOF\n${PAD}\nrm -rf /\nEOF`],
  ['heredoc fed to python', 'sh', 'Bash', `python - <<EOF\n${PAD}\nrm -rf /\nEOF`],
  ['single-quoted here-string run by Invoke-Expression', 'pwsh', 'PowerShell', `$s = @'\nRemove-Item -Recurse -Force C:\\\n${PAD}\n'@\nInvoke-Expression $s`],
  ['single-quoted here-string run by iex', 'pwsh', 'PowerShell', `$s = @'\nRemove-Item -Recurse -Force C:\\\n${PAD}\n'@\n$s | iex`],
  ['single-quoted here-string run as a script block', 'pwsh', 'PowerShell', `$s = @'\nRemove-Item -Recurse -Force C:\\\n${PAD}\n'@\n& ([scriptblock]::Create($s))`],
  ['double-quoted here-string with a substitution', 'pwsh', 'PowerShell', `@"\n$(Remove-Item -Recurse -Force C:\\)\n${PAD}\n"@`],
];

test('F1: a heredoc body or here-string that can run is read, so a disastrous command in it is found', () => {
  for (const [name, shell, , command] of RUNS) {
    assert.ok(command.length > MAX_READABLE, name);
    assert.equal(longCatastrophic(command, shell)?.kind, 'found', name);
  }
});

test('F1: a body that cannot run stays data, however long', () => {
  const free: Array<[string, 'sh' | 'pwsh', string]> = [
    ['quoted heredoc of plain data', 'sh', `cat <<'EOF' > data.txt\n${'a line of plain data\n'.repeat(1_500)}EOF`],
    ['30,000-character quoted heredoc, one line', 'sh', `cat <<'EOF' > data.txt\n${'x'.repeat(30_000)}\nEOF`],
    ['unquoted heredoc of plain data', 'sh', `cat > notes.md <<EOF\n${'rm -rf /\n'.repeat(2_000)}EOF\necho done`],
    ['here-string of plain data, saved to a file', 'pwsh', `$t = @'\n${'y'.repeat(30_000)}\n'@\nSet-Content a.txt $t`],
    ['expandable here-string without a substitution', 'pwsh', `$t = @"\nname: $env:USERNAME\n${'y'.repeat(30_000)}\n"@\nSet-Content a.txt $t`],
  ];
  for (const [name, shell, command] of free) assert.equal(longCatastrophic(command, shell), undefined, name);
  // the text after a body is read again
  assert.equal(longCatastrophic(`cat <<'EOF' > d.txt\n${'x'.repeat(30_000)}\nEOF\nrm -rf /`, 'sh')?.kind, 'found');
});

test('F1: the same commands get one card in Full, Smart, Ask and Accept edits, and a No denies', async () => {
  for (const [preset, rig] of PRESETS) {
    for (const [name, , tool, command] of RUNS) {
      await using({ ...rig, ownChecks: true }, async (r) => {
        const h = await r.hookAll(tool, { command });
        assert.deepEqual([h.cards, h.decision], [1, 'deny'], `${preset}: ${name}`);
      });
    }
  }
});

test('F1: plain data heredocs and a normal commit message get no card in any preset', async () => {
  const commit = 'git commit -m "$(cat <<\'EOF\'\nfix: a normal message\n\nWhat changed and why.\nEOF\n)"';
  for (const [preset, rig] of PRESETS) {
    await using({ ...rig, ownChecks: true }, async (r) => {
      for (const command of [`cat <<'EOF' > data.txt\n${'x'.repeat(30_000)}\nEOF`, commit]) {
        const h = await r.hookAll('Bash', { command });
        assert.deepEqual([h.cards, h.decision], [0, undefined], `${preset}: ${command.slice(0, 40)}`);
      }
    });
  }
});

test('F1: reading the bodies stays linear', () => {
  const shapes: Array<[string, 'sh' | 'pwsh', string]> = [
    ['1 MB heredoc, a substitution on every line', 'sh', `cat <<EOF\n${'now: $(date) ok\n'.repeat(65_000)}EOF`],
    ['4,000 small heredocs, each with a substitution', 'sh', Array.from({ length: 4_000 }, (_, i) => `cat <<E${i}\n$(date)\nE${i}`).join('\n')],
    ['4,000 here-strings run by iex', 'pwsh', `${"@'\nabc\n'@\n".repeat(4_000)}iex $s`],
    ['64k heredoc of plain data', 'sh', `cat <<EOF\n${'line of text\n'.repeat(5_000)}EOF`],
    ['1 MB heredoc of plain data', 'sh', `cat <<'EOF'\n${'a perfectly ordinary line\n'.repeat(40_000)}EOF`],
  ];
  for (const [name, shell, c] of shapes) {
    const t = performance.now();
    longCatastrophic(c, shell);
    const ms = performance.now() - t;
    assert.ok(ms < 600, `${name}: ${Math.round(ms)} ms`);
  }
});

// ------------------------------------------------------------------ F2: padding around a Full delete card

test('F2: in Full a padded PowerShell recursive delete of the project folder gets one card, and a No denies', async () => {
  await using({ preset: 'bypass', follow: true, ownChecks: true }, async (r) => {
    const p = winPath(r);
    const cmds: Array<[string, string]> = [
      ['PowerShell', `Remove-Item -Recurse -Force "${p}"${SPACE}`],
      ['PowerShell', `Remove-Item -Recurse -Force${SPACE}"${p}"`],
      ['PowerShell', `Remove-Item${SPACE}-Recurse -Force "${p}"`],
      ['PowerShell', `Remove-Item -Recurse -Force "${p}"${'\t \r\n'.repeat(3_000)}`],
      ['PowerShell', `rd /s /q "${p}"${SPACE}`],
      ['PowerShell', `cmd /c rd /s /q "${p}"${SPACE}`],
      ['PowerShell', `cmd /c rd /s /q${SPACE}"${p}"`],
      ['Bash', `cmd /c rd /s /q "${p}"${SPACE}`],
      ['Bash', `cmd /c rd /s /q${SPACE}"${p}"`],
      ['Bash', `cmd.exe /c "rmdir /s /q ${p}"${SPACE}`],
      ['Bash', `powershell -NoProfile -Command "Remove-Item -Recurse -Force '${p}'"${SPACE}`],
      // padding that cannot be collapsed: the command is too long to read, and it deletes recursively
      ['PowerShell', `Remove-Item -Recurse -Force "${p}"${';'.repeat(11_000)}`],
      ['PowerShell', `Remove-Item -Recurse -Force .\\dist${';'.repeat(11_000)}`],
      ['Bash', `cmd /c rd /s /q "${p}"${';'.repeat(11_000)}`],
    ];
    for (const [tool, command] of cmds) {
      assert.ok(command.length > MAX_READABLE, command.slice(0, 50));
      const h = await r.hookAll(tool, { command });
      assert.deepEqual([h.cards, h.decision], [1, 'deny'], `${tool}: ${command.slice(0, 60).replace(/\s+/g, ' ')}`);
    }
  });
});

test('F2: padding does not make a delete of something else, or no delete, ask', async () => {
  await using({ preset: 'bypass', follow: true, ownChecks: true }, async (r) => {
    const p = winPath(r);
    const cmds: Array<[string, string]> = [
      ['PowerShell', `Remove-Item -Recurse -Force "${p}\\dist"${SPACE}`],
      ['PowerShell', `Remove-Item -Recurse -Force .\\dist${SPACE}`],
      ['PowerShell', `cmd /c rd /s /q "${p}\\dist"${SPACE}`],
      ['PowerShell', `Get-ChildItem${SPACE}-Recurse`],
      ['PowerShell', `Write-Host hi${';'.repeat(11_000)}`],
      ['Bash', `cmd /c rd /s /q "${p}\\dist"${SPACE}`],
      ['Bash', `cmd /c dir${SPACE}`],
      ['Bash', `rm -rf dist${SPACE}`],
    ];
    for (const [tool, command] of cmds) {
      const h = await r.hookAll(tool, { command });
      assert.deepEqual([h.cards, h.decision], [0, undefined], `${tool}: ${command.slice(0, 60)}`);
    }
  });
});

test('F2: only in Full, and a padded delete that is carded for a Yes goes on', async () => {
  for (const [preset, rig] of PRESETS.slice(1)) {
    await using({ ...rig, ownChecks: true }, async (r) => {
      const h = await r.hookAll('PowerShell', { command: `Remove-Item -Recurse -Force "${winPath(r)}"${SPACE}` });
      assert.equal(h.cards, 0, preset);
    });
  }
  await using({ preset: 'bypass', follow: true, ownChecks: true }, async (r) => {
    const yes = await r.hookAll('PowerShell', { command: `Remove-Item -Recurse -Force "${winPath(r)}"${SPACE}` }, { allow: true });
    assert.deepEqual([yes.cards, yes.decision], [1, undefined]);
  });
});

test('F2: a padded read keeps the folder the shell is in', async () => {
  await using({ preset: 'bypass', follow: true, ownChecks: true }, async (r) => {
    // a folder inside the project that has the project's own name: free when the shell's folder is known, carded when it is not
    const base = winPath(r).split('\\').pop()!;
    const first = await r.hookAll('PowerShell', { command: `Remove-Item -Recurse -Force ${base}` });
    assert.deepEqual([first.cards, first.decision], [0, undefined], 'the folder is known at the start');
    // the padded command is read like the plain one, so the folder is still known after it
    await r.hookAll('PowerShell', { command: `Get-Date${SPACE}` });
    const h = await r.hookAll('PowerShell', { command: `Remove-Item -Recurse -Force ${base}` });
    assert.deepEqual([h.cards, h.decision], [0, undefined]);
  });
});

// ------------------------------------------------------------------ F3: a sibling or a subfolder is not the project folder

const P = 'C:\\work\\proj';
const where = { roots: [P], home: 'C:\\Users\\x' };
const reads = (c: string, k: 'pwsh' | 'cmd' | 'sh', w: Parameters<typeof criticalDeleteRead>[2]): boolean => criticalDeleteRead(c, k, w).reason !== undefined;

test('F3: with the shell\'s folder unknown, a delete of ..\\sibling is not the project folder; one that can be, still is', () => {
  for (const [c, k] of [
    ['Remove-Item -Recurse -Force "..\\other"', 'pwsh'], ['Remove-Item -Recurse -Force ..\\other', 'pwsh'], ['Remove-Item -Recurse -Force ..\\..\\other\\build', 'pwsh'],
    ['rd /s /q ..\\other', 'pwsh'], ['del /s /q ..\\other', 'cmd'], ['rmdir /s /q ..\\other', 'cmd'],
  ] as const) assert.equal(reads(c, k, where), false, c);
  for (const [c, k] of [
    ['Remove-Item -Recurse -Force ..', 'pwsh'], ['Remove-Item -Recurse -Force .', 'pwsh'], ['Remove-Item -Recurse -Force ..\\proj', 'pwsh'],
    ['Remove-Item -Recurse -Force ..\\*', 'pwsh'], ['Remove-Item -Recurse -Force ..\\work', 'pwsh'], ['Remove-Item -Recurse -Force a\\..\\b', 'pwsh'],
    ['rd /s /q ..\\proj', 'cmd'], ['del /s /q ..\\*', 'cmd'],
  ] as const) assert.equal(reads(c, k, where), true, c);
});

test('F3: with the shell\'s folder known, a sibling, a subfolder and a listing of a subfolder are free; the project and its parent are not', () => {
  const known = { ...where, cwd: P };
  for (const [c, k] of [
    ['Remove-Item -Recurse -Force ..\\other', 'pwsh'], ['Remove-Item -Recurse -Force "C:\\work\\other"', 'pwsh'], ['Remove-Item -Recurse -Force dist', 'pwsh'],
    ['Get-ChildItem -Recurse dist | Remove-Item -Recurse -Force', 'pwsh'], ['Get-ChildItem -Path .\\dist -Recurse | Remove-Item -Recurse -Force', 'pwsh'],
    ['Get-ChildItem -Path "C:\\work\\proj\\dist" -Recurse | Remove-Item -Recurse -Force', 'pwsh'],
    ['del /s /q "C:\\work\\proj\\dist"', 'cmd'], ['del /s /q dist', 'cmd'], ['del /s /q ..\\other', 'cmd'],
  ] as const) assert.equal(reads(c, k, known), false, c);
  for (const [c, k] of [
    ['Get-ChildItem -Recurse | Remove-Item -Recurse -Force', 'pwsh'], ['Remove-Item -Recurse -Force ..', 'pwsh'], ['Remove-Item -Recurse -Force "C:\\work\\proj"', 'pwsh'],
    ['del /s /q "C:\\work\\proj"', 'cmd'], ['del /s /q ..', 'cmd'],
  ] as const) assert.equal(reads(c, k, known), true, c);
});

test('F3: in Full the same forms, through the hook: a sibling and a subfolder get no card, the project and a listing of all of it do', async () => {
  await using({ preset: 'bypass', follow: true, ownChecks: true }, async (r) => {
    const p = winPath(r);
    const parent = p.replace(/\\[^\\]+$/, '');
    for (const [tool, command] of [
      ['PowerShell', 'Remove-Item -Recurse -Force ..\\other'], ['PowerShell', `Remove-Item -Recurse -Force "${parent}\\other"`],
      ['PowerShell', `Get-ChildItem -Path "${p}\\dist" -Recurse | Remove-Item -Recurse -Force`],
      ['PowerShell', 'Get-ChildItem -Path .\\dist -Recurse | Remove-Item -Recurse -Force'],
      ['Bash', `cmd /c del /s /q "${p}\\dist"`], ['Bash', 'cmd /c del /s /q dist'], ['Bash', 'cmd /c del /s /q ..\\other'],
    ] as const) {
      const h = await r.hookAll(tool, { command });
      assert.deepEqual([h.cards, h.decision], [0, undefined], `${tool}: ${command}`);
    }
    for (const [tool, command] of [
      ['PowerShell', 'Get-ChildItem -Recurse | Remove-Item -Recurse -Force'],
      ['PowerShell', `Remove-Item -Recurse -Force "${parent}"`],
      ['Bash', `cmd /c del /s /q "${p}"`],
    ] as const) {
      const h = await r.hookAll(tool, { command });
      assert.deepEqual([h.cards, h.decision], [1, 'deny'], `${tool}: ${command}`);
    }
  });
});

test('F3: after a command the delete reader could not follow, a sibling is still free and the project folder is still carded', async () => {
  await using({ preset: 'bypass', follow: true, ownChecks: true }, async (r) => {
    const p = winPath(r);
    const base = p.split('\\').pop()!;
    // the folder the shell is in is no longer known after this
    await r.hookAll('PowerShell', { command: `Set-Location $env:TEMP; Get-Date` });
    const sibling = await r.hookAll('PowerShell', { command: 'Remove-Item -Recurse -Force ..\\other-folder-xyz' });
    assert.deepEqual([sibling.cards, sibling.decision], [0, undefined]);
    const same = await r.hookAll('PowerShell', { command: `Remove-Item -Recurse -Force ..\\${base}` });
    assert.deepEqual([same.cards, same.decision], [1, 'deny']);
  });
});
