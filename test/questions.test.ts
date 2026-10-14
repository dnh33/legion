/**
 * Structured questions: the ask_user_question input validation and the QuestionBroker (the question card's core half).
 *
 * The A-key safety rule lives in the UI half (test/question-card.test.ts) and in Thread.tsx's focus guard; here the
 * point is that the tool `mcp__legion__ask_user_question` is one of Legion's own tools, so a call never raises an
 * approval card, and that the broker resolves, times out and cancels exactly like the approval broker.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { EventBus } from '../src/core/bus.js';
import { QuestionBroker, QUESTION_LIMITS, validateQuestions } from '../src/core/questions.js';
import type { LegionEvent, QuestionSpec } from '../src/shared/types.js';
import { isLegionTool, needsApproval } from '../src/core/approvals.js';

const q = (over: Partial<Record<string, unknown>> = {}) => ({ question: 'Which one?', header: 'Pick', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], ...over });
const wrap = (questions: unknown) => ({ questions });

test('validateQuestions: accepts 1-4 questions with 2-4 options, normalises and preserves the fields', () => {
  const ok = validateQuestions(wrap([q({ multiSelect: true, options: [{ label: 'A', description: 'a', preview: 'x = 1' }, { label: 'B', description: 'b', recommended: true }] })]));
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.questions.length, 1);
  assert.equal(ok.questions[0]!.header, 'Pick');
  assert.equal(ok.questions[0]!.multiSelect, true);
  assert.equal(ok.questions[0]!.options[0]!.preview, 'x = 1');
  assert.equal(ok.questions[0]!.options[1]!.recommended, true);
  // 4 questions of 4 options is the upper bound and must pass
  const four = validateQuestions(wrap(Array.from({ length: QUESTION_LIMITS.maxQuestions }, (_, i) => q({ question: `Q${i}?`, header: `H${i}`, options: [{ label: 'a', description: '' }, { label: 'b', description: '' }, { label: 'c', description: '' }, { label: 'd', description: '' }] }))));
  assert.equal(four.ok, true);
  // header defaults rather than refusing the whole call
  const noHeader = validateQuestions(wrap([q({ header: undefined })]));
  assert.equal(noHeader.ok, true);
  if (noHeader.ok) assert.equal(noHeader.questions[0]!.header, 'Q1');
});

test('validateQuestions: refuses out-of-bounds counts and empty labels (1-4 questions, 2-4 options, one Recommended)', () => {
  const cases: Array<[string, unknown]> = [
    ['no array', {}],
    ['zero questions', wrap([])],
    ['five questions', wrap(Array.from({ length: 5 }, () => q()))],
    ['one option', wrap([q({ options: [{ label: 'A', description: 'a' }] })])],
    ['five options', wrap([q({ options: Array.from({ length: 5 }, (_, i) => ({ label: `o${i}`, description: '' })) })])],
    ['empty label', wrap([q({ options: [{ label: '  ', description: '' }, { label: 'B', description: 'b' }] })])],
    ['no label field', wrap([q({ options: [{ description: '' }, { label: 'B', description: 'b' }] })])],
    ['two recommended', wrap([q({ options: [{ label: 'A', description: '', recommended: true }, { label: 'B', description: '', recommended: true }] })])],
    ['empty question', wrap([q({ question: '   ' })])],
  ];
  for (const [name, input] of cases) {
    const v = validateQuestions(input);
    assert.equal(v.ok, false, `${name} must be refused`);
    if (!v.ok) assert.ok(v.error.length > 0, `${name} carries an error text`);
  }
});

test('broker: request emits question.requested, resolve returns the picks and emits question.resolved', async () => {
  const bus = new EventBus();
  const events: LegionEvent[] = [];
  bus.on((e) => events.push(e));
  const b = new QuestionBroker(bus);
  const spec: QuestionSpec[] = [{ question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes', description: 'ship' }, { label: 'No', description: 'wait' }], multiSelect: false }];
  const p = b.request('t1', 'a1', spec, { roomId: 'agent-bridge', fromAgentId: 'marshal', hop: 1 });
  assert.equal(b.pending().length, 1);
  const requested = events.find((e) => e.type === 'question.requested') as Extract<LegionEvent, { type: 'question.requested' }>;
  assert.ok(requested, 'question.requested was emitted');
  assert.equal(requested.question.taskId, 't1');
  assert.equal(requested.question.origin?.fromAgentId, 'marshal');
  const id = requested.question.id;
  assert.equal(b.resolve(id, [{ labels: ['Yes'] }]), true);
  assert.deepEqual(await p, { answered: true, picks: [{ labels: ['Yes'] }] });
  assert.equal(b.pending().length, 0);
  const resolved = events.find((e) => e.type === 'question.resolved') as Extract<LegionEvent, { type: 'question.resolved' }>;
  assert.equal(resolved?.answered, true);
  // a second resolve of the same id is a no-op
  assert.equal(b.resolve(id, [{ labels: ['No'] }]), false);
});

test('broker: Other text and multi-select picks survive the round trip', async () => {
  const b = new QuestionBroker(new EventBus());
  const spec: QuestionSpec[] = [
    { question: 'Which?', header: 'Which', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: true },
    { question: 'Why?', header: 'Why', options: [{ label: 'X', description: '' }, { label: 'Y', description: '' }], multiSelect: false },
  ];
  const p = b.request('t', 'a', spec);
  const id = b.pending()[0]!.id;
  b.resolve(id, [{ labels: ['A', 'B'] }, { labels: [], other: 'because' }]);
  assert.deepEqual(await p, { answered: true, picks: [{ labels: ['A', 'B'] }, { labels: [], other: 'because' }] });
});

test('broker: auto-declines on timeout, and cancelForTask declines only that task', async () => {
  const b = new QuestionBroker(new EventBus(), { timeoutMs: 20 });
  assert.deepEqual(await b.request('t', 'a', []), { answered: false, picks: null });
  assert.equal(b.pending().length, 0);

  const b2 = new QuestionBroker(new EventBus());
  const a = b2.request('t1', 'a', []);
  const c = b2.request('t2', 'a', []);
  b2.cancelForTask('t1');
  assert.deepEqual(await a, { answered: false, picks: null });
  assert.equal(b2.pending().length, 1);
  assert.equal(b2.pending()[0]!.taskId, 't2');
  b2.resolve(b2.pending()[0]!.id, [{ labels: ['ok'] }]);
  assert.deepEqual(await c, { answered: true, picks: [{ labels: ['ok'] }] });
});

test('ask_user_question is one of Legion\'s own tools: it never raises an approval card, and it is registered as that exact name', () => {
  const name = 'mcp__legion__ask_user_question';
  assert.equal(isLegionTool(name), true);
  assert.equal(needsApproval('ask', name), false);
  assert.equal(needsApproval('auto-edits', name), false);
  // the twin: a foreign ask tool still cards
  assert.equal(needsApproval('ask', 'mcp__somebot__ask_user_question'), true);
  // the tool must be registered in the legion server under exactly this name (a rename here would silently change what the agent calls)
  const src = readFileSync(join(process.cwd(), 'src/core/agent-tools.ts'), 'utf8');
  assert.match(src, /'ask_user_question'/, 'the tool is registered on the legion server');
  assert.match(src, /ctx\.questions\.request\(ctx\.taskId, agentId, v\.questions/);
});
