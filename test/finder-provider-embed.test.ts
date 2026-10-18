/** The provider embedder against a scripted OpenAI-compatible server on 127.0.0.1: the request, the answer, the failures. No real provider. */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderEmbedder, resetProviderEmbedBackoff } from '../src/core/armory/finder/provider-embed.js';
import { ProviderRuntime } from '../src/core/providers/runtime.js';
import { ProviderKeys } from '../src/core/providers/secrets.js';
import { entryFor, FAKE_KEY, jsonReply, memKeys, startFake } from './providers-fakes.js';
import type { Fake } from './providers-fakes.js';
import { tempDir } from './tmp-cleanup.js';

const open: Fake[] = [];
beforeEach(() => resetProviderEmbedBackoff());
afterEach(async () => { while (open.length) await open.pop()!.close(); });
const fake = async (h: Parameters<typeof startFake>[0]): Promise<Fake> => { const f = await startFake(h); open.push(f); return f; };
const sig = (): AbortSignal => new AbortController().signal;
const embedBody = (n: number, dim = 4) => ({ object: 'list', data: Array.from({ length: n }, (_, i) => ({ object: 'embedding', index: i, embedding: Array.from({ length: dim }, (_, k) => (k === i % dim ? 3 : 0)) })) });

describe('provider embeddings', () => {
  it('posts model and input to /embeddings and returns unit vectors in order', async () => {
    const f = await fake((req, res) => jsonReply(res, 200, embedBody(2)));
    const e = createProviderEmbedder({ target: { entry: entryFor(f) }, providerId: 'local', model: 'embed-small' });
    assert.equal(e.id, 'provider:local:embed-small');
    const out = await e.embed(['first text', 'second text'], sig(), 'query');
    assert.equal(f.requests.length, 1);
    const r = f.requests[0]!;
    assert.equal(r.method, 'POST');
    assert.equal(r.url, '/v1/embeddings');
    assert.deepEqual(r.body, { model: 'embed-small', input: ['first text', 'second text'] });
    assert.equal(out.length, 2);
    assert.deepEqual([...out[0]!], [1, 0, 0, 0]);
    assert.deepEqual([...out[1]!], [0, 1, 0, 0]);
  });

  it('puts the answer in order by the index the provider gives', async () => {
    const f = await fake((req, res) => jsonReply(res, 200, { data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [2, 0] }] }));
    const out = await createProviderEmbedder({ target: { entry: entryFor(f) }, providerId: 'p', model: 'm' }).embed(['a', 'b'], sig());
    assert.deepEqual([...out[0]!], [1, 0]);
    assert.deepEqual([...out[1]!], [0, 1]);
  });

  it('sends the saved key to the origin it was saved for, as every provider call does', async () => {
    const f = await fake((req, res) => jsonReply(res, 200, embedBody(1)));
    const dir = tempDir('finder-pe-');
    const keys = memKeys(dir);
    keys.set('local', FAKE_KEY, f.base);
    const rt = new ProviderRuntime({ config: { providers: { entries: { local: entryFor(f, { keyless: false, allowPrivateNetwork: true }) }, maxTurns: 10, maxToolCallsPerTurn: 10 } } as never, keys, cacheFile: `${dir}/m.json` });
    const target = rt.targetFor('local');
    assert.ok(target);
    await createProviderEmbedder({ target, providerId: 'local', model: 'm' }).embed(['x'], sig());
    assert.equal(f.requests[0]!.headers.authorization, `Bearer ${FAKE_KEY}`);
  });

  it('targetFor: undefined for an unknown provider and for one that is turned off', () => {
    const dir = tempDir('finder-pe-');
    const rt = new ProviderRuntime({
      config: { providers: { entries: { off: { kind: 'openai-compat', label: 'Off', baseUrl: 'https://example.com/v1', enabled: false }, on: { kind: 'openai-compat', label: 'On', baseUrl: 'https://example.com/v1', enabled: true } }, maxTurns: 10, maxToolCallsPerTurn: 10 } } as never,
      keys: new ProviderKeys(`${dir}/k.json`), cacheFile: `${dir}/m.json`,
    });
    assert.equal(rt.targetFor('nope'), undefined);
    assert.equal(rt.targetFor('off'), undefined);
    assert.ok(rt.targetFor('on'));
  });

  it('rejects when the count is wrong, a vector is not numbers, or the sizes differ', async () => {
    const bodies: unknown[] = [embedBody(1), { data: [{ embedding: 'x' }, { embedding: [1] }] }, { data: [{ embedding: [1, 2] }, { embedding: [1] }] }, { nope: true }];
    let n = 0;
    const f = await fake((req, res) => jsonReply(res, 200, bodies[n++]));
    const e = createProviderEmbedder({ target: { entry: entryFor(f) }, providerId: 'p', model: 'm' });
    for (let i = 0; i < bodies.length; i++) await assert.rejects(e.embed(['a', 'b'], sig()), /embedding|number|sizes/, `body ${i}`);
  });

  it('rejects on an HTTP error, on a body that is not JSON and on a stream', async () => {
    let n = 0;
    const f = await fake((req, res) => {
      n++;
      if (n === 1) { jsonReply(res, 500, { error: { message: 'boom' } }); return; }
      if (n === 2) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('hi'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {}\n\n');
    });
    const e = createProviderEmbedder({ target: { entry: entryFor(f) }, providerId: 'p', model: 'm', backoffMs: 0 });
    await assert.rejects(e.embed(['a'], sig()), /boom/);
    await assert.rejects(e.embed(['a'], sig()), /JSON/);
    await assert.rejects(e.embed(['a'], sig()));
  });

  it('a turned-off provider and a missing key are refused before any request', async () => {
    const f = await fake((req, res) => jsonReply(res, 200, embedBody(1)));
    const off = createProviderEmbedder({ target: { entry: entryFor(f, { enabled: false }) }, providerId: 'p', model: 'm', backoffMs: 0 });
    await assert.rejects(off.embed(['a'], sig()), /turned off/);
    const noKey = createProviderEmbedder({ target: { entry: entryFor(f, { keyless: false }) }, providerId: 'p', model: 'm', backoffMs: 0 });
    await assert.rejects(noKey.embed(['a'], sig()), /No API key/);
    assert.equal(f.requests.length, 0);
  });

  it('the caller can cancel: an aborted signal rejects while the server is still thinking', async () => {
    const f = await fake(() => new Promise(() => undefined));
    const ac = new AbortController();
    const p = createProviderEmbedder({ target: { entry: entryFor(f) }, providerId: 'p', model: 'm' }).embed(['a'], ac.signal);
    setTimeout(() => ac.abort(), 60);
    await assert.rejects(p, /Cancelled/);
  });

  it('an empty list sends nothing', async () => {
    const f = await fake((req, res) => jsonReply(res, 200, embedBody(0)));
    assert.deepEqual(await createProviderEmbedder({ target: { entry: entryFor(f) }, providerId: 'p', model: 'm' }).embed([], sig()), []);
    assert.equal(f.requests.length, 0);
  });

  it('a wrong item count or an error closes the door for 10 minutes: no call, one log line, then one batch is tried again', async () => {
    let status = 200;
    const f = await fake((req, res) => (status === 200 ? jsonReply(res, 200, embedBody(1)) : jsonReply(res, 500, { error: 'no' })));
    let t = 5_000_000;
    const logs: string[] = [];
    const mk = () => createProviderEmbedder({ target: { entry: entryFor(f) }, providerId: 'bo', model: 'm1', now: () => t, log: (l) => logs.push(l) });
    // Asked for two vectors, the provider sends one: wrong count.
    await assert.rejects(mk().embed(['a', 'b'], sig(), 'passage'), /wrong number/);
    assert.equal(f.requests.length, 1);
    for (let i = 0; i < 6; i++) await assert.rejects(mk().embed(['a', 'b'], sig(), 'passage'), /not asked for again/);
    await assert.rejects(mk().embed(['q'], sig(), 'query'), /not asked for again/);
    assert.equal(f.requests.length, 1, 'a new embedder per turn still sees the back-off');
    assert.equal(logs.length, 1);
    // Another model is its own door.
    await createProviderEmbedder({ target: { entry: entryFor(f) }, providerId: 'bo', model: 'm2', now: () => t }).embed(['a'], sig());
    assert.equal(f.requests.length, 2);
    t += 10 * 60_000 + 1;
    status = 500;
    await assert.rejects(mk().embed(['a', 'b'], sig(), 'passage'));
    assert.equal(f.requests.length, 3, 'after the 10 minutes one batch goes out');
    await assert.rejects(mk().embed(['a', 'b'], sig(), 'passage'), /not asked for again/);
    assert.equal(f.requests.length, 3, 'and an error closes the door again');
  });
});
