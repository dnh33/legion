// test/claude-own-checks-fix3b.test.ts: fix round A+B 3, the rest, for "Claude agents follow Claude's own permission checks" (0.3.6).
// N2: in Full a PowerShell (or cmd) recursive delete of the project folder or a folder above it gets a card (Claude's bypass mode skips it on Windows).
// N3: in Full a Yes on a Legion hook card is not followed by a second card from canUseTool for the same call.
// N4: the Full preset copy for Claude agents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gatesRig } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import { CLAUDE_PRESET_LINES } from '../src/shared/claude-checks-copy.js';

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


const SPACE = ' '.repeat(11_000);


const winPath = (r: GatesRig): string => r.projectDir().replace(/\//g, '\\');
test('N2: in Full a PowerShell recursive delete of the project folder or a folder above it gets one card, and a No denies', async () => {
  await using({ preset: 'bypass', follow: true, ownChecks: true }, async (r) => {
    const p = winPath(r);
    const cmds = [
      `Remove-Item -Recurse -Force "${p}"`,
      `Remove-Item -Path '${p}' -Recurse`,
      `rm -r -fo "${p}"`,
      `ri "${p}" -Recurse -Force`,
      `del "${p}" -Recurse`,
      `erase "${p}" -Recurse`,
      `Remove-Item -Recurse -Force ..`,
      `Remove-Item -Recurse -Force .`,
      `rd /s /q "${p}"`,
      `rmdir /s /q "${p}"`,
      `cmd /c rd /s /q "${p}"`,
      `cmd.exe /c "rmdir /s /q ${p}"`,
      `Get-ChildItem; Remove-Item -Recurse -Force "${p}"`,
    ];
    for (const command of cmds) {
      const h = await r.hookAll('PowerShell', { command });
      assert.deepEqual([h.cards, h.decision], [1, 'deny'], command);
    }
    // not the project folder: no card
    for (const command of [`Remove-Item -Recurse -Force "${p}\\build"`, 'Remove-Item -Recurse -Force .\\dist', `cmd /c rd /s /q "${p}\\dist"`, 'Get-ChildItem -Recurse']) {
      const h = await r.hookAll('PowerShell', { command });
      assert.deepEqual([h.cards, h.decision], [0, undefined], command);
    }
  });
});

test('N2: the same through cmd in the Bash tool; a Yes lets it go on', async () => {
  await using({ preset: 'bypass', follow: true, ownChecks: true }, async (r) => {
    const p = winPath(r);
    for (const command of [`cmd /c rd /s /q "${p}"`, `cmd.exe /c "rmdir /s /q ${p}"`, `powershell -NoProfile -Command "Remove-Item -Recurse -Force '${p}'"`, `echo hi && pwsh -c 'Remove-Item -Recurse .'`]) {
      const h = await r.hookAll('Bash', { command });
      assert.deepEqual([h.cards, h.decision], [1, 'deny'], command);
      assert.match(h.summaries[0] ?? '', /deletes .*holds your project/);
    }
    // a folder inside the project, or a command that deletes nothing there: no card
    for (const command of [`cmd /c rd /s /q "${p}\\dist"`, 'cmd /c dir', 'powershell -c "Get-Date"', `powershell -c "Remove-Item -Recurse '${p}\\build'"`]) {
      const h = await r.hookAll('Bash', { command });
      assert.deepEqual([h.cards, h.decision], [0, undefined], command);
    }
    const yes = await r.hookAll('PowerShell', { command: `Remove-Item -Recurse -Force "${p}"` }, { allow: true });
    assert.deepEqual([yes.cards, yes.decision], [1, undefined], 'the owner said yes: the call goes on');
  });
});

test('N2: only in Full: in Smart, Ask and Accept edits Claude asks itself, so the hook adds no card; with the switch off Full refuses as before', async () => {
  for (const [preset, rig] of PRESETS.slice(1)) {
    await using({ ...rig, ownChecks: true }, async (r) => {
      const h = await r.hookAll('PowerShell', { command: `Remove-Item -Recurse -Force "${winPath(r)}"` });
      assert.equal(h.cards, 0, preset);
    });
  }
  await using({ preset: 'bypass', follow: true, ownChecks: false }, async (r) => {
    const h = await r.hookAll('PowerShell', { command: `Remove-Item -Recurse -Force "${winPath(r)}"` });
    assert.deepEqual([h.cards, h.decision], [0, 'deny'], 'switch off: refused with no card, as on cloud/main');
  });
});

// ------------------------------------------------------------------ N3: one card per call in Full

const CRITICAL = { decisionReason: 'Dangerous rm operation on working directory or its ancestor: C:/work/project', decisionReasonType: 'safetyCheck' };
test('N3: in Full a Yes on a Legion hook card is not followed by a second card from canUseTool for the same call', async () => {
  await using({ preset: 'bypass', follow: true, ownChecks: true }, async (r) => {
    const command = `rm -rf${SPACE}/`;
    const h = await r.hookAll('Bash', { command }, { allow: true, id: 'n3a' });
    assert.deepEqual([h.cards, h.decision], [1, undefined]);
    const c = await r.canUse('Bash', { command }, 'n3a', true, CRITICAL);
    assert.deepEqual([c.cards, c.behavior], [0, 'allow'], 'the hook card already answered this call');
    // a different call still gets its own card
    const other = await r.canUse('Bash', { command: 'rm -rf "C:/work/project"' }, 'n3b', false, CRITICAL);
    assert.deepEqual([other.cards, other.behavior], [1, 'deny']);
    // and the answer is used once
    const again = await r.canUse('Bash', { command }, 'n3a', false, CRITICAL);
    assert.deepEqual([again.cards, again.behavior], [1, 'deny']);
  });
});

test('N3: a No on the hook card stops the call there; canUseTool is never reached', async () => {
  await using({ preset: 'bypass', follow: true, ownChecks: true }, async (r) => {
    const h = await r.hookAll('Bash', { command: `rm -rf${SPACE}/` }, { allow: false, id: 'n3c' });
    assert.deepEqual([h.cards, h.decision], [1, 'deny']);
  });
});

// ------------------------------------------------------------------ N4: the Full copy

test('N4: the Full preset line for Claude agents is plain and true', () => {
  const line = CLAUDE_PRESET_LINES.bypass;
  assert.match(line, /without asking/);
  assert.match(line, /deleting your project folder or a folder above it, which still asks/);
  assert.match(line, /Legion's stop on disastrous commands always apply/);
  assert.ok(!/never asks/i.test(line), line);
  assert.ok(!/—/.test(line), 'no em dash');
});
