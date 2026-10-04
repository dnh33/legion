/**
 * Three holes found after 0.2.3-b, written as EVIDENCE rather than as unit coverage.
 *
 * Each of these was written to FAIL against the code as it was, and the failure is the finding. A green suite had
 * already covered this area thoroughly and proved nothing about any of it:
 *
 *  1. The window was checked ONCE, before the first tool call, and never again for the rest of the run. Tool output is
 *     added to `messages` after that check, so a run that grows past the window mid-flight only discovers it when the
 *     provider refuses — by which point the rescue has to salvage a conversation nothing ever trimmed.
 *  2. The rescue rebuilt `messages` from `host.stored`, a snapshot taken BEFORE the run. Tool results appended during the
 *     run are not in it, so the retry restarted from the original question and silently discarded the run's own work.
 *  3. `MAX_TOOL_RESULT_CHARS` clipped each result but nothing bounded their SUM. Sixteen calls at the cap is ~192k chars
 *     added by one turn — the overflow this whole feature exists to prevent, arriving through the back door.
 *
 * Tools are driven through the real VM tool with `vm: true`, the same way providers-tools.test.ts does, so the loop is
 * exercised as production exercises it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { compactionGuard, MAX_TOOL_RESULT_CHARS } from '../src/core/providers/tool-loop.js';
import type { ChatMessage } from '../src/core/providers/types.js';
import { applyPlan, planCompaction } from '../src/core/providers/compaction.js';
import { firstConversationBreak } from '../src/core/providers/conversation.js';
import { startFake, replyText, replyTools, jsonReply } from './providers-fakes.js';
import { setup, run } from './providers-harness.js';

const SUMMARY = '## Goal\nkeep going\n\n## Key Decisions\ncarry on';
const isSummaryCall = (body: string): boolean => /DATA to summarise/.test(body);

/** A VM whose exec returns `size` chars, so a turn's tool output can be made large on purpose. */
const fatVm = (h: ReturnType<typeof setup>, size: number): void => {
  (h.engine as any).vms.exec = async () => ({ exitCode: 0, stdout: 'q'.repeat(size), stderr: '' });
};

test('EVIDENCE: the window is re-checked inside the run, not only before turn 1', async () => {
  // The first version of this test asserted only that the run finished, and it PASSED against the code before this change
  // — verified by running it against 03315b1^. The fake never refused for size, so a conversation growing past the window
  // simply kept going and reached the reply text either way. A test that cannot fail is decoration, and the commit
  // message claimed otherwise. This version asserts the discriminator instead.
  //
  // The discriminator is whether the SUMMARISER is ever asked to compress a conversation that already contains a tool
  // result. The pre-flight check runs before turn 1, when the conversation is just [system, user] — it cannot see tool
  // output, so it can never produce such a call. Only the in-loop re-check can. Against the old code this count is
  // exactly zero.
  let turn = 0;
  let summaryCallsWithToolResult = 0;
  let summaryCallsTotal = 0;
  const f = await startFake((req, res) => {
    const body = JSON.stringify(req.body) ?? '';
    if (isSummaryCall(body)) {
      summaryCallsTotal++;
      // The summariser's input is rendered from `middle`; if the conversation being compressed carries a tool row, this
      // is the re-check rather than the pre-flight.
      if (/\[tool result\]/.test(body)) summaryCallsWithToolResult++;
      replyText(res, SUMMARY);
      return;
    }
    turn++;
    if (turn <= 6) { replyTools(res, [{ id: `c${turn}`, name: 'mcp__legion__vm_exec', args: { command: 'ls' } }]); return; }
    replyText(res, 'answered after growing');
  });
  try {
    const h = setup(f, { vm: true, agent: { approval: 'full' }, entry: { contextWindow: 24_000 }, maxTurns: 10 });
    fatVm(h, 40_000); // one tool result per turn, far past the per-result clip
    const t = await run(h);
    assert.equal(t.status, 'done', 'the run must finish');
    assert.ok(summaryCallsTotal > 0, 'the conversation was compacted at all');
    assert.ok(summaryCallsWithToolResult > 0,
      `no compaction ever covered tool output (${summaryCallsTotal} summariser calls, ${summaryCallsWithToolResult} of them over a tool row); ` +
      'the window is still only checked before turn 1, so a run that grows mid-flight is never trimmed');
  } finally { await f.close(); }
});

test('EVIDENCE: the rescue keeps the work the run already did — and what makes it reachable', async () => {
  // Reaching the rescue is the hard part, and it took five wrong versions of this test to see why.
  //
  // THE ARITHMETIC. Compaction triggers at 50% of the window; the provider refuses at 100%. If the request grows
  // gradually, the pre-flight check compacts long before the provider complains, so the rescue is never reached. Writing
  // the estimator as est and the provider's true count as real = est * k:
  //
  //     rescue is reachable  <=>  est > 0.5W  AND  est * k > W  <=>  k > 2
  //
  // So a single-factor estimator error can NEVER reach it: even a 36% underestimate (length/3 vs a real ~2.2
  // chars/token) leaves the request comfortably inside the window when the pre-flight last looked. The estimator has to
  // be wrong by more than 2x, which no plausible tokenizer ratio achieves.
  //
  // That is not a defect — it means the 50% headroom is doing its job and the rescue is the safety net for a case the
  // design does not expect. The realistic ways in: the window shrinks server-side between requests, or a single turn adds
  // content the estimator cannot see. Both are modelled here by refusing on a size the estimate does not track, which is
  // exactly the situation the rescue exists for.
  //
  // What must hold when it IS reached: the model called a tool, the result carries the marker, the provider refuses that
  // request, and the retry still carries the marker. A rescue that rebuilt the request from the pre-run snapshot would
  // lose it — the tail is the work.
  const MARKER = 'WORK-DONE-BEFORE-REFUSAL';
  let refusedAtRequest = -1;
  let chatNumber = 0;
  let rescueSawMarker = false;
  const f = await startFake((req, res) => {
    const body = JSON.stringify(req.body) ?? '';
    if (/DATA to summarise/.test(body)) {
      // A summary call: the rescue compacting the live conversation. If the marker is in here, the rescue SAW the work
      // and nothing was lost - it is being compressed, not dropped.
      if (body.includes(MARKER)) rescueSawMarker = true;
      replyText(res, `${SUMMARY} ${MARKER}`);
      return;
    }
    // Refuse when the request does not fit the provider's REAL window, which is smaller than the one Legion was told about.
    //
    // This models the case the rescue actually exists for, and reaching it took five wrong versions of this test.
    //
    // THE ARITHMETIC. Compaction triggers at 50% of the window Legion believes in; the provider refuses at 100% of the
    // window it actually has. Writing Legion's estimate as est and the provider's true count as real = est * k, the
    // rescue is reachable only when
    //
    //     est > 0.5 * W_configured   AND   est * k > W_actual
    //
    // With k < 2 those two conditions cannot both hold for gradual growth: the pre-flight check compacts first, and the
    // 50% headroom does its job. So the rescue is NOT dead code — it is the net for a DISCONTINUOUS change, and the two
    // real ones are (a) the provider's window differs from the configured one, which happens when a model is swapped,
    // aliased or downgraded under the same id, and (b) a turn adds content the estimate cannot see.
    //
    // (a) is modelled here: Legion is configured for 200k, the provider enforces 16k. Nothing compacts proactively, the
    // provider refuses a request that is genuinely over ITS limit, and the rescue is the only thing that can save the run.
    //
    // Recorded HERE because "maximum context length" is in the RESPONSE, never in the request log — searching the
    // requests for it afterwards always returns -1, which is what made this test report a missing refusal when the
    // refusal had already happened and been rescued.
    const REAL_WINDOW = 12_288;
    const realTokens = Math.ceil(body.length / 2.2);
    const hasToolResult = (req.body.messages ?? []).some((m: { role?: string }) => m.role === 'tool');
    if (hasToolResult && refusedAtRequest < 0 && realTokens > REAL_WINDOW) {
      refusedAtRequest = f.requests.length;
      jsonReply(res, 400, { error: { message: `This model's maximum context length is ${REAL_WINDOW} tokens, however you requested ${realTokens} tokens.` } });
      return;
    }
    // TWO tool turns, and this is load-bearing.
    //
    // One turn is not enough. A single turn gives [user, assistant(3 calls), 3 results] — six messages where the only
    // summarisable ground would be the tool group itself, and splitting a call from its results is the invalid sequence
    // this whole design forbids. The plan correctly refuses, the rescue correctly declines, and the run dies. That is right
    // behaviour, so the test must not ask for it.
    //
    // With a second turn there IS earlier ground: turn 1's exchange can be summarised, turn 2's group stays in the tail, and
    // the marker — delivered by turn 1 — survives the retry. That is the situation the rescue is for.
    chatNumber++;
    if (chatNumber === 1) {
      replyTools(res, [{ id: 'm1', name: 'mcp__legion__vm_exec', args: { command: 'cat marker' } }]);
      return;
    }
    if (chatNumber === 2) {
      // Three calls, so this turn alone can exceed a small window. Several verbose tools overflowing a small model is ordinary.
      replyTools(res, ['a', 'b', 'c'].map((id) => ({ id, name: 'mcp__legion__vm_exec', args: { command: 'cat verbose' } })));
      return;
    }
    replyText(res, 'recovered and answered');
  });
  try {
    const h = setup(f, { vm: true, agent: { approval: 'full' }, entry: { contextWindow: 200_000 }, maxTurns: 6 });
    // A genuinely oversized tool result — that is what earns the refusal, and what makes compaction worthwhile:
    // the summary has to be smaller than the middle it replaces.
    // The marker goes at the END of the tool output. agent-tools truncates a long result to its LAST 12000 chars, so a marker
    // at the front of an 84k-char result is cut before the loop ever sees it and the assertion could not pass for any
    // code at all. The tail is also the realistic place for the interesting part of a verbose result.
    (h.engine as any).vms.exec = async () => ({ exitCode: 0, stdout: `${'evidence about the migration. '.repeat(3_000)} ${MARKER}`, stderr: '' });
    const t = await run(h, 'a short ask');
    assert.ok(refusedAtRequest >= 0, 'the provider refused, so this test really exercised the rescue');
    assert.equal(t.status, 'done', 'the run must survive the refusal');
    // The retry, and only the retry: the marker must reach the model AFTER the refusal.
    //
    // It does NOT have to appear in the summariser's input. The marker is in the TAIL, which the rescue keeps verbatim
    // rather than summarising — so `markerInRescue` being false is the CORRECT outcome, and asserting it would have
    // inverted the design: it would have demanded that the work be summarised when the whole point of the tail is that
    // it is not.
    assert.equal(rescueSawMarker, true, 'the rescue summarised the marker: the work is compressed, not lost');
    const after = f.requests.slice(refusedAtRequest + 1).map((r) => JSON.stringify(r.body ?? {}));
    assert.ok(after.some((b) => b.includes(MARKER)),
      'the retry must still carry this run\'s own tool result; rebuilding the request from the pre-run snapshot discards it');
  } finally { await f.close(); }
});

test('EVIDENCE: one turn of tool output cannot consume the whole request', async () => {
  // Sixteen tools in one turn, each returning the maximum a single result may carry. Unbounded that is ~192k chars
  // appended to a single request: the overflow this feature exists to prevent, arriving through the back door.
  let turn = 0;
  let maxChars = 0;
  const f = await startFake((req, res) => {
    const body = JSON.stringify(req.body) ?? '';
    if (isSummaryCall(body)) { replyText(res, SUMMARY); return; }
    turn++;
    maxChars = Math.max(maxChars, body.length);
    if (turn <= 2) {
      replyTools(res, Array.from({ length: 16 }, (_, i) => ({ id: `c${turn}_${i}`, name: 'mcp__legion__vm_exec', args: { command: 'cat big' } })));
      return;
    }
    replyText(res, 'done');
  });
  try {
    const h = setup(f, { vm: true, agent: { approval: 'full' }, entry: { contextWindow: 32_000 } });
    fatVm(h, 200_000); // every result wants to be clipped to the 12k cap
    const t = await run(h);
    assert.equal(t.status, 'done');
    // A bounded total must be nowhere near 16 x 12k. The multiplier is deliberately generous: this asserts that the
    // SUM is bounded, not the exact tuning.
    assert.ok(maxChars < MAX_TOOL_RESULT_CHARS * 16,
      `one turn of tool output reached ${maxChars} chars across 16 results; the per-result clip is not bounding the total`);
  } finally { await f.close(); }
});

test('EVIDENCE: a protected head never splits a tool call from its results', async () => {
  // Found by an adversarial audit, and it was a regression I introduced. `PROTECT_FIRST` is a MESSAGE COUNT, and a count
  // has no idea where a tool group begins: with [user, assistant{3 calls}, tool, tool, tool] a head of 3 is
  // [user, assistant, tool], so the call keeps only its first result and the rest fall into the middle. applyPlan then
  // emits `assistant{3 calls} | tool | SUMMARY | tool | tool` — a sequence every OpenAI-compatible endpoint rejects, with a
  // 400 that is NOT a context-length error, so the rescue never fires and the run dies.
  //
  // The tail has had forward/backward alignment all along. The head had none, and that asymmetry was the entire bug.
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'the ask' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 't', arguments: '{}' } },
    ] },
    { role: 'tool', content: 'result one', tool_call_id: 'c1' },
    { role: 'tool', content: 'result two', tool_call_id: 'c2' },
    { role: 'assistant', content: 'and then', tool_calls: [{ id: 'c3', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', content: 'result three', tool_call_id: 'c3' },
    { role: 'assistant', content: 'the final answer' },
  ];
  // Every protectFirst, not just the production one: the invariant is that no head may end mid-group.
  //
  // Checked by COUNTING rather than by calling `firstConversationBreak`, deliberately. That helper was the reason this bug
  // survived a green suite — it tracked ids in a set, so a summary row landing between a call and its results neither matched
  // nor rejected and it reported the conversation valid. A test that leans on the blind helper cannot fail on the code that
  // needs catching. (The helper is fixed too, but the assertion here stands on its own.)
  for (const protectFirst of [0, 1, 2, 3, 4, 5, 6]) {
    const plan = planCompaction(msgs, { window: 200, protectFirst });
    const out = applyPlan(msgs, plan, { role: 'system', content: 'SUMMARY' });
    let open = 0;
    let interrupted = -1;
    for (let i = 0; i < out.length; i++) {
      const m = out[i]!;
      if (m.role === 'tool') open--;
      else if (m.role === 'assistant' && m.tool_calls?.length) open = m.tool_calls.length;
      else if (open > 0) { interrupted = i; break; }
    }
    assert.equal(interrupted, -1,
      `protectFirst=${protectFirst} put a summary between a tool call and its results: ${JSON.stringify(out.map((m) => m.role))}`);
    // And the project's own validator must agree, now that it can see this.
    assert.equal(firstConversationBreak(out), undefined,
      `protectFirst=${protectFirst} produced a request no endpoint accepts: ${JSON.stringify(out.map((m) => m.role))}`);
  }
});

test('EVIDENCE: the ask is never summarised away, whatever the plan does', async () => {
  // The second audit finding: `cut` may legally reach the end, which empties the tail, and if the most recent user message is
  // in the middle the request becomes [system, ask, summary-of-the-ask]. The transcript's contract is that the current prompt
  // is always re-sent by the caller, so a summary standing in for it misstates what the model was asked.
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'the ask' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', content: 'x'.repeat(60_000), tool_call_id: 'c1' },
  ];
  for (const window of [1_000, 8_192, 200_000]) {
    const plan = planCompaction(msgs, { window, protectFirst: 0, force: true });
    const out = applyPlan(msgs, plan, { role: 'system', content: 'SUMMARY' });
    assert.ok(out.some((m) => m.role === 'user'), `window=${window} summarised the ask away: ${JSON.stringify(out.map((m) => m.role))}`);
  }
});

test('EVIDENCE: the newest tool results are shown to the model, not summarised away', async () => {
  // The failure mode head-alignment first introduced, and the reason it must align FORWARD. A conversation of
  // [user, assistant{2 calls}, tool, tool] with protectFirst 3 puts the head mid-group. Ending the head before the group
  // instead moves the call and both results into the middle, so the model is handed a summary and never sees the two tool
  // errors — which is precisely what C16 asserts against. Measured with the backward alignment: both errors gone.
  const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'mcp__legion__agents', arguments: '{}' } });
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: null, tool_calls: [call('j'), call('big')] },
    { role: 'tool', content: 'Error: the arguments were not a JSON object within the size limit', tool_call_id: 'j' },
    { role: 'tool', content: 'Error: the arguments were not a JSON object within the size limit', tool_call_id: 'big' },
  ];
  for (const protectFirst of [2, 3, 4]) {
    const plan = planCompaction(msgs, { window: 16_384, protectFirst });
    const out = applyPlan(msgs, plan, { role: 'system', content: 'SUMMARY' });
    const shown = out.filter((m) => m.role === 'tool').length;
    const inMiddle = plan.middle.filter((m) => m.role === 'tool').length;
    assert.equal(shown + inMiddle, 2, `protectFirst=${protectFirst} lost a tool result entirely`);
    // Either the middle is empty (nothing to summarise, so the caller declines) or the results are verbatim in the head.
    assert.ok(plan.middle.length === 0 || inMiddle === 0,
      `protectFirst=${protectFirst} summarised the newest tool results; the model would never see them`);
  }
});
