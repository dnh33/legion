import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp-cleanup.js';
import { ProviderRuntime } from '../src/core/providers/runtime.js';
import { defaultConfig } from '../src/shared/config.js';
import { entryFor, jsonReply, memKeys, provCfg, startFake } from './providers-fakes.js';

// A local server that is up but holds no model: Ollama answers `{"object":"list","data":null}` before the first pull (seen with Ollama 0.40).
async function testWith(body: unknown): Promise<{ ok: boolean; detail: string }> {
  const f = await startFake((_r, res) => jsonReply(res, 200, body));
  try {
    const config = defaultConfig();
    config.providers = provCfg({ loc: entryFor(f) });
    return await new ProviderRuntime({ config, keys: memKeys(tempDir('legion-empty-')) }).test('loc');
  } finally { await f.close(); }
}

test('a server with no models says so, instead of a bare "accepted"', async () => {
  for (const body of [{ object: 'list', data: null }, { object: 'list', data: [] }]) {
    const r = await testWith(body);
    assert.equal(r.ok, true);
    assert.match(r.detail, /no models/i);
    assert.match(r.detail, /accepted/);
  }
});

test('a server with models keeps the count', async () => {
  const r = await testWith({ object: 'list', data: [{ id: 'a' }, { id: 'b' }] });
  assert.match(r.detail, /\(2 model ids listed\)/);
  assert.doesNotMatch(r.detail, /no models/i);
});
