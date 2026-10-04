/**
 * Why a run ended with nothing to show, and whether the conversation Legion sends is one a provider will accept.
 *
 * Both exist because of a real failure on the owner's machine: task_20aa5eda4089 reported "Provider returned an empty
 * response" and nothing else, which is not a diagnosis. The model turned out to answer correctly in every direct probe,
 * so the fault was somewhere between the request Legion built and the response it parsed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { firstConversationBreak } from '../src/core/providers/conversation.js';
import { buildMessages, emptyAnswerReason } from '../src/core/providers/tool-loop.js';

describe('provider: an empty turn says why', () => {
  it('names the output limit rather than shrugging', () => {
    // A reasoning model can spend its whole allowance thinking and never reach the answer.
    assert.match(emptyAnswerReason('length', 1), /entire output limit/);
    assert.ok(!/empty answer/i.test(emptyAnswerReason('length', 1)));
  });

  it('distinguishes unreadable tool calls from a model that said nothing', () => {
    // finish=tool_calls with no parsed calls is the case this build actually hit.
    assert.match(emptyAnswerReason('tool_calls', 1), /could not read them/);
    assert.notEqual(emptyAnswerReason('tool_calls', 1), emptyAnswerReason('length', 1));
  });

  it('names an early stream close, which is the one a retry can fix', () => {
    assert.match(emptyAnswerReason(undefined, 1), /stream ended early/);
  });

  it('says which turn, so a multi-turn tool loop is diagnosable', () => {
    assert.match(emptyAnswerReason('length', 4), /turn 4/);
    assert.ok(!/turn/.test(emptyAnswerReason('length', 1)));
  });

  it('falls back to the raw finish reason instead of guessing', () => {
    assert.match(emptyAnswerReason('weird_new_reason', 1), /weird_new_reason/);
  });
});

describe('provider: the conversation Legion sends is one a provider accepts', () => {
  const host = (stored: unknown[]) => ({ stored, prompt: 'next', systemPrompt: 'sys' }) as never;

  it('accepts a well-formed conversation', () => {
    const msgs = buildMessages(host([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
      { role: 'user', text: 'again' },
    ]));
    assert.equal(firstConversationBreak(msgs), undefined);
  });

  it('never opens with an assistant turn or a tool result', () => {
    // The shape a naive "last N messages" slice produces, which is what the failing task's stored transcript looked like.
    const msgs = buildMessages(host([
      { role: 'user', text: 'first' },
      { role: 'tool', text: '{"a":1}', toolName: 'house_list', toolUseId: 'tu_1' },
      { role: 'tool', text: 'ok', resultFor: 'tu_1' },
      { role: 'assistant', text: 'done' },
      { role: 'user', text: 'second' },
    ]));
    assert.ok(msgs[0]!.role === 'system' || msgs[0]!.role === 'user', 'opens with system or user');
    assert.equal(firstConversationBreak(msgs), undefined, 'no orphaned tool result survives the slice');
  });

  it('survives a long tool-heavy transcript with no orphan', () => {
    // Shaped like the real one: 82 stored messages, mostly tool calls and results, ending on a user turn.
    const stored: unknown[] = [{ role: 'user', text: 'start' }];
    for (let i = 0; i < 25; i++) {
      stored.push({ role: 'tool', text: `{"i":${i}}`, toolName: 'kg_search', toolUseId: `tu_${i}` });
      stored.push({ role: 'tool', text: 'result', resultFor: `tu_${i}` });
      stored.push({ role: 'assistant', text: `step ${i}` });
      stored.push({ role: 'user', text: `next ${i}` });
    }
    const msgs = buildMessages(host(stored));
    assert.equal(firstConversationBreak(msgs), undefined, 'a 100-message tool loop must still be well-formed');
  });

  it('bounds the history by the window, not by an arbitrary message count', () => {
    // This used to assert `msgs.length < stored.length` — that history is ALWAYS trimmed. Under compaction that is wrong:
    // a transcript inside the model's window is sent whole, because trimming it would throw away context the model can
    // still use. The bound is the window, so that is what is asserted here.
    const small = [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }, { role: 'user', text: 'c' }];
    assert.equal(buildMessages(host(small)).length, 4, 'system + the whole transcript + the current ask');

    const big: unknown[] = [{ role: 'user', text: 'start' }];
    for (let i = 0; i < 400; i++) {
      big.push({ role: 'user', text: `ask ${i} ${'padding '.repeat(60)}` });
      big.push({ role: 'assistant', text: `answer ${i} ${'padding '.repeat(60)}` });
    }
    big.push({ role: 'user', text: 'current' });

    // Over the window but WITHOUT a summary, nothing is dropped. This is the lossless-failure rule and it is the more
    // important half: the provider will refuse this request for size, which the owner can see, and the transcript is
    // intact. Silently trimming it here is the behaviour this feature replaced.
    const unsummarised = buildMessages(host(big), { window: 8_192 });
    assert.equal(unsummarised.length, big.length + 1, 'no summary means the conversation goes out unchanged, not trimmed');
    assert.equal(firstConversationBreak(unsummarised), undefined);

    // With a summary, the middle is replaced by it and the request shrinks hard.
    const cut = buildMessages({ stored: big as Array<{ role: string; text: string }>, prompt: 'current', systemPrompt: 'sys' }, { window: 8_192, summary: { role: 'system', content: '[compacted earlier turns]\n\n## Goal\nkeep going' } });
    assert.ok(cut.length < 20, `an over-window conversation with a summary is cut (got ${cut.length})`);
    assert.equal(firstConversationBreak(cut), undefined, 'and the cut is still a request an endpoint accepts');
    // The ask is passed explicitly rather than through `host()`, which hardcodes `prompt: 'next'` — a mismatch there
    // fails this assertion while saying nothing about the code under test.
    assert.equal(cut[cut.length - 1]!.content, 'current', 'the current ask survives the cut');
  });

  it('detects an orphan, which is the failure an endpoint answers with a mid-stream error', () => {
    assert.match(
      firstConversationBreak([
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'result', tool_call_id: 'call_gone' },
      ]) ?? '',
      /no matching tool_call/,
    );
  });
});