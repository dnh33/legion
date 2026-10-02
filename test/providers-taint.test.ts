import test from 'node:test';
import assert from 'node:assert/strict';
import { startFake } from './providers-fakes.js';
import { entryFor } from './providers-fakes.js';
import { mkAgent, run, setup } from './providers-harness.js';
import { PROVIDER_PRESETS } from '../src/core/providers/presets.js';
import type { chatTurn } from '../src/core/providers/openai-compat.js';
import type { ProviderEntry } from '../src/core/providers/types.js';

const say = (text: string): typeof chatTurn => (async () => ({ text, toolCalls: [], finishReason: 'stop' })) as any;
const r = (providerId: string, entry: ProviderEntry) => ({ providerId, model: 'm', entry });

test('A3 which endpoints start tainted: a custom remote one does; presets at their own address and loopback do not; trusted relaxes only the custom one', async () => {
  const f = await startFake(() => undefined);
  try {
    const h = setup(f);
    const rt = h.providers;
    const custom: ProviderEntry = { kind: 'openai-compat', label: 'C', baseUrl: 'https://llm.example.com/v1', enabled: true };
    assert.equal(rt.startsTainted(r('mine', custom)), true);
    assert.equal(rt.startsTainted(r('mine', { ...custom, trusted: true })), false, 'the owner relaxed it');
    assert.equal(rt.startsTainted(r('mine', { ...custom, baseUrl: 'http://127.0.0.1:9999/v1', keyless: true })), false, 'loopback');
    for (const p of PROVIDER_PRESETS) assert.equal(rt.startsTainted(r(p.id, p.entry)), false, p.id);
    // a preset id repointed at some other host is a custom endpoint now
    assert.equal(rt.startsTainted(r('openai', { ...PROVIDER_PRESETS[0]!.entry, baseUrl: 'https://evil.example.net/v1' })), true);
    assert.equal(rt.startsTainted(r('openai', { ...PROVIDER_PRESETS[0]!.entry, baseUrl: 'https://api.openai.com/v1/other' })), false, 'same origin as the preset');
    // an unusable address counts as untrusted
    assert.equal(rt.startsTainted(r('mine', { ...custom, baseUrl: 'ftp://x' })), true);
    assert.equal(rt.startsTainted({ providerId: 'gone', model: 'm' }), false, 'no entry: the run fails before anything is sent');
  } finally { await f.close(); }
});

test('A3 a run on a custom remote endpoint is tainted from the start: the live run, the stored task, and a reply bridged to another agent', async () => {
  const f = await startFake(() => undefined);
  try {
    const h = setup(f, { entry: { baseUrl: 'https://llm.example.com/v1', keyless: false }, turn: say('hello from remote') });
    let sawTaintInPreamble: boolean | undefined;
    h.engine.setModules([{ id: 'probe', preamble: (_a: any, ctx: any) => { sawTaintInPreamble = ctx.tainted; return ''; } } as any]);
    const t = await run(h);
    assert.equal(t.status, 'done');
    assert.equal(t.tainted, true, 'the stored task');
    assert.equal(h.engine.isTainted(t.id), true);
    assert.equal(sawTaintInPreamble, true, 'taint is set before the prompt is built');
    h.store.agents.set('a2', mkAgent({ id: 'a2', name: 'Beta', model: 'sonnet' }));
    const reply = h.engine.startTask({ agentId: 'a2', prompt: 'result', source: 'bot', bridge: { fromAgentId: 'a1', fromTaskId: t.id, reply: true, hop: 1 } } as any);
    assert.equal(reply.tainted, true, 'a bridged reply from the tainted run taints the receiving task');
    // the same run on a trusted endpoint stays clean
    const h2 = setup(f, { entry: { baseUrl: 'https://llm.example.com/v1', keyless: false, trusted: true }, turn: say('ok') });
    const t2 = await run(h2);
    assert.equal(t2.status, 'done'); assert.notEqual(t2.tainted, true);
  } finally { await f.close(); }
});

test('A3 a loopback or preset endpoint stays untainted in a real run', async () => {
  const f = await startFake((_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] })); });
  try {
    const h = setup(f, { turn: say('plain') });
    const t = await run(h);
    assert.equal(t.status, 'done'); assert.notEqual(t.tainted, true);
  } finally { await f.close(); }
});
void entryFor;
