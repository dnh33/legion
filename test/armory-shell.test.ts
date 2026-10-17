/** Owner decision 2026-10-06: inline shell in skills (Claude Code's bang-backtick preprocessing) is blocked by default, with an opt-in switch. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { isClientRoute } from '../src/core/admin.js';
import { hasShellPreprocessing } from '../src/core/armory/files.js';
import { armoryFilePath, readArmoryFile } from '../src/core/armory/store.js';
import { init, ok, setup, waitDone } from './library-fakes.js';
import { armoryRig, md, writeFile } from './armory-rig.js';
import { closeAll, mount } from './token-harness.js';

after(closeAll);

const BANG_INLINE = 'Branch: !`git branch --show-current`';
const BANG_FENCE = 'Before:\n\n```!\ngit status\n```\n';

describe('the detector', () => {
  it('flags the inline form and the fenced form', () => {
    assert.equal(hasShellPreprocessing(BANG_INLINE), true);
    assert.equal(hasShellPreprocessing(BANG_FENCE), true);
  });
  it('does not flag a plain code block, an exclamation in prose, or a bang before a space', () => {
    assert.equal(hasShellPreprocessing('```bash\nls\n```\n'), false);
    assert.equal(hasShellPreprocessing('Careful! Run `ls` yourself. Done!'), false);
    assert.equal(hasShellPreprocessing('Wow! `code` here'), false);
  });
});

describe('the allowSkillShell switch', () => {
  it('is false when the field is absent, and GET /api/armory says so', async () => {
    const r = armoryRig();
    const g = await r.call('GET', '/api/armory');
    assert.equal(g.allowSkillShell, false);
    assert.equal(readArmoryFile(r.dataDir).allowSkillShell, undefined);
    assert.equal(r.mod.skillShellAllowed!(), false);
  });
  it('POST /api/armory/allow-shell sets and clears it, and refuses a non-boolean', async () => {
    const r = armoryRig();
    assert.deepEqual(await r.call('POST', '/api/armory/allow-shell', { allow: true }), { allowSkillShell: true });
    assert.equal((await r.call('GET', '/api/armory')).allowSkillShell, true);
    assert.equal(r.mod.skillShellAllowed!(), true);
    assert.deepEqual(await r.call('POST', '/api/armory/allow-shell', { allow: false }), { allowSkillShell: false });
    assert.equal(r.mod.skillShellAllowed!(), false);
    for (const bad of ['true', 1, undefined, null]) {
      await assert.rejects(r.call('POST', '/api/armory/allow-shell', { allow: bad }), /allow must be true or false/);
    }
  });
  it('a hand-edited non-true value in armory.json reads as blocked', async () => {
    const r = armoryRig();
    await r.call('GET', '/api/armory');
    const path = armoryFilePath(r.dataDir);
    const f = JSON.parse(readFileSync(path, 'utf8'));
    f.allowSkillShell = 'yes';
    writeFileSync(path, JSON.stringify(f));
    assert.equal(r.mod.skillShellAllowed!(), false);
  });
  it('is an admin route: not on the MCP client list, and 403 with only the bearer token', async () => {
    assert.equal(isClientRoute('POST', '/api/armory/allow-shell'), false);
    const m = await mount();
    const r = await m.http('POST', '/api/armory/allow-shell', { allow: true });
    assert.equal(r.status, 403);
  });
});

describe('the engine option', () => {
  async function runWith(allow?: boolean) {
    const rig = armoryRig();
    if (allow !== undefined) await rig.call('POST', '/api/armory/allow-shell', { allow });
    const s = setup((c) => (async function* () { yield init('s' + c.n); yield ok('done', 's' + c.n); })(), { modules: [rig.mod] });
    await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'go', source: 'ui' }));
    return s.calls.at(-1)!.options.settings;
  }
  it('blocks inline shell on every run by default, with the connector switch kept', async () => {
    assert.deepEqual(await runWith(), { disableClaudeAiConnectors: true, disableSkillShellExecution: true });
  });
  it('blocks when the owner switched it off again', async () => {
    assert.equal((await runWith(false)).disableSkillShellExecution, true);
  });
  it('lets it run only when the owner allowed it', async () => {
    assert.equal((await runWith(true)).disableSkillShellExecution, false);
  });
  it('blocks when no module answers (a build without the Armory)', async () => {
    const s = setup((c) => (async function* () { yield init('s' + c.n); yield ok('d', 's' + c.n); })());
    await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'go', source: 'ui' }));
    assert.equal(s.calls.at(-1)!.options.settings.disableSkillShellExecution, true);
  });
});

describe('runsCommandsOnLoad', () => {
  it('is reported per skill in GET /api/armory and per entry in /effective, false for built-ins and plain skills', async () => {
    const r = armoryRig({ cc: {
      personal: { loud: md('loud', 'Runs.', '', BANG_INLINE), fenced: md('fenced', 'Runs.', '', BANG_FENCE), plain: md('plain', 'Calm.', '', '```bash\nls\n```\nGo! now.') },
      plugins: [{ key: 'sp@m', name: 'sp', commands: { cmd: md('cmd', 'A command.', '', BANG_INLINE) } }],
    } });
    for (const id of ['loud', 'fenced', 'plain', 'sp:cmd', 'deep-research']) await r.call('POST', '/api/armory/state', { id, state: 'on' });
    const g = await r.call('GET', '/api/armory');
    const flag = (id: string): unknown => g.skills.find((s: any) => s.id === id).runsCommandsOnLoad;
    assert.equal(flag('loud'), true);
    assert.equal(flag('fenced'), true);
    assert.equal(flag('sp:cmd'), true);
    assert.equal(flag('plain'), false);
    assert.equal(flag('deep-research'), false);
    const e = await r.call('GET', '/api/armory/effective?agent=alpha');
    const eff = (id: string): unknown => [...e.armory, ...e.claudeCode].find((x: any) => x.id === id)?.runsCommandsOnLoad;
    assert.equal(eff('loud'), true);
    assert.equal(eff('sp:cmd'), true);
    assert.equal(eff('plain'), false);
    assert.equal(eff('deep-research'), false);
  });
  it('reads the whole file, not just its head (a command far down is still found)', async () => {
    const r = armoryRig({ cc: {} });
    writeFile(join(r.home, 'skills', 'long', 'SKILL.md'), md('long', 'Long.', '', 'x'.repeat(40_000) + '\n' + BANG_INLINE));
    assert.equal((await r.call('GET', '/api/armory')).skills.find((s: any) => s.id === 'long').runsCommandsOnLoad, true);
  });
});
