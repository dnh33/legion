/**
 * The Armory store and its admin routes: defaults, the one-time notice migration, discovery of Claude Code skills, import hardening and
 * the admin gate. Engine behaviour is in armory-engine.test.ts, taint in armory-taint.test.ts.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gate, isClientRoute } from '../src/core/admin.js';
import { armoryFilePath, readArmoryFile, skillFolder } from '../src/core/armory/store.js';
import { hasShellPreprocessing, stripFrontmatterKeys } from '../src/core/armory/files.js';
import { armoryRig, fakeClaude, md } from './armory-rig.js';
import type { CcFixture } from './armory-rig.js';

const CC: CcFixture = {
  personal: { 'my-skill': md('my-skill', 'Mine from Claude Code.') },
  plugins: [
    { key: 'superpowers@official', name: 'superpowers', skills: { brainstorming: md('brainstorming', 'Plan first.') } },
    { key: 'superpowers@other', name: 'superpowers', skills: { brainstorming: md('brainstorming', 'Dupe.'), tdd: md('tdd', 'Tests first.') } },
    { key: 'off-plugin@official', skills: { hidden: md('hidden', 'Disabled in settings.') } },
    { key: 'proj-plugin@official', scope: 'project', skills: { local: md('local', 'Project scoped.') } },
    { key: 'cmds@official', commands: { ship: md('ship', 'A command.') } },
  ],
  enabled: { 'off-plugin@official': false },
};

describe('armory store: defaults and the one-time notice', () => {
  it('writes armory.json on the first run with ccNoticeSeen false and the migration recorded', async () => {
    const r = armoryRig();
    const out = await r.call('GET', '/api/armory');
    assert.equal(out.ccNoticeSeen, false);
    const disk = JSON.parse(readFileSync(armoryFilePath(r.dataDir), 'utf8'));
    assert.deepEqual(disk.migrations, ['cc-notice-v1']);
    assert.deepEqual(disk.skills, {}, 'defaults are computed, never written');
  });

  it('never re-runs and never overrides a later choice', async () => {
    const r = armoryRig();
    await r.call('GET', '/api/armory');
    await r.call('POST', '/api/armory/notice-seen', {});
    // a fresh read of the same data dir (a restart)
    assert.equal(readArmoryFile(r.dataDir).ccNoticeSeen, true);
    assert.equal((await r.call('GET', '/api/armory')).ccNoticeSeen, true);
  });

  it('an unreadable armory.json is defaults in memory, is left alone and does not re-show the notice', async () => {
    const r = armoryRig();
    await r.call('GET', '/api/armory');
    writeFileSync(armoryFilePath(r.dataDir), '{not json', 'utf8');
    const out = await r.call('GET', '/api/armory');
    assert.equal(out.ccNoticeSeen, true);
    assert.equal(readFileSync(armoryFilePath(r.dataDir), 'utf8'), '{not json');
  });

  it('every Claude Code skill (personal, plugin, built-in) is off by default, whoever wrote it (yours and imported too)', async () => {
    const r = armoryRig({ cc: CC });
    await r.call('POST', '/api/armory/skill', { name: 'mine', description: 'Mine.', body: 'Steps.' });
    await r.call('POST', '/api/armory/import', { files: [{ path: 'imp/SKILL.md', text: md('imp', 'Imported.') }] });
    const { skills } = await r.call('GET', '/api/armory');
    const by = (src: string) => skills.filter((s: any) => s.source === src);
    for (const src of ['claude-personal', 'claude-plugin', 'claude-builtin']) {
      assert.ok(by(src).length > 0, src);
      assert.ok(by(src).every((s: any) => s.state === 'off' && s.stateIsDefault), `${src} starts off`);
    }
    const mine = skills.find((s: any) => s.id === 'legion-armory:mine');
    assert.equal(mine.state, 'off', 'a skill you write starts off like every other');
    assert.equal(skills.find((s: any) => s.id === 'legion-armory:imp').state, 'off');
  });

  it('a state choice sticks, is reported as not the default, and survives a re-read', async () => {
    const r = armoryRig({ cc: CC });
    const out = await r.call('POST', '/api/armory/state', { id: 'my-skill', state: 'on' });
    assert.equal(out.state, 'on');
    assert.equal(out.stateIsDefault, false);
    const again = (await r.call('GET', '/api/armory')).skills.find((s: any) => s.id === 'my-skill');
    assert.equal(again.state, 'on');
    await assert.rejects(() => r.call('POST', '/api/armory/state', { id: 'my-skill', state: 'maybe' }), /state must be one of/);
    await assert.rejects(() => r.call('POST', '/api/armory/state', { id: 'ghost', state: 'on' }), /No skill with the id/);
  });

  it('built-ins that act on Claude Code itself stay off, with a reason, even if the file says on', async () => {
    const r = armoryRig();
    const { skills } = await r.call('GET', '/api/armory');
    const upd = skills.find((s: any) => s.id === 'update-config');
    assert.ok(upd.offReason);
    assert.equal(upd.fit, 'self');
    assert.equal(skills.find((s: any) => s.id === 'deep-research').fit, 'fit');
    await assert.rejects(() => r.call('POST', '/api/armory/state', { id: 'update-config', state: 'on' }), /acts on Claude Code itself/);
    const f = readArmoryFile(r.dataDir);
    f.skills['update-config'] = { state: 'on', source: 'claude-builtin' };
    writeFileSync(armoryFilePath(r.dataDir), JSON.stringify(f));
    const forged = r.mod.claudeSkills!({ id: 'alpha' } as any);
    assert.ok(!forged.skills.includes('update-config'), 'a forged record does not put it on the list');
  });
});

describe('armory discovery of Claude Code skills', () => {
  it('lists personal, plugin skills and plugin commands, grouped by plugin, honouring enabledPlugins, scope and duplicates', async () => {
    const r = armoryRig({ cc: CC });
    const { skills, counts } = await r.call('GET', '/api/armory');
    const ids = skills.map((s: any) => s.id);
    assert.ok(ids.includes('my-skill'));
    assert.ok(ids.includes('superpowers:brainstorming'));
    assert.ok(ids.includes('superpowers:tdd'));
    assert.ok(ids.includes('cmds:ship'), 'plugin commands are /commands too');
    assert.ok(!ids.includes('off-plugin:hidden') && !ids.includes('hidden'), 'enabledPlugins false');
    assert.ok(!ids.includes('proj-plugin:local'), 'project-scope installs are not global');
    assert.equal(ids.filter((i: string) => i === 'superpowers:brainstorming').length, 1, 'duplicate ids collapse');
    assert.equal(counts.byPlugin.superpowers, 2);
    assert.equal(skills.find((s: any) => s.id === 'superpowers:tdd').plugin, 'superpowers');
  });

  it('honours claude.inheritClaudeCodeSettings: off hides personal and plugin skills, built-ins stay', async () => {
    const r = armoryRig({ cc: CC, inherit: false });
    const { skills, inherit } = await r.call('GET', '/api/armory');
    assert.equal(inherit, false);
    assert.ok(!skills.some((s: any) => s.source === 'claude-personal' || s.source === 'claude-plugin'));
    assert.ok(skills.some((s: any) => s.source === 'claude-builtin'));
  });

  it('reports the manual-only flag from the skill\'s own frontmatter', async () => {
    const r = armoryRig({ cc: { personal: { quiet: md('quiet', 'Only on request.', 'disable-model-invocation: true\n') } } });
    const e = (await r.call('GET', '/api/armory')).skills.find((s: any) => s.id === 'quiet');
    assert.equal(e.manualOnlyInFrontmatter, true);
  });

  it('a missing Claude home is an empty list, not an error', async () => {
    const r = armoryRig();
    fakeClaude(r.home, {});
    assert.ok((await r.call('GET', '/api/armory')).skills.length > 0);
  });
});

describe('armory routes: your own skills', () => {
  it('creates a valid SKILL.md, on by default, and updates it in place', async () => {
    const r = armoryRig();
    const out = await r.call('POST', '/api/armory/skill', { name: 'plan-first', description: 'Plan before   coding.', whenToUse: 'a big change', body: '# Steps\n1. Plan.' });
    assert.equal(out.id, 'legion-armory:plan-first');
    assert.equal(out.created, true);
    assert.equal(out.state, 'off');
    assert.equal(out.source, 'yours');
    const text = readFileSync(join(skillFolder(r.dataDir, 'plan-first'), 'SKILL.md'), 'utf8');
    assert.match(text, /^---\nname: plan-first\ndescription: >-\n {2}Plan before coding\. Use when: a big change\n---\n/);
    const up = await r.call('POST', '/api/armory/skill', { name: 'plan-first', description: 'Changed.', body: 'New.' });
    assert.equal(up.created, false);
    assert.equal(up.description, 'Changed.');
  });

  it('refuses a bad name, an empty description or body, and oversized input', async () => {
    const r = armoryRig();
    for (const name of ['', 'Has Caps', '../x', 'a/b', 'x'.repeat(65), '-lead.']) {
      await assert.rejects(() => r.call('POST', '/api/armory/skill', { name, description: 'd', body: 'b' }), /name must be/, name);
    }
    await assert.rejects(() => r.call('POST', '/api/armory/skill', { name: 'a', description: '', body: 'b' }), /description is required/);
    await assert.rejects(() => r.call('POST', '/api/armory/skill', { name: 'a', description: 'd', body: '  ' }), /body is required/);
    await assert.rejects(() => r.call('POST', '/api/armory/skill', { name: 'a', description: 'd'.repeat(501), body: 'b' }), /description is over/);
    await assert.rejects(() => r.call('POST', '/api/armory/skill', { name: 'a', description: 'd', body: 'b'.repeat(200_001) }), /body is over/);
  });

  it('will not overwrite an imported skill through the create route', async () => {
    const r = armoryRig();
    await r.call('POST', '/api/armory/import', { files: [{ path: 'SKILL.md', text: md('theirs', 'Imported.') }] });
    await assert.rejects(() => r.call('POST', '/api/armory/skill', { name: 'theirs', description: 'd', body: 'b' }), /already in the Armory/);
  });

  it('removes yours and imported skills only, and returns the text so the screen can offer Undo', async () => {
    const r = armoryRig({ cc: CC });
    await r.call('POST', '/api/armory/skill', { name: 'gone', description: 'd', body: 'body text' });
    const out = await r.call('DELETE', '/api/armory/skill?id=legion-armory:gone');
    assert.equal(out.ok, true);
    assert.match(out.text, /body text/);
    assert.ok(!existsSync(skillFolder(r.dataDir, 'gone')));
    assert.ok(!('legion-armory:gone' in readArmoryFile(r.dataDir).skills));
    await assert.rejects(() => r.call('DELETE', '/api/armory/skill?id=my-skill'), /Only skills in the Armory/);
    await assert.rejects(() => r.call('DELETE', '/api/armory/skill?id=debug'), /Only skills in the Armory/);
    await assert.rejects(() => r.call('DELETE', '/api/armory/skill?id=nope'), /No skill with the id/);
  });

  it('reads a skill file for the Read dialog by id only, and says a built-in has none', async () => {
    const r = armoryRig({ cc: CC });
    const out = await r.call('GET', '/api/armory/file?id=my-skill');
    assert.match(out.text, /Mine from Claude Code/);
    assert.equal(out.thirdParty, false);
    assert.equal((await r.call('GET', '/api/armory/file?id=superpowers:tdd')).thirdParty, true);
    await assert.rejects(() => r.call('GET', '/api/armory/file?id=debug'), /built in to Claude Code/);
    await assert.rejects(() => r.call('GET', `/api/armory/file?id=${encodeURIComponent('../../etc/passwd')}`), /No skill with the id/);
  });

  it('sets which agents a skill reaches', async () => {
    const r = armoryRig();
    await r.call('POST', '/api/armory/skill', { name: 's', description: 'd', body: 'b' });
    const out = await r.call('POST', '/api/armory/agents', { id: 'legion-armory:s', agents: ['alpha'] });
    assert.deepEqual(out.agents, ['alpha']);
    assert.equal(out.state, 'off');
    assert.equal((await r.call('POST', '/api/armory/agents', { id: 'legion-armory:s', agents: 'all' })).agents, 'all');
    await assert.rejects(() => r.call('POST', '/api/armory/agents', { id: 'legion-armory:s', agents: 'some' }), /agents must be/);
    await assert.rejects(() => r.call('POST', '/api/armory/agents', { id: 'legion-armory:s', agents: [1] }), /agents must be/);
  });
});

describe('armory import hardening', () => {
  const imp = (r: ReturnType<typeof armoryRig>, files: Array<{ path: string; text: string }>) => r.call('POST', '/api/armory/import', { files });

  it('strips allowed-tools (one line and list form), hooks and the other keys that act without a card, and reports them', async () => {
    const r = armoryRig();
    const text = '---\nname: risky\ndescription: Does things.\nallowed-tools: Bash(git *)\ndisallowed-tools:\n  - Read\n  - Write\nhooks:\n  - on: file-edit\n    run: x\ncontext: fork\nagent: Explore\nshell: powershell\nbackground: true\ndisable-model-invocation: true\n---\n\nBody.\n';
    const out = await imp(r, [{ path: 'risky/SKILL.md', text }]);
    assert.deepEqual([...out.stripped].sort(), ['agent', 'allowed-tools', 'background', 'context', 'disallowed-tools', 'hooks', 'shell']);
    const disk = readFileSync(join(skillFolder(r.dataDir, 'risky'), 'SKILL.md'), 'utf8');
    assert.ok(!/allowed-tools|hooks|context:|Bash\(git|file-edit|shell:|agent:/.test(disk), disk);
    assert.match(disk, /disable-model-invocation: true/);
    assert.match(disk, /Body\./);
  });

  it('lands off, as imported, and drops every non-.md file with a reason', async () => {
    const r = armoryRig();
    const out = await imp(r, [
      { path: 'pdf/SKILL.md', text: md('pdf', 'Make PDFs.') },
      { path: 'pdf/reference.md', text: '# ref' },
      { path: 'pdf/scripts/run.py', text: 'print(1)' },
      { path: 'pdf/run.sh', text: 'echo' },
      { path: 'other/readme.md', text: 'outside' },
    ]);
    assert.equal(out.state, 'off');
    assert.equal(out.source, 'imported');
    assert.deepEqual(out.kept, ['SKILL.md', 'reference.md']);
    assert.deepEqual(out.dropped.map((d: any) => d.path).sort(), ['other/readme.md', 'pdf/run.sh', 'pdf/scripts/run.py']);
    assert.ok(!existsSync(join(skillFolder(r.dataDir, 'pdf'), 'scripts')));
    assert.equal(readArmoryFile(r.dataDir).skills['legion-armory:pdf'].source, 'imported');
  });

  it('refuses path traversal, absolute paths, drive letters and streams, and writes nothing', async () => {
    const r = armoryRig();
    for (const bad of ['../evil.md', 'a/../../evil.md', '/abs/SKILL.md', 'C:\\x\\SKILL.md', 'a/b:stream.md', '']) {
      await assert.rejects(() => imp(r, [{ path: 'SKILL.md', text: md('ok', 'd') }, { path: bad, text: 'x' }]), /plain relative path/, JSON.stringify(bad));
    }
    assert.ok(!existsSync(skillFolder(r.dataDir, 'ok')));
  });

  it('needs exactly one SKILL.md', async () => {
    const r = armoryRig();
    await assert.rejects(() => imp(r, [{ path: 'a.md', text: 'x' }]), /no SKILL\.md/);
    await assert.rejects(() => imp(r, [{ path: 'a/SKILL.md', text: md('a', 'd') }, { path: 'b/SKILL.md', text: md('b', 'd') }]), /More than one SKILL\.md/);
  });

  it('enforces the caps: 200 files and 1 MB in total', async () => {
    const r = armoryRig();
    const many = Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.md`, text: 'x' }));
    await assert.rejects(() => imp(r, many), /limit is 200/);
    await assert.rejects(() => imp(r, [{ path: 'SKILL.md', text: md('big', 'd') }, { path: 'a.md', text: 'x'.repeat(600_000) }, { path: 'b.md', text: 'x'.repeat(600_000) }]), /over 1000000 bytes/);
  });

  it('refuses a body that runs shell commands while it loads, and a SKILL.md with no description', async () => {
    const r = armoryRig();
    await assert.rejects(() => imp(r, [{ path: 'SKILL.md', text: md('sh', 'd', '', 'Diff: !`git diff`') }]), /runs shell commands/);
    await assert.rejects(() => imp(r, [{ path: 'SKILL.md', text: md('sh', 'd', '', '```!\nls\n```') }]), /runs shell commands/);
    await assert.rejects(() => imp(r, [{ path: 'SKILL.md', text: '---\nname: x\n---\nbody' }]), /needs a description/);
    await assert.rejects(() => imp(r, [{ path: 'SKILL.md', text: 'no frontmatter' }]), /needs a description/);
    assert.ok(!existsSync(skillFolder(r.dataDir, 'sh')));
  });

  it('keeps the folder name as the id when the frontmatter name is odd, and refuses a duplicate', async () => {
    const r = armoryRig();
    const out = await imp(r, [{ path: 'My Skill/SKILL.md', text: md('My Skill!', 'd') }]);
    assert.equal(out.id, 'legion-armory:my-skill');
    assert.match(readFileSync(join(skillFolder(r.dataDir, 'my-skill'), 'SKILL.md'), 'utf8'), /^---\nname: my-skill\n/);
    await assert.rejects(() => imp(r, [{ path: 'my-skill/SKILL.md', text: md('my-skill', 'd') }]), /already in the Armory/);
  });

  it('helpers: the stripper keeps unrelated keys, the detector finds both shell forms', () => {
    assert.equal(stripFrontmatterKeys('---\nname: a\nmodel: x\n---\nb', ['hooks']).text, '---\nname: a\nmodel: x\n---\nb');
    assert.equal(hasShellPreprocessing('Run `ls` now'), false);
    assert.equal(hasShellPreprocessing('see !`ls`'), true);
    assert.equal(hasShellPreprocessing('x\n  ```!\nls\n```'), true);
  });
});

describe('armory routes are admin-only', () => {
  it('every route is refused to the MCP bearer token and is not on the client list', async () => {
    const r = armoryRig();
    assert.ok(r.paths.length >= 9, `registered ${r.paths.join(', ')}`);
    for (const key of r.paths) {
      const [method, path] = key.split(' ');
      assert.equal(isClientRoute(method, path), false, key);
      const d = gate({ method, path, adminOk: false, bearerOk: true, hasSecret: true });
      assert.equal(d.allow, false, key);
      assert.equal((d as { status: number }).status, 403, key);
      assert.equal(gate({ method, path, adminOk: true, bearerOk: false, hasSecret: true }).allow, true, key);
    }
  });
});

describe('armory effective list', () => {
  it('counts drills, Armory and Claude Code skills for one agent, and 404s an unknown agent', async () => {
    const r = armoryRig({ cc: CC });
    await r.call('POST', '/api/armory/skill', { name: 'mine', description: 'd', body: 'b' });
    await r.call('POST', '/api/armory/state', { id: 'legion-armory:mine', state: 'on' });
    await r.call('POST', '/api/armory/state', { id: 'my-skill', state: 'on' });
    await r.call('POST', '/api/armory/state', { id: 'deep-research', state: 'on' });
    const e = await r.call('GET', '/api/armory/effective?agent=alpha');
    assert.deepEqual(e.counts, { drills: 0, armory: 1, claudeCode: 2, total: 3 });
    assert.equal(e.setting, 'inherit');
    assert.equal(e.overBudget, false);
    assert.equal(e.warnAbove, 40);
    await assert.rejects(() => r.call('GET', '/api/armory/effective?agent=ghost'), /Unknown agent/);
  });

  it('effective-all answers the counts of every agent in one call, the same numbers as the per-agent route', async () => {
    const r = armoryRig({ cc: CC });
    await r.call('POST', '/api/armory/state', { id: 'my-skill', state: 'on' });
    const all = await r.call('GET', '/api/armory/effective-all');
    assert.ok(all.agents.length >= 1);
    for (const a of all.agents) {
      const one = await r.call('GET', `/api/armory/effective?agent=${a.agent}`);
      assert.deepEqual(a.counts, one.counts);
      assert.equal(a.overBudget, one.overBudget);
      assert.ok(!('claudeCode' in a), 'counts only, no descriptions');
    }
  });
});
