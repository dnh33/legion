import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildChildEnv } from '../src/core/engine.js';
import { keyFileFor } from '../src/core/providers/secrets.js';
import { defaultConfig } from '../src/shared/config.js';
import { FAKE_KEY, jsonReply, replyText, replyTools, startFake } from './providers-fakes.js';
import { run, setup } from './providers-harness.js';

/** A key with no recognisable prefix: only the exact-value redaction can catch it. */
const PLAIN_KEY = 'plain' + 'Secret0123456789ABCDEF';

test('C4 and C5 a key the provider echoes back in an error or a tool result never reaches a task, a message, an event or the stored files', async () => {
  let n = 0;
  const f = await startFake((r, res) => {
    n++;
    if (r.body.model === 'echo-error') { jsonReply(res, 401, { error: { message: `Incorrect API key provided: ${PLAIN_KEY}. Also ${FAKE_KEY}` } }); return; }
    if (n % 2 === 1) replyTools(res, [{ id: 'x', name: 'mcp__legion__vm_exec', args: { command: 'env' } }]); else replyText(res, `the key is ${PLAIN_KEY}`);
  });
  try {
    for (const model of ['echo-error', 'echo-tool']) {
      const h = setup(f, { vm: true, entry: { keyless: false }, agent: { model: `fake:${model}`, approval: 'full' } });
      h.keys.set('fake', PLAIN_KEY, f.base);
      (h.engine as any).vms.exec = async () => ({ exitCode: 0, stdout: `API_KEY=${PLAIN_KEY}`, stderr: '' });
      const t = await run(h);
      const everything = JSON.stringify([t, h.store.listMessages(t.id), h.events, [...h.store.tasks.values()]]);
      assert.equal(everything.includes(PLAIN_KEY), false, `${model}: the exact key`);
      assert.equal(everything.includes(FAKE_KEY), false, `${model}: a key-shaped value`);
      assert.equal(t.status, model === 'echo-error' ? 'error' : 'done');
      // what the provider was sent never carried the key in a message either (it only ever sits in the Authorization header)
      for (const req of f.requests) assert.equal(JSON.stringify(req.body).includes(PLAIN_KEY), false);
    }
    // the request that used the key carried it only as the Authorization header
    assert.equal(f.requests[0]!.headers.authorization, `Bearer ${PLAIN_KEY}`);
  } finally { await f.close(); }
});

test('C4b Legion never puts a stored provider key into a child process environment', () => {
  const cfg = defaultConfig();
  const env = buildChildEnv(cfg);
  assert.equal(Object.values(env).some((v) => typeof v === 'string' && (v.includes(PLAIN_KEY) || v.includes(FAKE_KEY))), false);
  assert.match(keyFileFor('/x/data').replace(/\\/g, '/'), /\/providers\/keys\.json$/);
  assert.equal(JSON.stringify(cfg).includes('apiKey'), false, 'the default config has no key field for providers');
});

test('the key file is the only file that holds a key, and a stale file path does not leak through the view', async () => {
  const f = await startFake((_r, res) => replyText(res, 'ok'));
  try {
    const h = setup(f, { entry: { keyless: false } });
    h.keys.set('fake', PLAIN_KEY, f.base);
    await run(h);
    assert.equal(JSON.stringify(h.providers.view()).includes(PLAIN_KEY), false);
    assert.equal(readFileSync(keyFileFor(String(h.keys['file' as keyof typeof h.keys]).replace(/[\\/]providers[\\/]keys\.json$/, '')), 'utf8').includes(PLAIN_KEY), true);
    assert.equal(JSON.stringify(h.config).includes(PLAIN_KEY), false);
  } finally { await f.close(); }
});
