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

/**
 * Ceilings for the Claude path: the sizes measured after Fascia 3a (#50) plus 5%. A change that makes a run's fixed cost
 * grow past one fails here; raise a ceiling only on purpose, with the reason next to it. An agent not listed is printed, not checked.
 */
const CEILING: Record<string, number> = {
  zealot: Math.ceil(7091 * 1.05), builder: Math.ceil(5205 * 1.05), scout: Math.ceil(5009 * 1.05),
  inquisitor: Math.ceil(4680 * 1.05), scribe: Math.ceil(4639 * 1.05), archivist: Math.ceil(4718 * 1.05),
  sentinel: Math.ceil(4789 * 1.05), forgemaster: Math.ceil(4678 * 1.05), exorcist: Math.ceil(4717 * 1.05),
  preceptor: Math.ceil(4630 * 1.05), herald: Math.ceil(4687 * 1.05), sculptor: Math.ceil(4884 * 1.05),
};

test('prompt size: every seeded agent gets a system prompt, sizes are printed, and none grows past its ceiling', async () => {
  const sizes = await measure();
  assert.ok(Object.keys(sizes).length >= 12);
  for (const [id, s] of Object.entries(sizes)) console.log(`prompt-size ${id} chars=${s.chars} words=${s.words}${CEILING[id] ? ` ceiling=${CEILING[id]}` : ' (no ceiling)'}`);
  if (process.env.LEGION_PROMPT_SIZE_JSON) console.log('prompt-size-json ' + JSON.stringify(sizes));
  for (const [id, max] of Object.entries(CEILING)) {
    if (sizes[id]) assert.ok(sizes[id]!.chars <= max, `${id}: ${sizes[id]!.chars} chars, ceiling ${max}. A run's fixed cost grew; trim it or raise the ceiling on purpose with the reason`);
  }
});
