/**
 * Armory security round 3 (Release A2a): hidden-text detection, scoped wording, the /command check on a re-sent request, the versioned
 * delivery folder, the common Claude Code commands, and the case-insensitive Skill gate.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CONTINUE_PROMPT } from '../src/shared/continue.js';
import { CLI_COMMANDS, refusedCommand } from '../src/core/armory/catalog.js';
import { deliveryOps, deliveryRoot } from '../src/core/armory/delivery.js';
import { findHiddenChars, prepareImport, reviewImport } from '../src/core/armory/files.js';
import { skillFolder } from '../src/core/armory/store.js';
import { hiddenCharsLine } from '../src/shared/armory-view.js';
import { init, ok, setup } from './library-fakes.js';
import { armoryRig, own, mkAgent, md, writeFile } from './armory-rig.js';

const alpha = mkAgent('alpha');
const BACKSLASH = String.fromCharCode(92);
const err = (subtype: string, errors: string[] = []) => ({ type: 'result', subtype, is_error: true, errors, total_cost_usd: 0.02, num_turns: 3, session_id: 'sess-1' });

describe('1. hidden text is flagged, never silently stripped', () => {
  it('the detector finds each class, counts them, and ignores a BOM at position 0 only', () => {
    const classes: [string, string][] = [['U+200B', '​'], ['U+200F', '‏'], ['U+202A', '‪'], ['U+202E', '‮'], ['U+2066', '⁦'], ['U+2069', '⁩'], ['U+FEFF', '﻿'], ['U+00AD', '­']];
    for (const [cp, ch] of classes) {
      assert.deepEqual(findHiddenChars('a.md', `x${ch}y${ch}z`), [{ file: 'a.md', codepoint: cp, count: 2 }], cp);
    }
    assert.deepEqual(findHiddenChars('a.md', '﻿plain'), [], 'a leading BOM is a file marker');
    assert.deepEqual(findHiddenChars('a.md', 'a﻿b'), [{ file: 'a.md', codepoint: 'U+FEFF', count: 1 }]);
    assert.deepEqual(findHiddenChars('a.md', 'ordinary text, naive café, 日本語, emoji \u{1F600}, a normal-hyphen and a non-breaking space'), []);
    assert.deepEqual(findHiddenChars('a.md', 'a​b‮c'), [{ file: 'a.md', codepoint: 'U+200B', count: 1 }, { file: 'a.md', codepoint: 'U+202E', count: 1 }]);
  });

  it('the import review reports file, codepoint and count for SKILL.md and a reference, and keeps the text as it is', () => {
    const skill = '---\nname: s\ndescription: Does s.\n---\n\nBody with a hid​den mark and a flip ‮ here.\n';
    const files = [{ path: 's/SKILL.md', text: skill }, { path: 's/ref/a.md', text: 'ref​​' }, { path: 's/ref/clean.md', text: 'fine' }];
    const r = reviewImport({ files });
    assert.equal(r.ok, true);
    assert.deepEqual(r.hiddenChars, [
      { file: 'SKILL.md', codepoint: 'U+200B', count: 1 }, { file: 'SKILL.md', codepoint: 'U+202E', count: 1 }, { file: 'ref/a.md', codepoint: 'U+200B', count: 2 },
    ].sort((a, b) => (a.file === b.file ? 0 : a.file === 'SKILL.md' ? -1 : 1)), 'one entry per file and character kind');
    assert.match(r.skillText, /hid​den/, 'the character is still in the text the owner reads: it is flagged, not stripped');
    assert.equal(prepareImport({ files }).files['ref/a.md'], 'ref​​');
    const clean = skill.replace(/[​‮]/g, '');
    assert.deepEqual(reviewImport({ files: [{ path: 's/SKILL.md', text: clean }] }).hiddenChars, []);
    assert.deepEqual(reviewImport({ files: [{ path: 'x.md', text: 'x' }] }).hiddenChars, [], 'a refusal carries an empty list');
    // a file that is left out (not .md) is not written, so it is not in the review
    assert.deepEqual(reviewImport({ files: [{ path: 's/SKILL.md', text: clean }, { path: 's/x.txt', text: 'a​b' }] }).hiddenChars, []);
  });

  it('the review line names the characters in plain words', () => {
    assert.equal(hiddenCharsLine([]), '');
    assert.equal(hiddenCharsLine(undefined), '');
    assert.equal(hiddenCharsLine([{ file: 'SKILL.md', codepoint: 'U+200B', count: 2 }]), 'Contains hidden or direction-changing characters: U+200B x2 in SKILL.md.');
  });

  it('GET /api/armory flags hiddenText per skill (SKILL.md or a reference): one detector for import and catalog', async () => {
    const r = armoryRig({ inherit: false });
    writeFile(join(skillFolder(r.dataDir, 'clean'), 'SKILL.md'), md('clean', 'Clean.'));
    writeFile(join(skillFolder(r.dataDir, 'inmain'), 'SKILL.md'), md('inmain', 'In main.', '', 'Do‮this'));
    writeFile(join(skillFolder(r.dataDir, 'inref'), 'SKILL.md'), md('inref', 'In a reference.'));
    writeFile(join(skillFolder(r.dataDir, 'inref'), 'refs', 'deep.md'), 'zero​width');
    writeFile(join(skillFolder(r.dataDir, 'bom'), 'SKILL.md'), '﻿' + md('bom', 'Leading BOM only.'));
    const g = await r.call('GET', '/api/armory');
    const flag = (id: string): unknown => g.skills.find((s: any) => s.id === id).hiddenText;
    assert.equal(flag('legion-armory:clean'), false);
    assert.equal(flag('legion-armory:inmain'), true);
    assert.equal(flag('legion-armory:inref'), true);
    assert.equal(flag('legion-armory:bom'), false);
    assert.ok(g.skills.filter((s: any) => s.source === 'claude-builtin').every((s: any) => s.hiddenText === false));
  });
});

describe("2. wording is scoped to Legion's own code", () => {
  it('the stripped-keys note and the rest of the Armory screen carry no absolute claim', () => {
    const dialogs = readFileSync(join(process.cwd(), 'ui', 'src', 'armory', 'ArmoryDialogs.tsx'), 'utf8');
    assert.match(dialogs, /Legion's own code removed these keys, so this skill does not get them\./);
    for (const file of [join('ui', 'src', 'armory', 'ArmoryDialogs.tsx'), join('ui', 'src', 'armory', 'ArmorySection.tsx'), join('src', 'shared', 'armory-view.ts')]) {
      const text = readFileSync(join(process.cwd(), file), 'utf8');
      assert.doesNotMatch(text, /cannot give itself|fully safe|completely safe|cannot be bypassed|can never/i, file);
    }
  });
});

describe('3. a session-missing retry runs the /command check on the request it re-sends', () => {
  it('Continue after the skill was switched off does not send the old /command to a new conversation', async () => {
    const rig = armoryRig({ inherit: false });
    await own(rig, { name: 'on-one', description: 'd', body: 'b' });
    let n = 0;
    // the first run ends at the turn limit with a session; the continue run finds the session gone
    const s = setup(() => (async function* () {
      n++;
      if (n === 1) { yield init('sess-gone'); yield err('error_max_turns'); return; }
      if (n === 2) { yield err('error_during_execution', ['No conversation found with session ID: sess-gone']); return; }
      yield init('sess-new'); yield ok('fresh', 'sess-new');
    })(), { modules: [rig.mod] });
    const t = s.engine.startTask({ agentId: 'alpha', prompt: '/legion-armory:on-one go', source: 'ui' });
    await s.engine.waitFor(t.id, 3000);
    await rig.call('POST', '/api/armory/state', { id: 'legion-armory:on-one', state: 'off' });
    s.engine.startTask({ agentId: 'alpha', prompt: CONTINUE_PROMPT, source: 'ui', continueTaskId: t.id });
    const done = await s.engine.waitFor(t.id, 3000);
    assert.equal(done.status, 'error');
    assert.match(done.error ?? '', /switched off in the Armory/);
    assert.equal(s.calls.length, 2, 'no third call: the old /command was not re-sent');
  });
});

describe('4. the delivery folder is versioned: a rebuild never deletes the path a run was given', () => {
  const root = (r: ReturnType<typeof armoryRig>): string => r.mod.claudeSkills!(alpha).plugins[0]!;
  const change = (r: ReturnType<typeof armoryRig>, body: string) => own(r, { name: 'mine', description: 'Mine.', body });
  const age = (folder: string, hours: number): void => { const d = new Date(Date.now() - hours * 3600_000); utimesSync(join(folder, '..'), d, d); };

  it('each content change gets a new folder; the previous one stays for an in-flight run; older ones are pruned', async () => {
    const r = armoryRig({ inherit: false });
    await change(r, 'one');
    const a = root(r);
    assert.match(a, /delivery-[0-9a-f]{12}/);
    assert.equal(root(r), a, 'the same content gives the same folder and no rebuild');
    age(a, 3);
    await change(r, 'two');
    const b = root(r);
    assert.notEqual(b, a);
    assert.ok(existsSync(join(a, 'skills', 'mine', 'SKILL.md')), 'the folder a run was given is still there after the rebuild');
    assert.match(readFileSync(join(a, 'skills', 'mine', 'SKILL.md'), 'utf8'), /one/);
    age(b, 1);
    await change(r, 'three');
    const c = root(r);
    assert.ok(existsSync(c) && existsSync(b), 'the newest two stay');
    assert.equal(existsSync(a), false, 'the third newest is pruned on the next rebuild');
    assert.equal(deliveryRoot(r.dataDir), c, 'deliveryRoot names the newest');
    assert.equal(readdirSync(join(r.dataDir, 'armory')).filter((x) => x.startsWith('delivery')).length, 2);
  });

  it('a prune that fails (EPERM) does not break the next run', async () => {
    const r = armoryRig({ inherit: false });
    const real = deliveryOps.rm;
    try {
      await change(r, 'one'); const a = root(r); age(a, 5);
      await change(r, 'two'); const b = root(r); age(b, 4);
      deliveryOps.rm = () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); };
      await change(r, 'three');
      const c = root(r);
      assert.match(readFileSync(join(c, 'skills', 'mine', 'SKILL.md'), 'utf8'), /three/, 'the new folder is complete');
      assert.ok(existsSync(a), 'the one that could not be removed is left for next time');
      deliveryOps.rm = real;
      await change(r, 'four');
      root(r);
      assert.equal(existsSync(a), false, 'and it is removed once it can be');
    } finally { deliveryOps.rm = real; }
  });

  it('a folder changed by hand under the same name is replaced, not trusted', async () => {
    const r = armoryRig({ inherit: false });
    await change(r, 'one');
    const a = root(r);
    writeFile(join(a, 'hooks', 'hooks.json'), '{}');
    assert.equal(root(r), a);
    assert.equal(existsSync(join(a, 'hooks')), false);
  });
});

describe('5. common Claude Code commands are not refused when the SDK listing failed; a file path is text', () => {
  const rig = armoryRig({ inherit: false });
  const refuse = (p: string) => refusedCommand(rig.mod.catalog(), alpha, p, CLI_COMMANDS);
  // 'doctor' is also a locked built-in skill, so the skill rule (off) wins over the command list; that is the existing, stricter rule.
  it('lets through the listed commands', () => {
    for (const c of ['config', 'mcp', 'agents', 'permissions', 'add-dir', 'hooks', 'help', 'clear', 'compact', 'cost', 'model', 'memory', 'status', 'init', 'review', 'login', 'logout', 'ide', 'terminal-setup', 'vim', 'bug', 'pr-comments', 'release-notes', 'resume', 'export', 'context']) {
      assert.equal(refuse(`/${c} x`), undefined, c);
    }
  });
  it('still refuses an unknown name, and treats a path-like first token as text', () => {
    assert.match(refuse('/totally-unknown x') ?? '', /not a command Legion knows/);
    assert.match(refuse('/configs x') ?? '', /not a command Legion knows/);
    for (const p of ['/foo.txt is broken', '/tmp', '/home look', '/Users', '/tmp/x.log', '/c/Users/a', '/etc.conf', `/C:${BACKSLASH}x`]) assert.equal(refuse(p), undefined, p);
  });
  it('a path-like word does not shadow a skill of that name', async () => {
    const r = armoryRig({ inherit: false });
    await own(r, { name: 'home', description: 'd', body: 'b' });
    await r.call('POST', '/api/armory/state', { id: 'legion-armory:home', state: 'off' });
    assert.match(refusedCommand(r.mod.catalog(), alpha, '/home go', CLI_COMMANDS) ?? '', /switched off/);
  });
});

describe('6. the Skill gate matches ids without regard to case, and still fails closed', () => {
  it('upper-case ids are denied like the lower-case ones; an on skill passes in any case; an unknown id is denied', async () => {
    const rig = armoryRig({ inherit: false });
    for (const n of ['on-one', 'manual-one', 'off-one']) await own(rig, { name: n, description: 'd', body: 'b' });
    await rig.call('POST', '/api/armory/state', { id: 'legion-armory:manual-one', state: 'manual' });
    await rig.call('POST', '/api/armory/state', { id: 'legion-armory:off-one', state: 'off' });
    const gate = (id: string) => rig.mod.skillGate!(alpha, id);
    assert.match(gate('LEGION-ARMORY:OFF-ONE') ?? '', /off in Legion/);
    assert.match(gate('Legion-Armory:Manual-One') ?? '', /Only when I ask/);
    assert.equal(gate('Legion-Armory:On-One'), undefined);
    assert.equal(gate('legion-armory:on-one'), undefined);
    assert.match(gate('definitely-not-there') ?? '', /off in Legion/);
    assert.match(gate('Update-Config') ?? '', /off in Legion/, 'a locked built-in in any case');
  });
});
