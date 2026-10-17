/** The finder model routes: status, get (behind an approval), remove, one download at a time, and admin-only. Fake ports, no network. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gate, isClientRoute } from '../src/core/admin.js';
import { armoryRig } from './armory-rig.js';
import { fileURLToPath } from 'node:url';
import { createFinderModel } from '../src/core/armory/finder/model.js';
import { FINDER_MODEL_TAMPERED } from '../src/shared/finder.js';
import type { FinderModelPin } from '../src/shared/finder.js';
import { fakePorts, PIN, sha } from './finder-model-fakes.js';

const ROUTES: [string, string][] = [['GET', '/api/armory/finder/model'], ['POST', '/api/armory/finder/model/get'], ['DELETE', '/api/armory/finder/model']];

function rigWith(approve: (card: unknown) => Promise<boolean>) {
  const f = fakePorts();
  const r = armoryRig({ modOpts: { finderModel: { ports: f.ports, pin: PIN, approve } } });
  return { f, r };
}

describe('the finder model routes', () => {
  it('are admin-only: not on the client list, and the bearer token alone is refused', () => {
    for (const [method, path] of ROUTES) {
      assert.equal(isClientRoute(method, path), false, `${method} ${path}`);
      assert.equal(gate({ method, path, adminOk: false, bearerOk: true, hasSecret: true }).allow, false, `${method} ${path} with a bearer token`);
      assert.equal(gate({ method, path, adminOk: true, bearerOk: true, hasSecret: true }).allow, true, `${method} ${path} with the admin secret`);
    }
  });

  it('are registered', () => {
    const { r } = rigWith(async () => true);
    for (const [method, path] of ROUTES) assert.ok(r.paths.includes(`${method} ${path}`), `${method} ${path}`);
  });

  it('status starts as not-installed', async () => {
    const { r } = rigWith(async () => true);
    assert.deepEqual(await r.call('GET', '/api/armory/finder/model'), { state: 'not-installed' });
  });

  it('get without an approval downloads nothing and the state stays not-installed', async () => {
    const { r, f } = rigWith(async () => false);
    const out = await r.call('POST', '/api/armory/finder/model/get');
    assert.equal(out.ok, false);
    assert.equal(out.denied, true);
    assert.deepEqual(f.log, []);
    assert.deepEqual(out.status, { state: 'not-installed' });
  });

  it('with no approval broker at all, get is refused and downloads nothing', async () => {
    const f = fakePorts();
    const r = armoryRig({ modOpts: { finderModel: { ports: f.ports, pin: PIN } } });
    const out = await r.call('POST', '/api/armory/finder/model/get');
    assert.equal(out.denied, true);
    assert.deepEqual(f.log, []);
  });

  it('the card carries the address, size, hash, folder, licence and memory use', async () => {
    let card: { summary: string; files: { url: string; sha256: string }[] } | undefined;
    const { r } = rigWith(async (c) => { card = c as typeof card; return false; });
    await r.call('POST', '/api/armory/finder/model/get');
    assert.ok(card);
    assert.ok(card.files.every((x) => card!.summary.includes(x.url) && card!.summary.includes(x.sha256)));
    assert.ok(/about 1 GB of memory/.test(card.summary) && /MIT/.test(card.summary));
  });

  it('get with an approval installs; status says ready with the size; remove returns it to not-installed', async () => {
    const { r, f } = rigWith(async () => true);
    const out = await r.call('POST', '/api/armory/finder/model/get');
    assert.equal(out.ok, true, JSON.stringify(out.steps));
    assert.equal(f.log.length, 3);
    const st = await r.call('GET', '/api/armory/finder/model');
    assert.equal(st.state, 'ready');
    assert.equal(st.bytes, PIN.files.reduce((n, x) => n + x.bytes, 0));
    const gone = await r.call('DELETE', '/api/armory/finder/model');
    assert.deepEqual(gone, { state: 'not-installed' });
    assert.deepEqual(f.keys(), []);
  });

  it('a hash mismatch leaves the state as an error with the reason, and a later good get clears it', async () => {
    let bad = true;
    const f = fakePorts({ serve: (url) => (bad && url.endsWith('b.wasm') ? 'tampered' : ({ 'a.mjs': 'runtime code', 'b.wasm': 'wasm bytes', 'm.onnx': 'model bytes' } as Record<string, string>)[url.split('/').pop()!]!) });
    const r = armoryRig({ modOpts: { finderModel: { ports: f.ports, pin: PIN, approve: async () => true } } });
    const out = await r.call('POST', '/api/armory/finder/model/get');
    assert.equal(out.ok, false);
    const st = await r.call('GET', '/api/armory/finder/model');
    assert.equal(st.state, 'error');
    assert.match(st.error, /sha256/);
    bad = false;
    assert.equal((await r.call('POST', '/api/armory/finder/model/get')).ok, true);
    assert.equal((await r.call('GET', '/api/armory/finder/model')).state, 'ready');
  });

  it('only one download at a time: a second get while the first waits for approval is a 409, and status says downloading', async () => {
    let release!: (v: boolean) => void;
    const { r } = rigWith(() => new Promise<boolean>((res) => { release = res; }));
    const first = r.call('POST', '/api/armory/finder/model/get');
    const st = await r.call('GET', '/api/armory/finder/model');
    assert.equal(st.state, 'downloading');
    await assert.rejects(r.call('POST', '/api/armory/finder/model/get'), (e: { status?: number }) => e.status === 409);
    await assert.rejects(r.call('DELETE', '/api/armory/finder/model'), (e: { status?: number }) => e.status === 409);
    release(false);
    assert.equal((await first).denied, true);
    assert.equal((await r.call('GET', '/api/armory/finder/model')).state, 'not-installed');
  });
});

describe('a model file that changed after the download', () => {
  it('the helper refuses it: the state is an error with the plain text, keywords take over, and removing the model clears it', async () => {
    const pin: FinderModelPin = { ...PIN, files: [{ name: 'tamper', url: 'https://cdn.example.com/tamper', bytes: 3, sha256: sha('abc'), role: 'runtime' }] };
    const f = fakePorts({ serve: () => 'abc' });
    const model = createFinderModel({ dataDir: '/data' }, { ports: f.ports, pin, approve: async () => true, worker: { workerPath: fileURLToPath(new URL('./finder-fake-worker.js', import.meta.url)) } });
    try {
      assert.equal((await model.get()).ok, true);
      assert.equal(model.status().state, 'ready');
      const emb = model.embedder()!;
      await assert.rejects(emb.embed(['x'], new AbortController().signal), /does not match/);
      assert.deepEqual(model.status(), { state: 'error', error: FINDER_MODEL_TAMPERED });
      assert.equal(FINDER_MODEL_TAMPERED, 'The model files changed on your computer. Remove the model and get it again.');
      assert.equal(model.ready(), false);
      assert.equal(model.embedder(), undefined, 'the finder gets no embedder, so it ranks by keywords');
      assert.deepEqual(model.remove(), { state: 'not-installed' });
    } finally { model.dispose(); }
  });
});
