import test from 'node:test';
import assert from 'node:assert/strict';
import { getCatalog } from '../src/core/catalog.js';
import { defaultConfig } from '../src/shared/config.js';
import type { QueryFn } from '../src/core/engine.js';

function mk(over: { commands?: () => Promise<any>; models?: () => Promise<any> } = {}) {
  const st = { calls: 0, closed: 0, opts: undefined as any, prompt: undefined as any };
  const queryFn = ((p: any) => {
    st.calls++; st.opts = p.options; st.prompt = p.prompt;
    return {
      supportedCommands: over.commands ?? (async () => [
        { name: 'cost', description: 'Cost', argumentHint: '' },
        { name: '/cost', description: 'dup', argumentHint: '' },
        { name: 'review', description: 'Review', argumentHint: '<pr>', builtin: true, aliases: ['rv'] },
      ]),
      supportedModels: over.models ?? (async () => [
        { value: 'opus', displayName: 'Opus 5.5', description: 'big', resolvedModel: 'claude-opus-5-5' },
        { value: 'opus', displayName: 'dup', description: '' },
        { value: 'sonnet', displayName: 'Sonnet 5.5', description: 'fast' },
      ]),
      interrupt: async () => undefined, close: () => { st.closed++; },
    };
  }) as unknown as QueryFn;
  return { st, queryFn };
}

test('catalog: dedupes, strips slash, uses idle streaming prompt and no API key env', async () => {
  const save = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'k';
  try {
    const { st, queryFn } = mk();
    const c = await getCatalog({ config: defaultConfig(), queryFn });
    assert.equal(c.error, undefined);
    assert.deepEqual(c.commands.map((x) => x.name), ['cost', 'review']);
    assert.deepEqual(c.commands[1], { name: 'review', description: 'Review', argumentHint: '<pr>', aliases: ['rv'], builtin: true });
    assert.deepEqual(c.models.map((x) => x.value), ['opus', 'sonnet']);
    assert.equal(c.models[0]!.resolvedModel, 'claude-opus-5-5');
    assert.equal(typeof st.prompt[Symbol.asyncIterator], 'function');
    assert.equal(st.opts.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(st.closed, 1);
    assert.equal(st.opts.strictMcpConfig, true, 'the picker probe must not connect inherited MCP servers');
  } finally { if (save === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = save; }
});

test('catalog: cached 10 minutes, force re-probes, concurrent calls dedupe', async () => {
  let t = 1_000;
  const { st, queryFn } = mk();
  const deps = { config: defaultConfig(), queryFn, now: () => t };
  const [a, b] = await Promise.all([getCatalog(deps), getCatalog(deps)]);
  assert.equal(st.calls, 1);
  assert.equal(a, b);
  t += 9 * 60_000;
  await getCatalog(deps);
  assert.equal(st.calls, 1);
  await getCatalog(deps, { force: true });
  assert.equal(st.calls, 2);
  t += 11 * 60_000;
  await getCatalog(deps);
  assert.equal(st.calls, 3);
});

test('catalog: failure returns empty lists + error, never throws, is not cached', async () => {
  let fail = true;
  const { st, queryFn } = mk({ models: async () => { if (fail) throw new Error('not signed in'); return [{ value: 'opus', displayName: 'O', description: '' }]; } });
  const deps = { config: defaultConfig(), queryFn };
  let c = await getCatalog(deps);
  assert.deepEqual([c.commands, c.models], [[], []]);
  assert.match(c.error!, /not signed in/);
  fail = false;
  c = await getCatalog(deps);
  assert.equal(c.error, undefined);
  assert.equal(c.models.length, 1);
  assert.equal(st.calls, 2);
  const thrower = (() => { throw new Error('spawn failed'); }) as unknown as QueryFn;
  c = await getCatalog({ config: defaultConfig(), queryFn: thrower });
  assert.match(c.error!, /spawn failed/);
  c = await getCatalog({ config: defaultConfig(), timeoutMs: 20, queryFn: mk({ commands: () => new Promise(() => undefined) }).queryFn });
  assert.match(c.error!, /timed out/);
});
