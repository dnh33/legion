// test/claude-own-checks.test.ts: for Claude agents, Claude's own permission system decides about Claude's tools and Legion adds only what
// Claude Code lacks (0.3.6, owner rulings 2026-10-20, smart-auto addendum 1 and 2). Each row compares the same call with the switch off (the old
// path, which is also what a provider agent gets) and on. Hooks run first and an `allow` from one skips Claude's own checker, so no hook may
// answer allow unless the owner just approved a Legion card for that call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gatesRig, noKeyStore, keyedStore } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import { dataFolderTargets } from '../src/core/exec/canonical-path.js';
import { claudePermissionMode, startIsStricter } from '../src/core/permission-mode.js';
import type { GateRule } from '../src/shared/types.js';
import { checkerFallbackLine } from '../src/shared/claude-checks-copy.js';

const rule = (id: string, then: GateRule['then'], when: GateRule['when']): GateRule => ({ id, enabled: true, then, when, label: id, source: 'user' });
const using = async (o: Parameters<typeof gatesRig>[0], body: (r: GatesRig) => Promise<void>) => {
  const r = await gatesRig(o);
  try { await body(r); } finally { r.stop(); }
};
const DATA = join(homedir(), '.legion-ownchecks');
const fwd = DATA.replace(/\\/g, '/');
const dataModule = { id: 'dataguard', protectedPaths: () => dataFolderTargets(DATA) } as never;
type Call = (r: GatesRig) => { tool: string; input: Record<string, unknown> };

/** The hook answer for one call under both settings: [cards, decision] with the switch off, then on. */
async function pair(call: Call, o: Parameters<typeof gatesRig>[0] = {}, prep?: (r: GatesRig) => void, withData = false) {
  const out: Array<[number, string | undefined]> = [];
  for (const ownChecks of [false, true]) {
    await using({ ...o, ownChecks }, async (r) => {
      if (withData) r.engine.setModules([dataModule]);
      prep?.(r);
      const c = call(r);
      const h = await r.hookAll(c.tool, c.input);
      out.push([h.cards, h.decision]);
    });
  }
  return out;
}

test('the mode map: each preset sets Claude\'s own mode explicitly, and the switch off keeps today\'s default', async () => {
  assert.deepEqual((['ask', 'auto-edits', 'smart', 'smart-edits', 'full'] as const).map((m) => claudePermissionMode(m)), ['default', 'acceptEdits', 'auto', 'default', 'bypassPermissions']);
  for (const [app, want] of [['ask', 'default'], ['accept-edits', 'acceptEdits'], ['smart', 'auto'], ['bypass', 'bypassPermissions']] as const) {
    await using({ app, follow: true, ownChecks: true }, async (r) => { assert.equal(r.options().permissionMode, want, app); });
  }
  // Smart held by Accept edits (the meet) is never looser than either
  await using({ own: 'auto-edits', preset: 'smart', follow: false, ownChecks: true }, async (r) => { assert.equal(r.options().permissionMode, 'default'); });
  // switch off: exactly today's path
  for (const app of ['ask', 'accept-edits', 'smart'] as const) {
    await using({ app, follow: true, ownChecks: false }, async (r) => { assert.equal(r.options().permissionMode, 'default', `${app} off`); });
  }
  await using({ app: 'bypass', follow: true, ownChecks: false }, async (r) => { assert.equal(r.options().permissionMode, 'bypassPermissions'); });
});

test('a later mode is stricter than the start mode only when Claude\'s start mode is looser', () => {
  assert.equal(startIsStricter('default', 'ask'), false);
  assert.equal(startIsStricter('acceptEdits', 'ask'), true);
  assert.equal(startIsStricter('acceptEdits', 'auto-edits'), false);
  assert.equal(startIsStricter('auto', 'auto-edits'), true, 'sideways counts as a change: never looser than either');
  assert.equal(startIsStricter('acceptEdits', 'full'), false);
  assert.equal(startIsStricter('default', 'smart'), false);
});

const ROWS: Array<[string, Call]> = [
  ['an unjudgeable command raises no card for Claude (its own parser and checker handle it)', () => ({ tool: 'Bash', input: { command: 'x=ls; $x' } })],
  ['a change to a protected file (.git/hooks) is Claude\'s to judge', (r) => ({ tool: 'Write', input: { file_path: `${r.projectDir()}/.git/hooks/pre-commit`, content: 'x' } })],
  ['reading a credentials file elsewhere is Claude\'s to judge', () => ({ tool: 'Read', input: { file_path: `${homedir()}/.aws/credentials` } })],
  ['a new web site is Claude\'s to judge', () => ({ tool: 'WebFetch', input: { url: 'https://example.org/a' } })],
  ['deleting the project folder is Claude\'s to judge', (r) => ({ tool: 'Bash', input: { command: `rm -rf ${r.projectDir()}` } })],
];
for (const [name, call] of ROWS) {
  test(`turned off for Claude agents: ${name}; the old path still cards it`, async () => {
    const [off, on] = await pair(call);
    assert.deepEqual(off, [1, 'deny'], 'switch off (the provider path\'s verdict): a Legion card');
    assert.deepEqual(on, [0, undefined], 'switch on: no Legion card, the hook lets Claude decide');
  });
}

const KEPT: Array<[string, Call, Parameters<typeof gatesRig>[0], ((r: GatesRig) => void)?]> = [
  ['Legion\'s own key files stay guarded', () => ({ tool: 'Read', input: { file_path: `${fwd}/providers/keys.json` } }), {}],
  ['a command on Legion\'s own settings folder still cards', () => ({ tool: 'Bash', input: { command: `rm -rf ${fwd}/gates` } }), {}],
  ['a gate Ask rule still cards', () => ({ tool: 'Bash', input: { command: 'echo hi' } }), {}, (r) => r.setRules([rule('gr_ask', 'ask', { tools: ['Bash'], commands: ['echo *'] })])],
  ['an outside-run ceiling still cards', () => ({ tool: 'Bash', input: { command: 'echo hi' } }), { ceiling: 'ask', originAtStart: true }],
  ['the web card after connector data still cards', () => ({ tool: 'WebFetch', input: { url: 'https://docs.python.org/3/' } }), {}, (r) => {
    r.store.tasks.get(r.task.id)!.usedConnectors = true;
    (r.config as { taint?: unknown }).taint = { shell: 'strict', outsideFiles: true, noticeSeen: true };
    (r.engine as unknown as { active: Map<string, { tainted: boolean }> }).active.get(r.task.id)!.tainted = true;
  }],
];
for (const [name, call, o, prep] of KEPT) {
  test(`kept for Claude agents: ${name}, with the switch off and on`, async () => {
    const [off, on] = await pair(call, o, prep, true);
    assert.deepEqual(off, [1, 'deny']);
    assert.deepEqual(on, [1, 'deny']);
  });
}

test('a gate Block rule and the shell floor deny in both settings, with no card', async () => {
  const block = await pair(() => ({ tool: 'Bash', input: { command: 'rm foo' } }), {}, (r) => r.setRules([rule('gr_block', 'deny', { tools: ['Bash'], commands: ['rm *'] })]));
  assert.deepEqual(block, [[0, 'deny'], [0, 'deny']]);
  const floor = await pair(() => ({ tool: 'Bash', input: { command: 'rm -rf /' } }));
  assert.deepEqual(floor, [[0, 'deny'], [0, 'deny']]);
});

test('Smart: the old path lets Legion\'s own judge allow a plain command; for a Claude agent only Claude\'s prompt reaches canUseTool, as a card', async () => {
  await using({ app: 'smart', follow: true, ownChecks: false }, async (r) => {
    const h = await r.hookAll('Bash', { command: 'echo hi' });
    const c = await r.canUse('Bash', { command: 'echo hi' }, h.id);
    assert.deepEqual([c.cards, c.behavior], [0, 'allow'], 'Legion\'s classifier waved it through');
  });
  await using({ app: 'smart', follow: true, ownChecks: true }, async (r) => {
    const h = await r.hookAll('Bash', { command: 'echo hi' });
    assert.deepEqual([h.cards, h.decision], [0, undefined]);
    const c = await r.canUse('Bash', { command: 'echo hi' }, h.id);
    assert.deepEqual([c.cards, c.behavior], [1, 'deny'], 'Claude asked, so the owner is asked; the answer was no');
  });
});

test('a gate Allow rule does not answer Claude\'s prompt for a Claude agent (it would skip Claude\'s checker)', async () => {
  const allow = [rule('gr_allow', 'allow', { tools: ['Bash'], commands: ['echo *'] })];
  await using({ ownChecks: false }, async (r) => {
    r.setRules(allow);
    const c = await r.canUse('Bash', { command: 'echo hi' }, 'u-old');
    assert.deepEqual([c.cards, c.behavior], [0, 'allow'], 'old path: the rule answers');
  });
  await using({ ownChecks: true }, async (r) => {
    r.setRules(allow);
    const c = await r.canUse('Bash', { command: 'echo hi' }, 'u-new');
    assert.deepEqual([c.cards, c.behavior], [1, 'deny'], 'Claude\'s prompt becomes a card');
  });
});

test('canUseTool for a Claude agent shows Claude\'s prompt as a card and never allows by itself', async () => {
  await using({ ownChecks: true }, async (r) => {
    const no = await r.canUse('Bash', { command: 'git push --force origin main' }, 'u1', false, { decisionReason: 'This command requires approval' });
    assert.deepEqual([no.cards, no.behavior], [1, 'deny']);
    assert.match(no.summaries[0] ?? '', /git push --force origin main/);
    assert.match(no.summaries[0] ?? '', /Claude asked: This command requires approval/);
    assert.match(no.message ?? '', /Do not retry it, rephrase it or reach the same result another way/);
    const yes = await r.canUse('Bash', { command: 'git push --force origin main' }, 'u2', true);
    assert.deepEqual([yes.cards, yes.behavior], [1, 'allow']);
  });
});

test('Legion\'s own tools keep their own cards: Claude\'s prompt about them is not a second card, except the few an outside ceiling cards', async () => {
  await using({ ownChecks: true }, async (r) => {
    const c = await r.canUse('mcp__legion__board_list', {}, 'u5');
    assert.deepEqual([c.cards, c.behavior], [0, 'allow']);
  });
  await using({ ownChecks: true, ceiling: 'ask', originAtStart: true }, async (r) => {
    const c = await r.canUse('mcp__legion__vm_exec', { command: 'ls' }, 'u6');
    assert.deepEqual([c.cards, c.behavior], [1, 'deny']);
  });
});

test('the denial brake\'s fallback prompt reaches the owner as a normal card showing its reason', async () => {
  await using({ ownChecks: true }, async (r) => {
    const reason = '3 consecutive actions were blocked. Please review the transcript before continuing.';
    const c = await r.canUse('Bash', { command: 'cat x' }, 'u3', false, { decisionReason: reason });
    assert.equal(c.cards, 1);
    assert.match(c.summaries[0] ?? '', /3 consecutive actions were blocked/);
  });
});

test('an unanswered Claude prompt is denied with a "do not retry" text', async () => {
  await using({ ownChecks: true, approvalTimeoutMs: 80 }, async (r) => {
    const fn = (r.options() as { canUseTool: (t: string, i: Record<string, unknown>, o: unknown) => Promise<{ behavior: string; message?: string }> }).canUseTool;
    const p = fn('Bash', { command: 'git commit -m x' }, { signal: new AbortController().signal, toolUseID: 'u4' });
    await r.advanceApprovalTimeout();
    const d = await p;
    assert.equal(d.behavior, 'deny');
    assert.match(d.message ?? '', /No one answered the approval request/);
    assert.match(d.message ?? '', /Do not retry it, rephrase it or reach the same result another way/);
  });
});

test('a card a hook already answered is kept for canUseTool: one card per call', async () => {
  await using({ ownChecks: true, ceiling: 'ask', originAtStart: true }, async (r) => {
    const yes = await r.hookAll('Bash', { command: 'echo hi' }, { allow: true });
    assert.deepEqual([yes.cards, yes.decision], [1, 'allow']);
    const after = await r.canUse('Bash', { command: 'echo hi' }, yes.id);
    assert.deepEqual([after.cards, after.behavior], [0, 'allow']);
  });
});

test('hard rule: with Claude\'s own checks on, no hook answers allow unless the owner just approved a Legion card for that call', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ['Bash', { command: 'echo hi' }], ['Bash', { command: 'ls' }], ['Bash', { command: 'x=ls; $x' }], ['Bash', { command: 'git push --force origin main' }],
    ['Bash', { command: `rm -rf ${fwd}/gates` }], ['Read', { file_path: `${homedir()}/.aws/credentials` }], ['Read', { file_path: `${fwd}/providers/keys.json` }],
    ['Write', { file_path: 'a.txt', content: 'x' }], ['Edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }], ['WebFetch', { url: 'https://example.org/' }],
    ['WebSearch', { query: 'x' }], ['Glob', { pattern: '*' }], ['mcp__other__tool', {}], ['AskUserQuestion', {}],
  ];
  for (const rigOpts of [{ own: 'ask' as const }, { own: 'auto-edits' as const }, { app: 'smart' as const, follow: true }, { own: 'ask' as const, ceiling: 'ask' as const, originAtStart: true }]) {
    await using({ ...rigOpts, ownChecks: true }, async (r) => {
      r.engine.setModules([dataModule]);
      for (const [tool, input] of calls) {
        for (const allow of [false, true]) {
          const h = await r.hookAll(tool, input, { allow });
          assert.ok(h.decision !== 'allow' || h.cards > 0, `${JSON.stringify(rigOpts)} ${tool} ${JSON.stringify(input)}: allow with no card`);
        }
      }
    });
  }
});

test('the preset changes to a stricter one mid-run: a hook asks (Claude\'s mode is fixed at start); a looser one waits for the next run', async () => {
  await using({ own: 'auto-edits', ownChecks: true }, async (r) => {
    assert.equal(r.options().permissionMode, 'acceptEdits');
    const w = { file_path: `${r.projectDir()}/a.txt`, content: 'x' };
    assert.equal((await r.hookAll('Write', w)).decision, undefined);
    r.setMode('ask');
    const h = await r.hookAll('Write', w);
    assert.deepEqual([h.cards, h.decision], [0, 'ask'], 'routed to canUseTool, where it becomes a card');
    assert.equal((await r.hookAll('Read', { file_path: w.file_path })).decision, undefined, 'a read stays free');
    const c = await r.canUse('Write', w, h.id);
    assert.equal(c.cards, 1);
  });
  await using({ own: 'ask', ownChecks: true }, async (r) => {
    r.setMode('auto-edits');
    assert.equal((await r.hookAll('Write', { file_path: `${r.projectDir()}/a.txt`, content: 'x' })).decision, undefined, 'looser: no change in this run');
  });
});

test('a provider agent keeps Legion\'s full system while the switch is on: the same calls card through the provider path, and not through a Claude agent\'s hook', async () => {
  for (const [name, call] of ROWS) {
    await using({ ownChecks: true }, async (r) => {
      const c = call(r);
      // the hook first: a guard card answered on the provider path is shared with an identical call for a few seconds
      const claude = await r.hookAll(c.tool, c.input);
      assert.deepEqual([claude.cards, claude.decision], [0, undefined], `${name}: a Claude agent's hook leaves it to Claude`);
      const provider = await r.run(c.tool, c.input);
      assert.equal(provider.card, true, `${name}: provider path cards it`);
      assert.equal(provider.noRemember, true, `${name}: and it is one of Legion's guard cards, not the plain card of the preset`);
    });
  }
});

test('a run that started in Full and is demoted mid-run: Legion\'s Smart judge does not stand in for Claude\'s checks; the owner is asked on a card', async () => {
  await using({ preset: 'bypass', follow: true, ownChecks: true }, async (r) => {
    assert.equal(r.options().permissionMode, 'bypassPermissions');
    const full = await r.hookAll('Bash', { command: 'echo hi' });
    assert.deepEqual([full.cards, full.decision], [0, undefined], 'still Full: nothing asks');
    r.core.store.patchProject(r.project.id, { preset: 'smart' });
    const asked = await r.hookAll('Bash', { command: 'echo hi' });
    assert.deepEqual([asked.cards, asked.decision], [1, 'deny'], 'demoted: a card (answered no here)');
    assert.deepEqual((await r.hookAll('Read', { file_path: `${r.projectDir()}/a.txt` })).cards, 0, 'a read stays free');
    const yes = await r.hookAll('Bash', { command: 'echo hi' }, { allow: true });
    assert.deepEqual([yes.cards, yes.decision], [1, undefined], 'yes lets Claude run it; the hook answers nothing');
    r.setRules([rule('gr_block', 'deny', { tools: ['Bash'], commands: ['echo *'] })]);
    assert.deepEqual([(await r.hookAll('Bash', { command: 'echo hi' })).cards, (await r.hookAll('Bash', { command: 'echo hi' })).decision], [0, 'deny'], 'a Block rule still denies');
  });
});

test('the card for Claude\'s prompt offers no Remember (an allow rule would not answer Claude\'s prompts)', async () => {
  await using({ ownChecks: true }, async (r) => {
    const fn = (r.options() as { canUseTool: (t: string, i: Record<string, unknown>, o: unknown) => Promise<unknown> }).canUseTool;
    const p = fn('Bash', { command: 'git commit -m x' }, { signal: new AbortController().signal, toolUseID: 'u7' });
    await r.tick();
    assert.equal(r.pending()[0]?.noRemember, true);
    r.answer(false);
    await p;
  });
});

test('Claude\'s other denials (the owner\'s inherited rules, modes) reach the activity log only; Legion\'s own hook denials are not repeated', async () => {
  await using({ app: 'smart', follow: true, ownChecks: true }, async (r) => {
    r.stream({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't3', decision_reason_type: 'rule', decision_reason: 'Bash(rm:*) is denied by your settings', message: 'm' });
    r.stream({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't4', decision_reason_type: 'hook', message: 'x' });
    assert.ok(lines(r).some((t) => /Claude denied Bash: Bash\(rm:\*\) is denied by your settings/.test(t)));
    assert.equal(lines(r).filter((t) => /Claude denied/.test(t)).length, 1);
    assert.equal(thread(r).filter((t) => /Claude denied|checker blocked/.test(t)).length, 0);
  });
});

const lines = (r: GatesRig) => r.activityRead({ taskId: r.task.id }).map((l) => l.text);
const thread = (r: GatesRig) => r.store.listMessages(r.task.id).map((m) => m.text);

test('Claude\'s checker denial goes to the thread and the activity log; a denial that is not the checker\'s does not', async () => {
  await using({ app: 'smart', follow: true, ownChecks: true }, async (r) => {
    r.stream({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't1', decision_reason_type: 'classifier', decision_reason: '[Credential Exploration]', message: 'Permission for this action was denied by the Claude Code auto mode classifier.' });
    r.stream({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't2', decision_reason_type: 'hook', message: 'x' });
    assert.deepEqual(thread(r).filter((t) => /checker blocked/.test(t)), ['Claude\'s checker blocked: [Credential Exploration] (Bash)']);
    assert.ok(lines(r).some((t) => /Claude's checker blocked: \[Credential Exploration\] \(Bash\)/.test(t)));
  });
});

test('the headless denial brake ends the run with a plain notice in the thread and the activity log', async () => {
  await using({ app: 'smart', follow: true, ownChecks: true }, async (r) => {
    r.stream({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Agent aborted: too many classifier denials in headless mode'], result: '' });
    const want = /Claude's checker blocked several actions in a row; the run stopped\. Review what it tried\./;
    assert.ok(thread(r).some((t) => want.test(t)), thread(r).join(' | '));
    assert.ok(lines(r).some((t) => want.test(t)));
  });
});

test('fallback is detected from the init message: auto asked for but not given shows once; auto given shows nothing', async () => {
  await using({ app: 'smart', follow: true, ownChecks: true }, async (r) => {
    assert.equal(r.options().permissionMode, 'auto');
    r.stream({ type: 'system', subtype: 'init', session_id: 's1', permissionMode: 'default', model: 'claude-haiku-4-5' });
    r.stream({ type: 'system', subtype: 'init', session_id: 's1', permissionMode: 'default', model: 'claude-haiku-4-5' });
    assert.equal(r.store.getTask(r.task.id)?.claudeChecker, 'fallback');
    assert.equal(r.store.getTask(r.task.id)?.claudeCheckerModel, 'claude-haiku-4-5');
    const line = checkerFallbackLine([{ agent: r.agent.name, model: 'claude-haiku-4-5' }]);
    assert.match(line, /not available for .+ on Claude Haiku 4\.5,/);
    assert.equal(thread(r).filter((t) => t === line).length, 1, 'once');
    assert.ok(lines(r).some((t) => t === line));
  });
  await using({ app: 'smart', follow: true, ownChecks: true }, async (r) => {
    r.stream({ type: 'system', subtype: 'init', session_id: 's1', permissionMode: 'auto' });
    assert.equal(r.store.getTask(r.task.id)?.claudeChecker, 'on');
    assert.equal(thread(r).filter((t) => /checker/.test(t)).length, 0);
  });
  await using({ app: 'ask', follow: true, ownChecks: true }, async (r) => {
    r.stream({ type: 'system', subtype: 'init', session_id: 's1', permissionMode: 'default' });
    assert.equal(r.store.getTask(r.task.id)?.claudeChecker, undefined, 'not a Smart run');
  });
});

test('the setting: absent means on, off is written down, and turning it on is a loosening', () => {
  const nokey = noKeyStore();
  assert.equal(nokey.store.app().claudeOwnChecks, undefined);
  nokey.store.patchApp({ claudeOwnChecks: false });
  assert.equal(nokey.store.app().claudeOwnChecks, false);
  assert.throws(() => nokey.store.patchApp({ claudeOwnChecks: true }), /key/i, 'no signing key: a loosening is refused');
  const keyed = keyedStore();
  keyed.store.patchApp({ claudeOwnChecks: false });
  const prev = keyed.store.preview('app', { claudeOwnChecks: true });
  assert.equal(prev.loosens, true);
  assert.match(prev.lines.join(' '), /Claude's own permission checks/);
  keyed.store.patchApp({ claudeOwnChecks: true });
  assert.equal(keyed.store.app().claudeOwnChecks, undefined);
  assert.equal(keyed.store.preview('app', { claudeOwnChecks: false }).loosens, false, 'off is the tightening direction');
  assert.throws(() => keyed.store.patchProject('proj_aaaaaaaaaaaa', { claudeOwnChecks: true }), /whole app/);
});

// ---------------------------------------------------------------- slice B: the pre-run check of the model (ruling 1)

const MODELS = (rows: Array<[string, boolean | undefined]>) => async () => ({ commands: [], fetchedAt: '', models: rows.map(([value, auto]) => ({ value, displayName: value, description: '', ...(auto !== undefined ? { supportsAutoMode: auto } : {}) })) });

test('before a Smart run, a model the catalog lists without auto support starts in default and says so once', async () => {
  // the rig's agent runs on "auto" routing, which resolves to a concrete model; list every alias without auto except a decoy that has it
  const none = MODELS([['sonnet', undefined], ['opus', undefined], ['haiku', undefined], ['some-other', true]]);
  await using({ app: 'smart', follow: true, ownChecks: true, catalog: none }, async (r) => {
    assert.equal(r.options().permissionMode, 'default', 'Claude asks, as in Ask; Legion\'s Smart judge is never used instead');
    assert.equal(r.store.getTask(r.task.id)?.claudeChecker, 'fallback');
    const named = (t: string) => /^Claude's checker is not available for .+ on .+, so Claude asks you as in Ask\.$/.test(t) && !/this model/.test(t);
    assert.equal(thread(r).filter(named).length, 1, 'once, in the thread, naming the agent and the model');
    assert.ok(lines(r).some(named), 'and in the activity log');
    // the init message then agrees (default): no second line
    r.stream({ type: 'system', subtype: 'init', session_id: 's1', permissionMode: 'default' });
    assert.equal(thread(r).filter((t) => /checker is not available/.test(t)).length, 1);
  });
});

test('before a Smart run, a model the catalog lists with auto support keeps auto; an unknown catalog changes nothing', async () => {
  const every = MODELS([['sonnet', true], ['opus', true], ['haiku', true]]);
  await using({ app: 'smart', follow: true, ownChecks: true, catalog: every }, async (r) => {
    assert.equal(r.options().permissionMode, 'auto');
    assert.equal(r.store.getTask(r.task.id)?.claudeChecker, undefined, 'said "on" only when the init message confirms it');
  });
  // an older Claude Code that does not report the field at all: nobody has it, so nothing is known and the init message decides
  const unknown = MODELS([['sonnet', undefined], ['opus', undefined], ['haiku', undefined]]);
  await using({ app: 'smart', follow: true, ownChecks: true, catalog: unknown }, async (r) => { assert.equal(r.options().permissionMode, 'auto'); });
  // the catalog cannot be read: same
  await using({ app: 'smart', follow: true, ownChecks: true, catalog: async () => { throw new Error('down'); } }, async (r) => { assert.equal(r.options().permissionMode, 'auto'); });
  await using({ app: 'smart', follow: true, ownChecks: true, catalog: async () => ({ commands: [], models: [], fetchedAt: '', error: 'timed out' }) }, async (r) => { assert.equal(r.options().permissionMode, 'auto'); });
});

test('the catalog is asked only for a Smart run on Claude\'s own checks', async () => {
  let asked = 0;
  const catalog = async () => { asked++; return MODELS([['sonnet', undefined], ['x', true]])(); };
  for (const [app, ownChecks] of [['ask', true], ['accept-edits', true], ['bypass', true], ['smart', false]] as const) {
    await using({ app, follow: true, ownChecks, catalog }, async (r) => { assert.notEqual(r.store.getTask(r.task.id)?.claudeChecker, 'fallback', `${app} ${ownChecks}`); });
  }
  assert.equal(asked, 0);
});

test('a chain another agent started at full approval is judged like the owner\'s own run (Claude\'s checks first); Ask keeps Legion\'s guards, and so does Strict', async () => {
  const call: Call = (r) => ({ tool: 'Write', input: { file_path: `${r.projectDir()}/.git/hooks/pre-commit`, content: 'x' } });
  const full = await pair(call, { ceiling: 'full', originAtStart: true });
  assert.deepEqual(full, [[1, 'deny'], [0, undefined]], 'full ceiling: off = Legion card, on = Claude decides (as for an owner-started run)');
  const ask = await pair(call, { ceiling: 'ask', originAtStart: true });
  assert.deepEqual(ask, [[1, 'deny'], [1, 'deny']], 'ask ceiling: Legion\'s guard cards with the switch off and on');
  const strict = await pair(call, { ceiling: 'full', originAtStart: true }, (r) => { (r.config as { taint?: unknown }).taint = { shell: 'strict', outsideFiles: true, noticeSeen: true }; });
  assert.deepEqual(strict, [[1, 'deny'], [1, 'deny']], 'Strict: any started-by-another run keeps its guards (0.3.9)');
});
