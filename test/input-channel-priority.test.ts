/**
 * SDK 0.3.286+: a user message with priority 'now' no longer stops the running turn; it joins it. Legion's "send now" must not rely on that:
 * it cancels the run and starts a new one (ui queueStore sendQueuedNow -> api.cancelTask -> sendPromptTo). So no message Legion streams
 * into a run may carry a priority, and a queued follow-up stays a plain message the SDK folds in or answers in order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { InputChannel } from '../src/core/input-channel.js';

test('messages streamed into a run carry no priority, so "send now" never leans on the SDK interrupt semantics', async () => {
  const ch = new InputChannel('first');
  assert.equal(ch.push('second'), true);
  const it = ch[Symbol.asyncIterator]();
  for (const want of ['first', 'second']) {
    const r = await it.next();
    assert.equal(r.done, false);
    const m = r.value as unknown as Record<string, unknown> & { message: { content: string } };
    assert.equal(m.message.content, want);
    assert.equal('priority' in m, false, 'no priority field');
  }
});
