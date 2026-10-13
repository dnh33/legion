/**
 * Provider runs send an output cap (trial finding 5): without max_tokens a provider assumes the model's maximum, and
 * OpenRouter reserves credit for all of it, so a low balance failed every call. The cap is the output reserve the
 * compaction budget already assumes (15% of the window, 4,096 to 32,768).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { outputReserve } from '../src/core/providers/compaction.js';
import { startFake, replyText } from './providers-fakes.js';
import { setup, run } from './providers-harness.js';

test('a provider run asks for at most its output reserve: max_tokens follows the context window', async () => {
  const f = await startFake((_r, res) => replyText(res, 'done'));
  try {
    for (const window of [200_000, 24_000]) {
      const h = setup(f, { agent: { approval: 'full' }, entry: { contextWindow: window } });
      const before = f.requests.length;
      const t = await run(h, 'hello');
      assert.equal(t.status, 'done', t.error);
      const sent = f.requests.slice(before).filter((r) => r.url.endsWith('/chat/completions'));
      assert.ok(sent.length > 0);
      for (const r of sent) assert.equal(r.body.max_tokens, outputReserve(window), `window ${window}`);
    }
    assert.equal(outputReserve(200_000), 30_000);
    assert.equal(outputReserve(24_000), 4_096);
  } finally { await f.close(); }
});
