/**
 * The agent-shell Settings control (AgentProfile.host): POST/PATCH /api/agents carry { enabled, rootDir,
 * timeoutSeconds } through to the store the engine reads (buildMcpServers' agent.host?.enabled opt-in gate),
 * a present host always says `enabled` explicitly, and bad values are a 400 — never a silently clamped surprise.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { makeFakes, start, AUTH } from './helpers-c.js';

describe('agent shell settings (AgentProfile.host)', () => {
  const f = makeFakes();
  let base = '';
  let close: () => Promise<void>;
  before(async () => { const s = await start(f.ctx); base = s.base; close = s.close; });
  after(async () => { await close(); });

  const api = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { ...AUTH, 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) } });
  const post = async (body: unknown) => api('/api/agents', { method: 'POST', body: JSON.stringify(body) });
  const patch = async (id: string, body: unknown) => api(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

  it('POST and PATCH carry the full host block; turning it off replaces it; a patch without host leaves it alone', async () => {
    const created = await (await post({ name: 'Shelltest', host: { enabled: true, rootDir: 'D:/work/site', timeoutSeconds: 300 } })).json();
    assert.deepEqual(created.host, { enabled: true, rootDir: 'D:/work/site', timeoutSeconds: 300 }, 'stored exactly as sent — the engine gate reads this');
    const id = created.id as string;
    const off = await (await patch(id, { host: { enabled: false } })).json();
    assert.deepEqual(off.host, { enabled: false }, 'the whole block is replaced, never merged');
    const kept = await (await patch(id, { description: 'still here' })).json();
    assert.deepEqual(kept.host, { enabled: false }, 'a patch without a host key leaves the stored block untouched');
    const trimmed = await (await patch(id, { host: { enabled: true, rootDir: '  D:/work/site  ' } })).json();
    assert.deepEqual(trimmed.host, { enabled: true, rootDir: 'D:/work/site' }, 'rootDir is trimmed; timeout may be absent');
  });

  it('a present host must say enabled; rootDir and timeoutSeconds are range-checked with a 400', async () => {
    for (const host of [
      { rootDir: 'x' },                              // no enabled
      { enabled: 'yes' },                            // not a boolean
      'yes',                                         // not an object
      { enabled: true, timeoutSeconds: 0 },          // below range
      { enabled: true, timeoutSeconds: 3601 },       // above range
      { enabled: true, timeoutSeconds: 1.5 },        // not whole seconds
      { enabled: true, rootDir: '' },                // empty path
    ]) {
      const r = await post({ name: 'Bad', host });
      assert.equal(r.status, 400, JSON.stringify(host));
    }
  });

  it('an agent created without host has none at all: the engine opt-in gate stays closed', async () => {
    const a = await (await post({ name: 'NoHost' })).json();
    assert.equal(a.host, undefined);
    const fakes = f.ctx.store.getAgent(a.id);
    assert.equal(fakes?.host, undefined, 'stored profile carries no host key');
  });

  it('host.envFiles is allow, masked or block; anything else is a 400', async () => {
    const a = await (await post({ name: 'EnvTest', host: { enabled: true, envFiles: 'block' } })).json();
    assert.deepEqual(a.host, { enabled: true, envFiles: 'block' });
    const r = await post({ name: 'EnvBad', host: { enabled: true, envFiles: 'sometimes' } });
    assert.equal(r.status, 400);
  });
});

