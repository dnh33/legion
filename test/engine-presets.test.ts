// test/engine-presets.test.ts: the engine honors the presets (Accept edits, Smart, Bypass), the gates it owns, and the fifth internal mode
// (rig: test/gates-rig.ts over test/away-rig.ts, the way test/engine-mode-resolver.test.ts drives the engine)
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { gatesRig } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import type { GateRule } from '../src/shared/types.js';

const WIN = process.platform === 'win32';
const OUTSIDE = WIN ? 'C:/Windows/evil.txt' : '/etc/evil.txt';
const rule = (id: string, then: GateRule['then'], when: GateRule['when']): GateRule => ({ id, enabled: true, then, when, label: id, source: 'user' });
const inside = (r: GatesRig, name = 'notes.txt') => `${r.projectDir().replace(/\\/g, '/')}/${name}`;
const using = async (o: Parameters<typeof gatesRig>[0], body: (r: GatesRig) => Promise<void>) => {
  const r = await gatesRig(o);
  try { await body(r); } finally { r.stop(); }
};

test('Accept edits project: Write inside the project runs, Bash cards, a Gates ask rule cards', async () => {
  await using({ preset: 'accept-edits', follow: true }, async (r) => {
    const w = await r.run('Write', { file_path: inside(r), content: 'x' });
    assert.deepEqual([w.card, w.allow], [false, true], 'a Write inside the project runs');
    const b = await r.run('Bash', { command: 'echo hi' });
    assert.equal(b.card, true, 'Bash cards');
    r.setRules([rule('gr_ask', 'ask', { tools: ['Write'] })]);
    const w2 = await r.run('Write', { file_path: inside(r), content: 'x' });
    assert.equal(w2.card, true, 'an ask rule cards even a Write Accept edits would run');
  });
});

test('Smart project: git status runs, git push cards, an unclassified MCP tool cards, a Gates allow rule is ignored on a capped run', async () => {
  const allowPush = rule('gr_allow', 'allow', { tools: ['Bash'], commands: ['git push*'] });
  await using({ preset: 'smart', follow: true }, async (r) => {
    assert.equal((await r.run('Bash', { command: 'git status' })).card, false, 'git status runs');
    assert.equal((await r.run('Bash', { command: 'git push origin main' })).card, true, 'git push cards');
    assert.equal((await r.run('mcp__acme__do_thing', { x: 1 })).card, true, 'an MCP tool Legion cannot classify cards');
    r.setRules([allowPush]);
    assert.equal((await r.run('Bash', { command: 'git push origin main' })).card, false, 'an allow rule is honored on an uncapped run');
  });
  await using({ preset: 'smart', follow: true, ceiling: 'ask' }, async (r) => {
    r.setRules([allowPush]);
    assert.equal((await r.run('Bash', { command: 'git push origin main' })).card, true, 'the same allow rule is ignored on a capped run');
  });
});

test('Bypass project: no card for Bash or Write; a Gates deny rule still denies; the web-egress card still shows after connector data', async () => {
  await using({ preset: 'bypass', follow: true }, async (r) => {
    assert.equal((await r.run('Bash', { command: 'echo hi' })).card, false);
    assert.equal((await r.run('Write', { file_path: inside(r), content: 'x' })).card, false);
    r.setRules([rule('gr_deny', 'deny', { tools: ['Edit'] })]);
    const d = await r.run('Edit', { file_path: inside(r), old_string: 'a', new_string: 'b' });
    assert.equal(d.allow, false, 'a deny rule survives Bypass');
    assert.match(d.message ?? '', /gate rule/i);
    // the run read connector data and outside text: web access asks, in Bypass too (the Claude path raises it from a PreToolUse hook)
    r.store.tasks.get(r.task.id)!.usedConnectors = true;
    (r.config as { taint?: unknown }).taint = { shell: 'strict', outsideFiles: true, noticeSeen: true };
    (r.engine as unknown as { active: Map<string, { tainted: boolean }> }).active.get(r.task.id)!.tainted = true;
    const web = await r.hook('WebFetch', { url: 'https://example.com/' });
    assert.equal(web.card, true, 'the web-egress card still shows');
    assert.equal(web.decision, 'deny', 'and a "no" stops the call');
  });
});

test('Bypass: the SDK starts in bypassPermissions; demoting to Ask mid-run makes the next call card', async () => {
  await using({ preset: 'bypass', follow: true }, async (r) => {
    assert.equal(r.calls[0]!.options.permissionMode, 'bypassPermissions');
    const before = await r.hook('Bash', { command: 'echo 1' });
    assert.deepEqual([before.card, before.decision], [false, undefined], 'in Bypass the call goes through with no card');
    r.core.store.patchProject(r.project.id, { preset: 'ask' });
    const after = await r.hook('Bash', { command: 'echo 2' });
    assert.equal(after.card, true, 'the next call cards');
    assert.equal(after.decision, 'deny', 'and the "no" is final');
  });
});

test('an agent set to Ask explicitly in a Bypass project stays Ask (follow vs own)', async () => {
  await using({ preset: 'bypass', own: 'ask', follow: false }, async (r) => {
    assert.equal(r.calls[0]!.options.permissionMode, 'default', 'the run does not start in bypass');
    assert.equal((await r.run('Bash', { command: 'echo hi' })).card, true, 'its own Ask holds');
  });
  await using({ preset: 'bypass', own: 'ask', follow: true }, async (r) => {
    assert.equal((await r.run('Bash', { command: 'echo hi' })).card, false, 'an agent that follows the project runs');
  });
});

test('tool-cards override off in an Ask project: no tool cards, deny rules and the floor still apply', async () => {
  await using({ preset: 'ask', overrides: { 'tool-cards': false } }, async (r) => {
    assert.equal((await r.run('Bash', { command: 'echo hi' })).card, false, 'no card for a command');
    assert.equal((await r.run('Write', { file_path: OUTSIDE, content: 'x' })).card, false, 'no card for a write');
    r.setRules([rule('gr_deny', 'deny', { tools: ['Edit'] })]);
    assert.equal((await r.run('Edit', { file_path: inside(r), old_string: 'a', new_string: 'b' })).allow, false, 'a deny rule still denies');
    const wipe = await r.run('Bash', { command: 'rm -rf /' });
    assert.deepEqual([wipe.card, wipe.allow], [false, false], 'the floor still refuses a catastrophic command');
    assert.equal((await r.run('Bash', { command: '$(echo rm) -rf x' })).card, true, 'and still asks about a command nobody can read');
  });
});

test('tool-cards off does not lift a ceiling from an outside app or another bot', async () => {
  await using({ preset: 'ask', overrides: { 'tool-cards': false }, ceiling: 'ask' }, async (r) => {
    assert.equal((await r.run('Bash', { command: 'echo hi' })).card, true);
  });
});

test('gate-rules-ask off: an ask rule is skipped, a deny rule still denies', async () => {
  await using({ preset: 'accept-edits', follow: true, overrides: { 'gate-rules-ask': false } }, async (r) => {
    r.setRules([rule('gr_ask', 'ask', { tools: ['Write'] }), rule('gr_deny', 'deny', { tools: ['Edit'] })]);
    const w = await r.run('Write', { file_path: inside(r), content: 'x' });
    assert.deepEqual([w.card, w.allow], [false, true], 'the ask rule is skipped, so Accept edits runs the Write');
    const e = await r.run('Edit', { file_path: inside(r), old_string: 'a', new_string: 'b' });
    assert.equal(e.allow, false, 'the deny rule still denies');
  });
});

test('the tool-cards decision in Smart uses the project folder: a Write outside it cards', async () => {
  await using({ preset: 'smart', follow: true }, async (r) => {
    assert.equal((await r.run('Write', { file_path: inside(r, 'sub/a.md'), content: 'x' })).card, false, 'inside the project folder');
    assert.equal((await r.run('Write', { file_path: OUTSIDE, content: 'x' })).card, true, 'outside the project folder');
  });
});

// The fifth internal mode: a run held by Smart and by Accept edits (an Accept-edits agent in a Smart-limited project) cards whatever EITHER would card.
test('Accept-edits agent in a Smart-limited project: an edit inside runs, an edit outside cards, every shell call cards, a guard cards', async () => {
  await using({ preset: 'smart', own: 'auto-edits', follow: false }, async (r) => {
    assert.equal(r.core.resolver.mode({ agentMode: 'auto-edits', startProjectId: r.project.id }), 'smart-edits');
    assert.equal((await r.run('Write', { file_path: inside(r), content: 'x' })).card, false, 'Smart runs it and so does Accept edits');
    assert.equal((await r.run('Write', { file_path: OUTSIDE, content: 'x' })).card, true, 'Smart would card it');
    assert.equal((await r.run('Bash', { command: 'git status' })).card, true, 'Accept edits would card it');
    assert.equal((await r.run('Bash', { command: 'git push origin main' })).card, true, 'both would card it');
    assert.equal((await r.run('mcp__acme__do_thing', {})).card, true, 'an unclassified tool cards');
  });
});

test('a gates file edited to Bypass outside Legion does not apply: the next call still cards', async () => {
  await using({ follow: true }, async (r) => {
    r.core.store.patchApp({ preset: 'accept-edits' }); // a signed file exists
    await r.core.store.flush();
    writeFileSync(join(r.core.store.folder, 'app.json'), JSON.stringify({ version: 1, preset: 'bypass' }));
    r.core.store.reload();
    assert.equal(r.core.resolver.mode({ agentMode: 'ask', source: 'project', startProjectId: r.project.id }), 'ask', 'the unsigned edit is not applied');
    assert.equal((await r.run('Bash', { command: 'echo hi' })).card, true);
  });
});

test('tool-cards off by the owner never skips the owner\'s ask rules', async () => {
  await using({ preset: 'ask', overrides: { 'tool-cards': false } }, async (r) => {
    r.setRules([rule('gr_ask_read', 'ask', { tools: ['Read'] }), rule('gr_ask_bash', 'ask', { tools: ['Bash'] })]);
    assert.equal((await r.run('Read', { file_path: inside(r) })).card, true, 'an ask rule on Read still cards');
    assert.equal((await r.run('Bash', { command: 'echo hi' })).card, true, 'an ask rule on Bash still cards');
    assert.equal((await r.run('Glob', { pattern: '*' })).card, false, 'a call with no ask rule runs: the cards are off');
  });
});

test('a Bypass preset alone keeps the ask rules of an agent that keeps its own Ask; only an explicit override turns them off', async () => {
  await using({ preset: 'bypass', own: 'ask', follow: false }, async (r) => {
    r.setRules([rule('gr_ask', 'ask', { tools: ['Read'] })]);
    assert.equal((await r.run('Read', { file_path: inside(r) })).card, true, 'its own Ask keeps its ask rule');
  });
  await using({ preset: 'bypass', own: 'auto-edits', follow: false }, async (r) => {
    r.setRules([rule('gr_ask', 'ask', { tools: ['Write'] })]);
    assert.equal((await r.run('Write', { file_path: inside(r), content: 'x' })).card, true, 'its own Accept edits keeps its ask rule');
  });
  await using({ preset: 'ask', own: 'ask', follow: false, overrides: { 'gate-rules-ask': false } }, async (r) => {
    r.setRules([rule('gr_ask', 'ask', { tools: ['Read'] })]);
    assert.equal((await r.run('Read', { file_path: inside(r) })).card, false, 'an explicit override turns the ask rule off');
  });
});

test('gate-rules-ask off does not skip an ask rule on a run that carries an outside ceiling', async () => {
  await using({ preset: 'ask', overrides: { 'gate-rules-ask': false }, ceiling: 'ask' }, async (r) => {
    r.setRules([rule('gr_ask', 'ask', { tools: ['Read'] })]);
    assert.equal((await r.run('Read', { file_path: inside(r) })).card, true);
  });
});

test('tool-cards off: a run another agent started at full approval is not limited (no card), a run limited to Ask still is, and Strict keeps the old rule', async () => {
  await using({ preset: 'ask', overrides: { 'tool-cards': false }, ceiling: 'full' }, async (r) => {
    assert.equal((await r.run('Bash', { command: 'echo hi' })).card, false, 'default mode: a full-approval chain runs like the owner\'s own run');
  });
  await using({ preset: 'ask', overrides: { 'tool-cards': false }, ceiling: 'full' }, async (r) => {
    (r.config as { taint?: unknown }).taint = { shell: 'strict', outsideFiles: true, noticeSeen: true };
    assert.equal((await r.run('Bash', { command: 'echo hi' })).card, true, 'Strict: any started-by-another run keeps its cards (0.3.9)');
  });
});

test('gate-rules-ask off: an ask rule is skipped for a full-approval chain, but not for one limited to Ask', async () => {
  for (const [ceiling, wantCard] of [['full', false], ['ask', true]] as const) {
    await using({ preset: 'accept-edits', follow: true, overrides: { 'gate-rules-ask': false }, ceiling }, async (r) => {
      r.setRules([rule('gr_ask', 'ask', { tools: ['Write'] })]);
      assert.equal((await r.run('Write', { file_path: inside(r), content: 'x' })).card, wantCard, `ceiling ${ceiling}`);
    });
  }
});
