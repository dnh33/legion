/**
 * The fixed cost of a run: the system prompt Legion appends for each seeded agent, with the real kg, comms and BSV modules.
 * Measured with the real engine and a scripted query (no model call). Prints chars and words per agent; set
 * LEGION_PROMPT_SIZE_JSON=1 to also print JSON for a before/after comparison.
 */
import { closeAll, mount, until } from './token-harness.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

after(closeAll);

export async function measure(): Promise<Record<string, { chars: number; words: number }>> {
  const m = await mount(undefined, { seeded: true });
  const out: Record<string, { chars: number; words: number }> = {};
  for (const a of m.store.listAgents()) {
    const before = m.calls.length;
    let t;
    try { t = m.engine.startTask({ agentId: a.id, prompt: 'hello', source: 'ui' }); } catch { continue; } // e.g. the Assayer while BSV mode is off
    await until(() => m.calls.length > before);
    await m.engine.waitFor(t.id, 5000).catch(() => undefined);
    const append = String(m.calls[m.calls.length - 1]!.options.systemPrompt.append);
    out[a.id] = { chars: append.length, words: append.split(/\s+/).filter(Boolean).length };
  }
  return out;
}

test('prompt size: every seeded agent gets a system prompt, and the sizes are printed', async () => {
  const sizes = await measure();
  assert.ok(Object.keys(sizes).length >= 12);
  for (const [id, s] of Object.entries(sizes)) console.log(`prompt-size ${id} chars=${s.chars} words=${s.words}`);
  if (process.env.LEGION_PROMPT_SIZE_JSON) console.log('prompt-size-json ' + JSON.stringify(sizes));
});
