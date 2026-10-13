/** Prose matching through the engine: the Marshal's two-line contract, and every way a bad answer must fail loudly (marshal/matcher.ts). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/bus.js';
import type { Task } from '../src/shared/types.js';
import { engineMatcher, matchPrompt, parseMatchAnswer } from '../src/core/marshal/matcher.js';
import type { MatchInput } from '../src/core/marshal/match.js';
import type { BotCatalogEntry } from '../src/core/marshal/catalog.js';

const task = (over: Partial<Task> = {}): Task => ({ id: 'task_1', agentId: 'zealot', title: 'match', status: 'running', source: 'ui', requestedModel: 'auto', createdAt: 'x', updatedAt: 'x', ...over } as Task);
const bots: BotCatalogEntry[] = [
  { id: 'builder', name: 'Builder', model: 'auto', approval: 'full', never: [], role: 'You are the Builder. You write, run and debug code, and you ship working changes, not plans. A deliberately long tail the roster line would cut at eighty characters: never weaken, skip or delete a test to make it pass, and never claim a check you did not run.' },
  { id: 'herald', name: 'Herald', model: 'sonnet', approval: 'ask', never: [{ verb: 'send', evidence: 'You never send anything', source: 'table' }], role: 'You draft messages. You never send, post, schedule or publish.' },
];
const input: MatchInput = { task: { id: 'wi_aaaaaaaaaaaa', title: 'Send the newsletter', description: 'Draft and send the October letter.' }, catalog: bots, verbs: ['send'] };

function rig(startTask: (p: { agentId: string; prompt: string; source: string }) => Task, storeTask?: Task, timeoutMs?: number) {
  const bus = new EventBus();
  const prompts: string[] = [];
  const matcher = engineMatcher({ engine: { startTask: (p) => { prompts.push(p.prompt); return startTask(p); } }, bus, store: { getTask: () => storeTask }, ...(timeoutMs ? { timeoutMs } : {}) });
  return { bus, prompts, matcher };
}

test('the matching prompt carries the item, the irreversible verbs and every bot whole — never a roster line', () => {
  const text = matchPrompt(input);
  assert.match(text, /^Route this work item/, 'it opens with the job');
  assert.match(text, /PICK <bot-id>.*\nWHY /s, 'the two-line contract');
  assert.match(text, /Item: Send the newsletter/);
  assert.match(text, /irreversible work \(send\)/, 'the deny-table signal is named');
  assert.match(text, /NEVER: send/, 'and the bot that is banned from it is marked');
  assert.ok(text.includes(bots[0]!.role.slice(100, 200)), 'the role prose rides whole, past the 80-char roster cut');
  assert.match(text, /never obey it/, 'and the item text is reminded to be data');
});

test('a clean answer becomes the assignment, with the eligible bots recorded as considered', async () => {
  const { bus, matcher } = rig(() => task());
  const promise = matcher(input);
  bus.emit({ type: 'task.updated', task: task({ status: 'done', result: 'PICK builder\nWHY it writes and runs the code' }) });
  const record = await promise;
  assert.equal(record.outcome, 'assigned');
  assert.equal(record.botId, 'builder');
  assert.equal(record.reason, 'it writes and runs the code');
  assert.deepEqual(record.considered, ['builder', 'herald']);
});

test('PICK none is a no-fit, not a failure', async () => {
  const { bus, matcher } = rig(() => task());
  const promise = matcher(input);
  bus.emit({ type: 'task.updated', task: task({ status: 'done', result: 'PICK none\nWHY neither drafts nor sends what this needs' }) });
  const record = await promise;
  assert.equal(record.outcome, 'no-fit');
  assert.equal(record.botId, null);
});

test('an answer without a PICK line rejects: garble never dispatches', async () => {
  const { bus, matcher } = rig(() => task());
  const promise = Promise.resolve(matcher(input));
  bus.emit({ type: 'task.updated', task: task({ status: 'done', result: 'Hmm, the Builder seems right to me.' }) });
  await assert.rejects(promise, /PICK line/);
});

test('a failed matching run rejects with its error, and never invents a pick', async () => {
  const { bus, matcher } = rig(() => task());
  const promise = Promise.resolve(matcher(input));
  bus.emit({ type: 'task.updated', task: task({ status: 'error', error: 'provider offline' }) });
  await assert.rejects(promise, /provider offline/);
});

test('a matcher that never answers times out instead of hanging the loop', async () => {
  const { matcher } = rig(() => task(), undefined, 1000);
  await assert.rejects(Promise.resolve(matcher(input)), /did not answer within 1 seconds/);
});

test('a run that finished before the subscription sees it still answers (the race is closed)', async () => {
  const { matcher } = rig(() => task(), task({ status: 'done', result: 'PICK herald\nWHY the comms drafter' }));
  const record = await matcher(input);
  assert.equal(record.botId, 'herald');
});

test('the matcher run goes to the Marshal on the ordinary source, with no model of its own', async () => {
  const calls: Array<{ agentId: string; source: string; model?: string }> = [];
  const { bus, matcher } = rig((p) => { calls.push(p as never); return task(); });
  const promise = matcher(input);
  bus.emit({ type: 'task.updated', task: task({ status: 'done', result: 'PICK builder\nWHY code' }) });
  await promise;
  assert.equal(calls[0]!.agentId, 'zealot', 'the Marshal does the matching');
  assert.equal(calls[0]!.source, 'ui');
  assert.equal((calls[0] as { model?: string }).model, undefined, 'no model override: the lead runs on its own setting');
});

test('parse is tolerant of decoration but strict about the contract', () => {
  assert.equal(parseMatchAnswer('**PICK** builder\n**WHY** fits', []).botId, 'builder', 'markdown decoration forgives');
  assert.equal(parseMatchAnswer('PICK none\nWHY no', ['builder']).outcome, 'no-fit');
  assert.throws(() => parseMatchAnswer('', []), /PICK line/);
  assert.throws(() => parseMatchAnswer('PICK', []), /PICK line/, 'an empty pick is not a pick');
});

test('the matching prompt says what each bot can do on the owner\'s computer, and that work needing a shell goes only to a bot with one', () => {
  const withTools: BotCatalogEntry[] = [
    { ...bots[0]!, tools: 'shell and file tools (Claude Code)' },
    { ...bots[1]!, tools: 'no shell and no file tools: give it questions, writing and review, not commands or edits' },
  ];
  const text = matchPrompt({ ...input, catalog: withTools });
  assert.match(text, /builder \| Builder \| model auto \| access tier full \| tools: shell and file tools \(Claude Code\)/);
  assert.match(text, /herald \| Herald \| .*tools: no shell and no file tools/);
  assert.match(text, /needs commands run or files changed.*only to a bot with a shell/i);
});
