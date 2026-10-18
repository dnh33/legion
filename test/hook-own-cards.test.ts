// test/hook-own-cards.test.ts: Legion's own cards fire from the ask-mode PreToolUse hook (security finding A-H1, owner ruling 2026-10-18).
// Claude Code's allow rules (and the SDK's own approvals of read-only commands and in-folder reads) are asked before canUseTool and can skip it
// (code.claude.com/docs/en/agent-sdk/permissions, "How permissions are evaluated"). The owner's own allow rules may skip the PLAIN preset card;
// the outside-run ceiling, a gate ask rule, the web-egress card after connector data and Smart's changed-build-file card may not. Hooks run in
// parallel (code.claude.com/docs/en/hooks), so every case counts approval events with all matching hooks started together: one card per call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gatesRig } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import type { GateRule } from '../src/shared/types.js';

const rule = (id: string, then: GateRule['then'], when: GateRule['when']): GateRule => ({ id, enabled: true, then, when, label: id, source: 'user' });
const using = async (o: Parameters<typeof gatesRig>[0], body: (r: GatesRig) => Promise<void>) => {
  const r = await gatesRig(o);
  try { await body(r); } finally { r.stop(); }
};
const BUILD_WHY = /a build or script file here changed since you last allowed one/;

test('(a) a run capped by an outside app: the hook raises the card for Bash echo hi, one approval event, and canUseTool does not ask again', async () => {
  await using({ ceiling: 'ask', originAtStart: true }, async (r) => {
    const no = await r.hookAll('Bash', { command: 'echo hi' });
    assert.deepEqual([no.cards, no.decision], [1, 'deny'], 'the ceiling cards from the hook; the "no" is final');
    const yes = await r.hookAll('Bash', { command: 'echo hi' }, { allow: true });
    assert.deepEqual([yes.cards, yes.decision], [1, 'allow']);
    // Claude Code may still ask canUseTool after a hook allow (an ask rule): it keeps the hook's answer, with no second card
    const after = await r.canUse('Bash', { command: 'echo hi' }, yes.id);
    assert.deepEqual([after.cards, after.behavior], [0, 'allow']);
  });
});

test('(a) a capped run with a command the floor cards: still one approval event (the shell hook decides a shell call alone)', async () => {
  await using({ ceiling: 'ask', originAtStart: true }, async (r) => {
    const h = await r.hookAll('Bash', { command: 'x=ls; $x' });
    assert.deepEqual([h.cards, h.decision], [1, 'deny']);
    assert.match(h.summaries[0] ?? '', /cannot read what this command will run/, 'the floor card, not a second ceiling card');
  });
});

test('(b) a gate ask rule on Bash(echo *): the hook raises the card, one approval event', async () => {
  await using({}, async (r) => {
    r.setRules([rule('gr_ask', 'ask', { tools: ['Bash'], commands: ['echo *'] })]);
    const h = await r.hookAll('Bash', { command: 'echo hi' });
    assert.deepEqual([h.cards, h.decision], [1, 'deny']);
    const after = await r.canUse('Bash', { command: 'echo hi' }, h.id);
    assert.equal(after.cards, 0, 'canUseTool keeps the hook\'s answer');
  });
});

test('(b) "Your ask rules" switched off: the gate ask rule is skipped on the hook too, and Ask leaves the plain card to canUseTool', async () => {
  await using({ overrides: { 'gate-rules-ask': false } }, async (r) => {
    r.setRules([rule('gr_ask', 'ask', { tools: ['Bash'], commands: ['echo *'] })]);
    const h = await r.hookAll('Bash', { command: 'echo hi' });
    assert.deepEqual([h.cards, h.decision], [0, undefined]);
  });
});

test('(c) a run that read connector data: WebFetch of a built-in docs site raises the egress card from the hook, with no guard card before it', async () => {
  await using({}, async (r) => {
    r.store.tasks.get(r.task.id)!.usedConnectors = true;
    (r.engine as unknown as { active: Map<string, { tainted: boolean }> }).active.get(r.task.id)!.tainted = true;
    const h = await r.hookAll('WebFetch', { url: 'https://docs.python.org/3/' });
    assert.deepEqual([h.cards, h.decision], [1, 'deny']);
    assert.match(h.summaries[0] ?? '', /connector \(GitHub\) data/, 'the one card is the egress card');
    const yes = await r.hookAll('WebFetch', { url: 'https://docs.python.org/3/' }, { allow: true });
    assert.deepEqual([yes.cards, yes.decision], [1, 'allow']);
    assert.equal((await r.canUse('WebFetch', { url: 'https://docs.python.org/3/' }, yes.id)).cards, 0);
  });
});

test('(d) Smart with a changed build file: npm test cards from the hook with the build card, one approval event', async () => {
  await using({ preset: 'smart', follow: true }, async (r) => {
    const before = await r.hookAll('Bash', { command: 'npm test' });
    assert.deepEqual([before.cards, before.decision], [0, undefined], 'no flag: Smart runs it');
    r.noteUse('Write', { file_path: `${r.projectDir()}/package.json`, content: '{}' });
    const h = await r.hookAll('Bash', { command: 'npm test' });
    assert.deepEqual([h.cards, h.decision], [1, 'deny']);
    assert.match(h.summaries[0] ?? '', BUILD_WHY);
  });
});

test('control: a plain Ask call with none of the four: the hook goes on, and canUseTool raises the one card', async () => {
  await using({}, async (r) => {
    const h = await r.hookAll('Bash', { command: 'echo hi' });
    assert.deepEqual([h.cards, h.decision], [0, undefined], 'nothing new cards on the hook path');
    const c = await r.canUse('Bash', { command: 'echo hi' }, h.id);
    assert.deepEqual([c.cards, c.behavior], [1, 'deny']);
    // an ls or an in-folder read the SDK approves by itself stays free in Ask
    for (const [tool, input] of [['Bash', { command: 'ls' }], ['Read', { file_path: `${r.projectDir()}/a.txt` }], ['Glob', { pattern: '*.ts' }]] as const) {
      const x = await r.hookAll(tool, input);
      assert.deepEqual([x.cards, x.decision], [0, undefined], `${tool} ${JSON.stringify(input)}`);
    }
  });
});
