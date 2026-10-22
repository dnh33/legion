// test/claude-own-checks-fix5.test.ts: fix round A+B 5 for "Claude agents follow Claude's own permission checks" (0.3.8).
// N1: a recursive switch that touches a separator (`-Recurse;`, `/s/q`) does not step around the padded-delete card in Full.
// N2: a heredoc whose opener line pipes into anything is read: the pipe can run the body.
// N3: a here-string saved as a script and run, or run through InvokeScript, ExpandString or Add-Type, is read.
// N5: a quoted heredoc body that nothing runs is data, even when it holds `$(` or a backtick.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gatesRig } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import { longCatastrophic, MAX_READABLE, recursiveDeleteSnippet, refuseCatastrophic } from '../src/core/exec/shell-floor.js';

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
const SEMI = ';'.repeat(11_000);
const FILL = ' ; :'.repeat(4_000);
const winPath = (r: GatesRig): string => r.projectDir().replace(/\//g, '\\');

// ------------------------------------------------------------------ N1: a switch that touches a separator

test('N1: a recursive switch next to a separator, a bracket or the end is found', () => {
  for (const t of [
    'Remove-Item -Force -Path "C:\\a" -Recurse', 'Remove-Item "C:\\a" -Recurse;', 'Remove-Item "C:\\a" -Recurse|Out-Null', '(Remove-Item "C:\\a" -Recurse)',
    '& { Remove-Item "C:\\a" -Recurse }', 'Remove-Item "C:\\a" -r;', 'Remove-Item "C:\\a" -Recurse:$true;',
    'rd /s/q "C:\\a"', 'rd/s/q "C:\\a"', 'cmd /c rd /s/q "C:\\a"', 'rmdir /s;', 'del /s&echo', 'rd /s',
  ]) assert.ok(recursiveDeleteSnippet(t), t);
  for (const t of ['Remove-Item "C:\\a\\file.txt"', 'Get-ChildItem -Recurse', 'Write-Host hi -r', 'Remove-Item C:\\src\\s', 'rd C:/src/x']) assert.equal(recursiveDeleteSnippet(t), undefined, t);
});

test('N1: in Full a padded recursive delete of the project folder whose switch touches a separator gets one card, and a No denies', async () => {
  await using({ preset: 'bypass', follow: true, ownChecks: true }, async (r) => {
    const p = winPath(r);
    const cmds: Array<[string, string]> = [
      ['PowerShell', `Remove-Item -Force -Path "${p}" -Recurse${SEMI}`],
      ['PowerShell', `Remove-Item "${p}" -Recurse ${SEMI}`],
      ['PowerShell', `(Remove-Item "${p}" -Recurse)${SEMI}`],
      ['PowerShell', `& { Remove-Item "${p}" -Recurse }${SEMI}`],
      ['PowerShell', `Remove-Item -Force -Path "${p}" -Recurse${FILL}`],
      ['PowerShell', `rd /s/q "${p}"${SEMI}`],
      ['PowerShell', `rd/s/q "${p}"${SEMI}`],
      ['PowerShell', `cmd /c rd /s/q "${p}"${SEMI}`],
      ['PowerShell', `cmd /c "rd /s /q ${p}"${SEMI}`],
      ['Bash', `cmd /c rd /s/q "${p}"${FILL}`],
      ['Bash', `cmd /c rd /s /q "${p}"${FILL}`],
    ];
    for (const [tool, command] of cmds) {
      assert.ok(command.length > MAX_READABLE, command.slice(0, 50));
      const h = await r.hookAll(tool, { command });
      assert.deepEqual([h.cards, h.decision], [1, 'deny'], `${tool}: ${command.slice(0, 60)}`);
    }
  });
});

test('N1: the same padding around a delete of something else, or no delete, stays free', async () => {
  await using({ preset: 'bypass', follow: true, ownChecks: true }, async (r) => {
    const p = winPath(r);
    for (const [tool, command] of [
      ['PowerShell', `Remove-Item -Force -Path "${p}\\dist" -Recurse${SEMI}`],
      ['PowerShell', `Write-Host hi${SEMI}`],
      ['PowerShell', `Get-ChildItem -Recurse${SEMI}`],
      ['PowerShell', `Remove-Item -Recurse .\\dist${SEMI}`],
      ['Bash', `cmd /c dir${FILL}`],
    ] as const) {
      const h = await r.hookAll(tool, { command });
      assert.deepEqual([h.cards, h.decision], [0, undefined], `${tool}: ${command.slice(0, 60)}`);
    }
  });
});

// ------------------------------------------------------------------ N2: a heredoc that is piped

const RUNNERS = ['sh', 'bash', 'pwsh', 'python -', 'zsh', 'mksh'];

test('N2: a heredoc whose pipe continues after the body is read', () => {
  for (const runner of RUNNERS) {
    const c = `cat <<EOF |\nrm -rf /\n${PAD}\nEOF\n${runner}`;
    assert.ok(c.length > MAX_READABLE);
    assert.equal(longCatastrophic(c, 'sh')?.kind, 'found', runner);
  }
});

test('N2: a heredoc piped into anything on its own line is read (a runner the list does not know)', () => {
  for (const sink of ['mksh', '$SHELL', 'fish', 'tee /tmp/x', 'tr a b']) {
    const c = `cat <<EOF | ${sink}\nrm -rf /\n${PAD}\nEOF`;
    assert.equal(longCatastrophic(c, 'sh')?.kind, 'found', sink);
  }
  assert.equal(longCatastrophic(`cat <<'EOF' |\n${'a line of plain data\n'.repeat(1_000)}EOF\nwc -c`, 'sh'), undefined, 'a piped body with nothing disastrous in it');
});

test('N2: a heredoc that is not piped stays data', () => {
  assert.equal(longCatastrophic(`cat > notes.md <<EOF\n${'rm -rf /\n'.repeat(2_000)}EOF\nsh`, 'sh'), undefined);
  assert.equal(longCatastrophic(`cat <<'EOF' > data.txt\n${'rm -rf /\n'.repeat(2_000)}EOF\necho done | cat`, 'sh'), undefined);
});

test('N2: the pipe shape gets one card in Full, Smart, Ask and Accept edits, and a No denies', async () => {
  for (const [preset, rig] of PRESETS) {
    for (const runner of ['sh', 'bash', 'pwsh', 'python -']) {
      await using({ ...rig, ownChecks: true }, async (r) => {
        const h = await r.hookAll('Bash', { command: `cat <<EOF |\nrm -rf /\n${PAD}\nEOF\n${runner}` });
        assert.deepEqual([h.cards, h.decision], [1, 'deny'], `${preset}: ${runner}`);
      });
    }
  }
});

// ------------------------------------------------------------------ N3: a here-string saved and run, or run by a method the list did not know

const BODY = `Remove-Item -Recurse -Force C:\\\n${PAD}`;
const PS_RUNS: Array<[string, string]> = [
  ['Out-File then ./x.ps1', `@'\n${BODY}\n'@ | Out-File x.ps1\n./x.ps1`],
  ['Set-Content then . .\\x.ps1', `@'\n${BODY}\n'@ | Set-Content x.ps1\n. .\\x.ps1`],
  ['redirect then & ./x.ps1', `@'\n${BODY}\n'@ > x.ps1\n& ./x.ps1`],
  ['Out-File then powershell -File', `@'\n${BODY}\n'@ | Out-File x.ps1\npowershell -File x.ps1`],
  ['saved as .bat and run', `@'\n${BODY}\n'@ | Set-Content x.bat\n.\\x.bat`],
  ['saved as .cmd and run', `@'\n${BODY}\n'@ | Set-Content x.cmd\n.\\x.cmd`],
  ['InvokeScript', `$s = @'\n${BODY}\n'@\n$ExecutionContext.InvokeCommand.InvokeScript($s)`],
  ['InvokeScript, lower case', `$s = @'\n${BODY}\n'@\n$executioncontext.invokecommand.invokescript($s)`],
  ['ExpandString', `$s = @'\n$(Remove-Item -Recurse -Force C:\\)\n${PAD}\n'@\n$ExecutionContext.InvokeCommand.ExpandString($s)`],
  ['Add-Type', `$s = @'\nusing System; public class X { public static void Y(){ } }\n// Remove-Item -Recurse -Force C:\\\n${PAD}\n'@\nAdd-Type -TypeDefinition $s; [X]::Y()`],
];

test('N3: a here-string saved as a script and run, or run through InvokeScript, ExpandString or Add-Type, is read', () => {
  const found: Array<[string, string]> = [
    ...PS_RUNS.slice(0, 8),
    ['ExpandString (flat)', `$s = @'\n$(Remove-Item -Recurse -Force C:\\)\n${PAD}\n'@\n$ExecutionContext.InvokeCommand.ExpandString($s)`],
  ];
  for (const [name, c] of found) {
    assert.ok(c.length > MAX_READABLE, name);
    assert.equal(longCatastrophic(c, 'pwsh')?.kind, 'found', name);
  }
  // text with a here-string and no sign that anything runs it stays data
  assert.equal(longCatastrophic(`@'\n${BODY}\n'@ | Out-File notes.txt\nGet-Content notes.txt`, 'pwsh'), undefined);
  assert.equal(longCatastrophic(`Set-Content -Path big.txt -Value @'\n${BODY}\n'@`, 'pwsh'), undefined);
});

test('N3: the short form (under 10,000 characters) reads the same shapes', () => {
  const body = 'Remove-Item -Recurse -Force C:\\';
  for (const [name, c] of [
    ['InvokeScript', `$s = @'\n${body}\n'@\n$ExecutionContext.InvokeCommand.InvokeScript($s)`],
    ['ExpandString', `$s = @'\n$(${body})\n'@\n$ExecutionContext.InvokeCommand.ExpandString($s)`],
    ['Add-Type', `$s = @'\n${body}\n'@\nAdd-Type -TypeDefinition $s`],
    ['script block', `$s = @'\n${body}\n'@\n& ([scriptblock]::Create($s))`],
    ['saved and run', `@'\n${body}\n'@ | Out-File x.ps1\n./x.ps1`],
  ] as const) assert.match(refuseCatastrophic(c, 'pwsh') ?? '', /^Refused/, name);
  assert.equal(refuseCatastrophic(`Set-Content a.txt @'\n${body}\n'@`, 'pwsh'), undefined, 'a here-string that only a file receives');
});

test('N3: the saved-and-run shapes get one card in all four presets', async () => {
  for (const [preset, rig] of PRESETS) {
    for (const [name, command] of PS_RUNS.filter(([n]) => !/ExpandString|Add-Type/.test(n))) {
      await using({ ...rig, ownChecks: true }, async (r) => {
        const h = await r.hookAll('PowerShell', { command });
        assert.deepEqual([h.cards, h.decision], [1, 'deny'], `${preset}: ${name}`);
      });
    }
  }
});

// ------------------------------------------------------------------ N5: a quoted body that nothing runs is data

test('N5: a long quoted heredoc of data with $( or a backtick and an unbalanced ( is not read', () => {
  const prose = (n: number): string => 'Notes :( sorry (see below\nrun `npm test` or $(date) first\n'.repeat(n);
  for (const q of [`'EOF'`, `"EOF"`, `\\EOF`]) {
    const c = `cat > README.md <<${q}\n${prose(400)}EOF`;
    assert.ok(c.length > MAX_READABLE, q);
    assert.equal(longCatastrophic(c, 'sh'), undefined, q);
  }
  assert.equal(longCatastrophic(`git commit -F - <<'EOF'\n${prose(400)}EOF`, 'sh'), undefined, 'commit message from stdin');
  // the text after the body is still read
  assert.equal(longCatastrophic(`cat > README.md <<'EOF'\n${prose(400)}EOF\nrm -rf /`, 'sh')?.kind, 'found');
});

test('N5: a quoted body that something runs, and an unquoted body with $( or a backtick, is still read', () => {
  const tail = 'x'.repeat(12_000);
  for (const [name, c] of [
    ['quoted, fed to bash', `bash <<'EOF'\n$(rm -rf /)\n${tail}\nEOF`],
    ['quoted, piped to a shell', `cat <<'EOF' | sh\nrm -rf /\n${tail}\nEOF`],
    ['quoted, pipe continues', `cat <<'EOF' |\nrm -rf /\n${tail}\nEOF\nsh`],
    ['quoted, run by eval', `eval "$(cat <<'EOF'\nrm -rf /\n${tail}\nEOF\n)"`],
    ['unquoted, substitution', `cat <<EOF\n$(rm -rf /)\n${tail}\nEOF`],
    ['unquoted, backticks', `cat <<EOF\n\`rm -rf /\`\n${tail}\nEOF`],
  ] as const) assert.equal(longCatastrophic(c, 'sh')?.kind, 'found', name);
});

test('N5: a long data heredoc with an unbalanced ( gets no card in any preset', async () => {
  const body = 'Notes :( sorry (see below\nrun `npm test` or $(date) first\n'.repeat(400);
  for (const [preset, rig] of PRESETS) {
    await using({ ...rig, ownChecks: true }, async (r) => {
      const h = await r.hookAll('Bash', { command: `cat > README.md <<'EOF'\n${body}EOF` });
      assert.deepEqual([h.cards, h.decision], [0, undefined], preset);
    });
  }
});

test('fix 5: reading the new shapes stays linear', () => {
  const shapes: Array<[string, 'sh' | 'pwsh', string]> = [
    ['64k quoted heredoc, $( on every line', 'sh', `cat <<'EOF' > a\n${'now: $(date) (ok\n'.repeat(4_000)}EOF`],
    ['1 MB quoted heredoc, $( on every line', 'sh', `cat <<'EOF' > a\n${'now: $(date) (ok\n'.repeat(65_000)}EOF`],
    ['7.9 MB quoted heredoc', 'sh', `cat <<'EOF' > a\n${'now: $(date) (ok\n'.repeat(460_000)}EOF`],
    ['64k piped heredoc', 'sh', `cat <<EOF |\n${'line of text\n'.repeat(5_000)}EOF\nwc -c`],
    ['1 MB piped heredoc', 'sh', `cat <<EOF |\n${'line of text\n'.repeat(80_000)}EOF\nwc -c`],
    ['7.9 MB piped heredoc', 'sh', `cat <<EOF |\n${'line of text\n'.repeat(600_000)}EOF\nwc -c`],
    ['64k here-strings, saved and run', 'pwsh', `${"@'\nabc\n'@ | Out-File x.ps1\n".repeat(2_500)}./x.ps1`],
    ['7.9 MB of ;', 'pwsh', `Remove-Item -Recurse a${';'.repeat(7_900_000)}`],
    ['7.9 MB of ; and statements', 'pwsh', `${'a;;;;;;;;b'.repeat(700_000)}`],
  ];
  for (const [name, shell, c] of shapes) {
    const t = performance.now();
    longCatastrophic(c, shell);
    recursiveDeleteSnippet(c);
    const ms = performance.now() - t;
    assert.ok(ms < 1_500, `${name}: ${Math.round(ms)} ms`);
  }
});
