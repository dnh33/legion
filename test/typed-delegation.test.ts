/**
 * Fascia 3b (claude/plan-fascia.md 6.3): typed delegation. A lead may attach a brief (goal, one to four done_when
 * checks, optional context/returns/budget/priority) to ask/tell instead of prose. The bridge renders it as a short
 * header into the callee's message, bounds the child run's spend (clamped by the owner's claude.maxBudgetUsd), scores
 * only the goal when the model is `auto`, and reads a verdict from the answer's first line against the callee's own
 * contract. Prose must be unchanged. Each test here was shown to fail under a scratch mutation of the product code.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import { initialPrompt } from '../src/core/input-channel.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { defaultConfig } from '../src/shared/config.js';
import type { CoreConfig } from '../src/shared/config.js';
import type { AgentProfile } from '../src/shared/types.js';
import { briefSchema } from '../src/core/agent-tools.js';
import { clampBudget, briefBudget, renderBrief, routeTextFor, verdictOf, verdictTokens, GOAL_MAX } from '../src/core/brief.js';
import { BUILDER_SOUL, ROSTER, SCOUT_SOUL, ZEALOT_SOUL } from '../src/core/roster.js';

// ---------------------------------------------------------------- harness

type Call = { agent: string; prompt: string; options: any; n: number };
type Script = (c: Call) => AsyncGenerator<any, void> | undefined;

const mkAgent = (id: string, name: string, model: string): AgentProfile => ({
  id, name, emoji: '*', description: `${name} does things`, systemPrompt: '', model,
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'full', mcpServers: [],
  createdAt: '', updatedAt: '',
});

let sidN = 0;
/** A success result message in the shape the SDK emits; total_cost_usd flows to Task.costUsd. */
const okResult = (text: string, sid: string, costUsd = 0) => ({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: costUsd, num_turns: 1, session_id: sid });
const init = (sid: string) => ({ type: 'system', subtype: 'init', session_id: sid });

/** Builder runs on `auto` (as the shipped default does) so the router is really exercised. */
function setup(script: Script, patch?: (c: CoreConfig) => void, maxConcurrent = 4) {
  const dir = cleanupTemp('legion-td-');
  const store = new Store(dir);
  for (const [id, name, model] of [['zealot', 'Zealot', 'auto'], ['builder', 'Builder', 'auto'], ['scout', 'Scout', 'sonnet']] as const) store.upsertAgent(mkAgent(id, name, model));
  store.upsertAgent({ ...store.getAgent('builder')!, systemPrompt: BUILDER_SOUL });
  store.upsertAgent({ ...store.getAgent('scout')!, systemPrompt: SCOUT_SOUL });
  const bus = new EventBus();
  const config = defaultConfig();
  config.workspaceDir = join(dir, 'ws');
  patch?.(config);
  const calls: Call[] = [];
  const queryFn = ((p: any) => {
    const agent = basename(p.options.cwd);
    const call: Call = { agent, prompt: initialPrompt(p.prompt), options: p.options, n: calls.filter((c) => c.agent === agent).length };
    calls.push(call);
    const sid = `sess-${++sidN}`;
    const custom = script(call);
    const gen = custom ?? (async function* () {
      yield init(sid);
      yield okResult(`${agent} says: ${initialPrompt(p.prompt).split('\n').pop()}`, sid);
    })();
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined });
  }) as unknown as QueryFn;
  const engine = new Engine({ store, bus, vms: {} as any, approvals: new ApprovalBroker(bus), config, queryFn, boatConfigured: () => false, maxConcurrent });
  return { store, bus, engine, calls, config };
}

async function callTool(options: any, name: string, args: any): Promise<{ isError?: boolean; text: string; json?: any }> {
  const t = options.mcpServers.legion.instance._registeredTools[name];
  const r = await t.handler(args, {});
  const text = r.content.map((c: any) => c.text).join('\n');
  let json: any; try { json = JSON.parse(text); } catch { /* tool refused: plain text */ }
  return { isError: r.isError, text, json };
}

// ---------------------------------------------------------------- brief.ts

test('brief schema: one to four done_when checks and a goal of at most 300 characters', () => {
  const ok = (b: unknown) => briefSchema.safeParse(b).success;
  assert.equal(ok({ goal: 'g', done_when: ['a'] }), true);
  assert.equal(ok({ goal: 'g', done_when: ['a', 'b', 'c', 'd'] }), true);
  assert.equal(ok({ goal: 'g', done_when: [] }), false, 'no checks is not a way to agree what done means');
  assert.equal(ok({ goal: 'g', done_when: ['a', 'b', 'c', 'd', 'e'] }), false, 'more than four checks is refused');
  assert.equal(ok({ goal: 'x'.repeat(GOAL_MAX), done_when: ['a'] }), true);
  assert.equal(ok({ goal: 'x'.repeat(GOAL_MAX + 1), done_when: ['a'] }), false, 'a goal over 300 characters is refused');
  assert.equal(ok({ goal: 'g', done_when: ['a'], budget: { usd: 0.5 }, priority: 'high' }), true);
  assert.equal(ok({ goal: 'g', done_when: ['a'], budget: { usd: -1 } }), false, 'a negative budget is refused');
  assert.equal(ok({ goal: 'g', done_when: ['a'], budget: { usd: Number.POSITIVE_INFINITY } }), false);
  assert.equal(ok({ goal: 'g', done_when: ['a'], priority: 'urgent' }), false, 'an unknown priority is refused');
});

test('brief rendering: the plan header, and the prose follows it when both are given', () => {
  const b = { goal: 'fix export', done_when: ['win passes', 'no new files'], context: ['src/export.ts:42', 'task 7f3a9c'], returns: 'the diff' };
  assert.equal(renderBrief(b), 'Goal: fix export\nDone when:\n1. win passes\n2. no new files\nContext: src/export.ts:42; task 7f3a9c\nReturns: the diff');
  assert.equal(renderBrief(b, 'please hurry'), 'Goal: fix export\nDone when:\n1. win passes\n2. no new files\nContext: src/export.ts:42; task 7f3a9c\nReturns: the diff\n\nplease hurry');
  assert.equal(renderBrief({ goal: 'g', done_when: ['a'] }), 'Goal: g\nDone when:\n1. a', 'context and returns are omitted when absent');
  assert.equal(renderBrief({ goal: 'g', done_when: ['a'] }, '   '), 'Goal: g\nDone when:\n1. a', 'a blank message adds nothing');
});

test('verdict: the first line is read against each soul\'s own contract; an unknown soul is none', () => {
  const souls: Array<[string, string]> = [['zealot', ZEALOT_SOUL], ['builder', BUILDER_SOUL], ['scout', SCOUT_SOUL], ...ROSTER.map((r) => [r.id, r.systemPrompt] as [string, string])];
  assert.ok(souls.length >= 13, `the plan names 13 souls; found ${souls.length}`);
  const expected: Record<string, string[]> = {
    zealot: ['STATUS', 'ANSWER'], builder: ['BUILT', 'PARTIAL', 'BLOCKED'], scout: ['FOUND', 'PARTIAL', 'NOT FOUND'],
    inquisitor: ['VERIFIED', 'NOT FIXED', 'QUESTIONABLE'], sentinel: ['STATUS', 'OK', 'WATCH', 'ALERT'], preceptor: ['SHIP', 'FIX FIRST'],
  };
  for (const [id, soul] of souls) {
    assert.deepEqual(verdictTokens(soul), expected[id] ?? [], `${id}: contract tokens`);
    const tokens = verdictTokens(soul);
    if (!tokens.length) { assert.equal(verdictOf(soul, 'FOUND'), 'none', `${id}: names no verdict -> none`); continue; }
    for (const t of tokens) assert.equal(verdictOf(soul, `${t}\nbody`), t, `${id}: ${t} is read back`);
  }
  // the plan's own examples, verbatim
  assert.equal(verdictOf(BUILDER_SOUL, 'BUILT\nChanged: x'), 'BUILT');
  assert.equal(verdictOf(BUILDER_SOUL, 'PARTIAL: could not finish'), 'PARTIAL');
  assert.equal(verdictOf(BUILDER_SOUL, 'BLOCKED on the missing key'), 'BLOCKED');
  assert.equal(verdictOf(ROSTER.find((r) => r.id === 'inquisitor')!.systemPrompt, 'NOT FIXED — the claim does not hold'), 'NOT FIXED', 'a two-word verdict wins over its first word alone');
  assert.equal(verdictOf(ROSTER.find((r) => r.id === 'inquisitor')!.systemPrompt, 'VERIFIED'), 'VERIFIED');
  assert.equal(verdictOf(SCOUT_SOUL, 'NOT FOUND'), 'NOT FOUND');
  assert.equal(verdictOf(ZEALOT_SOUL, 'STATUS 1 of 2 done, 0 blocked'), 'STATUS');
  // edges
  assert.equal(verdictOf(BUILDER_SOUL, '**BUILT**\nChanged: x'), 'BUILT', 'leading markdown does not hide the verdict');
  assert.equal(verdictOf(BUILDER_SOUL, 'BUILDER is not a verdict'), 'none', 'a word is only a verdict when it is the token, not its prefix');
  assert.equal(verdictOf(BUILDER_SOUL, ''), 'none');
  assert.equal(verdictOf(BUILDER_SOUL, 'I could not do it'), 'none');
  assert.equal(verdictOf('My own bot, no contract.', 'BUILT'), 'none', 'an unknown soul has no verdict list');
});

test('budget: a brief asks for a cap, and the owner\'s cap is the ceiling', () => {
  assert.equal(clampBudget(5, 1), 1, 'a request above the owner\'s cap is pulled back');
  assert.equal(clampBudget(0.25, 1), 0.25, 'a request below the cap is kept');
  assert.equal(clampBudget(2, undefined), 2, 'no owner cap: the request is the only bound');
  assert.equal(clampBudget(undefined, 3), 3, 'no request: the owner\'s cap stands');
  assert.equal(clampBudget(undefined, undefined), undefined);
  assert.equal(clampBudget(0, 1), 1, 'a non-positive request is dropped, not passed on');
  assert.equal(clampBudget(-4, undefined), undefined);
  assert.equal(clampBudget(Number.NaN, 1), 1);
  assert.equal(briefBudget({ goal: 'g', done_when: ['a'], budget: { usd: 2 } }), 2);
  assert.equal(briefBudget({ goal: 'g', done_when: ['a'] }), undefined);
  assert.equal(routeTextFor({ goal: 'score me', done_when: ['a'] }), 'score me');
  assert.equal(routeTextFor(undefined), undefined, 'no brief: the router scores the whole prompt, as before');
});

// ---------------------------------------------------------------- bridge + engine

test('ask with a brief: the callee sees the header, the result names model/verdict/cost', async () => {
  let asked: any;
  const s = setup((c) => {
    if (c.agent === 'zealot') return (async function* () {
      yield init('z1');
      asked = await callTool(c.options, 'ask', {
        agent: 'builder',
        brief: { goal: 'make the export test pass', done_when: ['windows passes', 'no new files'], context: ['src/export.ts:42'], returns: 'the diff' },
        message: 'hurry',
      });
      yield okResult('zealot done', 'z1');
    })();
    if (c.agent === 'builder') return (async function* () { yield init('b1'); yield okResult('BUILT\nChanged: src/export.ts:42\nEvidence: 6 pass, 0 fail', 'b1', 0.12); })();
    return undefined;
  });
  await s.engine.waitFor(s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' }).id, 5000);
  assert.equal(asked.isError, undefined);
  assert.equal(asked.json.verdict, 'BUILT');
  assert.equal(asked.json.model, 'sonnet');
  assert.equal(asked.json.costUsd, 0.12);
  assert.match(asked.json.result, /^BUILT\n/);
  const bt = s.store.getTask(asked.json.taskId)!;
  assert.equal(bt.agentId, 'builder');
  const bc = s.calls.find((c) => c.agent === 'builder')!;
  assert.equal(bc.prompt, '[From Zealot (Legion agent) via the bridge. Reply with just what they need; your final message is returned to them.]\nGoal: make the export test pass\nDone when:\n1. windows passes\n2. no new files\nContext: src/export.ts:42\nReturns: the diff\n\nhurry');
  assert.equal(s.store.listMessages(bt.id)[0]!.text, 'Goal: make the export test pass\nDone when:\n1. windows passes\n2. no new files\nContext: src/export.ts:42\nReturns: the diff\n\nhurry', 'the stored turn is the brief, not the header');
});

test('ask without a brief is unchanged: the plain prompt, no scoring slice, no brief budget', async () => {
  let asked: any; let empty: any;
  const s = setup((c) => c.agent !== 'zealot' ? undefined : (async function* () {
    yield init('z1');
    empty = await callTool(c.options, 'ask', { agent: 'builder' });
    asked = await callTool(c.options, 'ask', { agent: 'builder', message: 'build it' });
    yield okResult('done', 'z1');
  })());
  await s.engine.waitFor(s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' }).id, 5000);
  assert.equal(empty.isError, true, 'a call with neither a message nor a brief is refused');
  assert.match(empty.text, /message or a brief/);
  assert.equal(asked.json.result, 'builder says: build it');
  assert.equal(asked.json.verdict, 'none', 'a plain answer that does not start with a contract word is none');
  assert.equal(asked.json.costUsd, 0, 'the fake reported a zero cost; it is still carried');
  const bc = s.calls.find((c) => c.agent === 'builder')!;
  assert.equal(bc.prompt, '[From Zealot (Legion agent) via the bridge. Reply with just what they need; your final message is returned to them.]\nbuild it');
  assert.equal(bc.options.maxBudgetUsd, undefined, 'no brief and no owner cap: no per-run cap');
  assert.equal(s.store.listMessages(s.store.getTask(asked.json.taskId)!.id)[0]!.text, 'build it');
});

test('a brief is scored by its goal only, so its checks cannot flip auto routing', async () => {
  const long = 'refactor and debug the plan and review it '.repeat(60); // > 1800 chars with several hard keywords
  const brief = { goal: 'say hello', done_when: [long] };
  const make = (args: any) => setup((c) => c.agent !== 'zealot' ? undefined : (async function* () {
    yield init('z1');
    await callTool(c.options, 'ask', args);
    yield okResult('z', 'z1');
  })());
  const withBrief = make({ agent: 'builder', brief });
  await withBrief.engine.waitFor(withBrief.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' }).id, 5000);
  assert.equal(withBrief.calls.find((c) => c.agent === 'builder')!.options.model, 'sonnet', 'the brief text must not flip the router');
  const prose = make({ agent: 'builder', message: long });
  await prose.engine.waitFor(prose.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' }).id, 5000);
  assert.equal(prose.calls.find((c) => c.agent === 'builder')!.options.model, 'opus', 'the same words as prose DO flip the router (the guard is not vacuous)');
});

test('a brief\'s budget reaches the child run, clamped by the owner\'s cap', async () => {
  const s = setup((c) => c.agent !== 'zealot' ? undefined : (async function* () {
    yield init('z1');
    await callTool(c.options, 'ask', { agent: 'builder', brief: { goal: 'a', done_when: ['x'], budget: { usd: 5 } }, fresh: true });
    await callTool(c.options, 'ask', { agent: 'builder', brief: { goal: 'b', done_when: ['x'], budget: { usd: 0.25 } }, fresh: true });
    await callTool(c.options, 'ask', { agent: 'builder', message: 'prose', fresh: true });
    yield okResult('z', 'z1');
  })(), (c) => { c.claude.maxBudgetUsd = 1; });
  await s.engine.waitFor(s.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' }).id, 5000);
  const runs = s.calls.filter((c) => c.agent === 'builder');
  assert.equal(runs.length, 3);
  assert.equal(runs[0]!.options.maxBudgetUsd, 1, 'a brief asking for $5 is clamped to the owner\'s $1');
  assert.equal(runs[1]!.options.maxBudgetUsd, 0.25, 'a brief under the cap keeps its own budget');
  assert.equal(runs[2]!.options.maxBudgetUsd, 1, 'a plain run still gets the owner\'s cap');

  // no owner cap: the brief's own budget is the only bound, and a plain run has none
  const s2 = setup((c) => c.agent !== 'zealot' ? undefined : (async function* () {
    yield init('z1');
    await callTool(c.options, 'ask', { agent: 'builder', brief: { goal: 'a', done_when: ['x'], budget: { usd: 5 } }, fresh: true });
    await callTool(c.options, 'ask', { agent: 'builder', message: 'prose', fresh: true });
    yield okResult('z', 'z1');
  })());
  await s2.engine.waitFor(s2.engine.startTask({ agentId: 'zealot', prompt: 'go', source: 'ui' }).id, 5000);
  const runs2 = s2.calls.filter((c) => c.agent === 'builder');
  assert.equal(runs2[0]!.options.maxBudgetUsd, 5);
  assert.equal(runs2[1]!.options.maxBudgetUsd, undefined);
});
