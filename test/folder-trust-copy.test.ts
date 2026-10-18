// test/folder-trust-copy.test.ts: the small items that ride with folder trust (security review): M2 (the Settings copy no longer compares Legion to a terminal),
// L1 (a trailing-dot spelling of .vscode or .husky is carded in Smart too), L2 (one line that in Bypass a command can delete the keys folders).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-cleanup.js';
import { gatesRig } from './gates-rig.js';
import { BYPASS_KEYS_LINE, GATES, PRESET_LINES } from '../src/shared/gates-registry.js';
import { GatesStore } from '../src/core/gates-settings/store.js';
import { makeSigner } from '../src/core/gates-settings/sign.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

test('M2: the Inherit setting no longer says it is like a terminal; it says what loads and when', () => {
  const src = readFileSync(join(REPO, 'ui/src/components/Settings.tsx'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('Inherit my Claude Code settings') && l.includes('<em>'))!;
  assert.ok(line, 'the setting row');
  assert.doesNotMatch(line, /like Claude Code in a terminal/);
  assert.match(line, /read your own Claude Code settings/);
  assert.match(line, /only when they carry no commands, or when you trusted that folder/);
  assert.match(line, /Folders you trust/);
  assert.match(line, /separate and applies whichever way/, 'the MCP sentence is still there');
  assert.doesNotMatch(line, /[—–]/, 'no em dash');
});

test('L2: Bypass says in the Gates page line, the confirm dialog and the rail row that a command can delete the folders that hold the keys', () => {
  assert.match(BYPASS_KEYS_LINE, /provider keys/);
  assert.match(BYPASS_KEYS_LINE, /connector tokens/);
  assert.doesNotMatch(BYPASS_KEYS_LINE, /[—–]/);
  assert.ok(PRESET_LINES.bypass.includes(BYPASS_KEYS_LINE), 'the preset line');
  const rail = GATES.find((g) => g.id === 'rail-protected-paths')!;
  assert.ok(rail.protects.includes(BYPASS_KEYS_LINE), 'the rail row');
  const store = new GatesStore(join(tempDir('legion-l2-'), 'gates'), { allowed: ['ask', 'accept-edits', 'smart', 'bypass'], signer: makeSigner(Buffer.alloc(32, 5))! });
  assert.ok(store.preview('app', { preset: 'bypass' }).loosening.join('\n').includes(BYPASS_KEYS_LINE), 'the Bypass confirm');
  assert.ok(store.preview('app', { preset: 'bypass' }).loosening[0]!.length <= 400, 'the dialog cuts a line at 400 characters: the Bypass line must fit whole');
  assert.ok(!store.preview('app', { preset: 'smart' }).loosening.join('\n').includes(BYPASS_KEYS_LINE), 'only Bypass says it');
});

test('L1: in Smart a shell write through a trailing-dot spelling of .vscode, .husky, .git or .claude raises the protected-path card; src does not', async () => {
  const r = await gatesRig({ preset: 'smart', follow: true });
  try {
    for (const command of ['Set-Content .vscode.\\tasks.json x', 'cp a .husky./pre-commit', 'Set-Content .git.\\hooks\\pre-commit x', 'Set-Content .claude.\\settings.json x', 'Set-Content .vscode\\launch.json x']) {
      const x = await r.run('PowerShell', { command });
      assert.equal(x.card, true, command);
      assert.match(x.summary ?? '', /^Legion wants to change \.(vscode|husky|git|claude)\./, command);
    }
    assert.equal((await r.run('PowerShell', { command: 'Set-Content src\\main.ts x' })).card, false);
  } finally { r.stop(); }
});
