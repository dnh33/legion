import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoatClient, BoatError } from '../src/core/boat.js';

interface Call { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: any }
type Reply = { status?: number; json?: unknown; text?: string };

function fake(handler: (c: Call) => Reply | undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const call: Call = {
      method: init?.method ?? 'GET', path: u.pathname.replace(/^\/api\/v1/, ''), query: u.searchParams,
      headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = handler(call) ?? { status: 404, json: { ok: false, status: 404, code: 'not_found', message: 'nope' } };
    const status = r.status ?? 200;
    return new Response(r.text ?? JSON.stringify(r.json ?? { ok: true }), { status });
  }) as unknown as typeof fetch;
  const client = new BoatClient({ apiKey: 'k_test', baseUrl: 'https://boat.test/api/v1/', fetchImpl, pollMs: 1 });
  return { calls, client };
}

const sb = (state: string, id = 'bx_1') => ({ ok: true, type: 'sandbox.info', sandbox: { id, state, name: 'n' } });

test('create sends auth, idempotency key, parses nested sandbox, renames', async () => {
  const { client, calls } = fake((c) => {
    if (c.method === 'POST' && c.path === '/sandboxes') return { status: 202, json: { ok: true, type: 'sandbox.created', created: { sandbox: { id: 'bx_9', state: 'provisioning' } } } };
    if (c.method === 'PATCH' && c.path === '/sandboxes/bx_9') return { json: sb('provisioning', 'bx_9') };
  });
  const s = await client.create({ type: 'large', ttlSeconds: 1800, name: 'legion-x' });
  assert.equal(s.id, 'bx_9');
  assert.equal(s.state, 'provisioning');
  assert.equal(calls[0].headers.Authorization, 'Bearer k_test');
  assert.ok(calls[0].headers['Idempotency-Key'].length > 8);
  assert.deepEqual(calls[0].body, { type: 'large', ttlSeconds: 1800 });
  assert.deepEqual(calls[1].body, { name: 'legion-x' });
  const again = fake(() => ({ json: sb('ready') }));
  await again.client.create({ idempotencyKey: 'abc' });
  assert.equal(again.calls[0].headers['Idempotency-Key'], 'abc');
});

test('waitUntilReady polls until ready; throws on error state and timeout', async () => {
  let n = 0;
  const a = fake(() => ({ json: sb(++n < 3 ? 'provisioning' : 'ready') }));
  assert.equal((await a.client.waitUntilReady('bx_1')).state, 'ready');
  assert.equal(a.calls.length, 3);
  const b = fake(() => ({ json: { ok: true, sandbox: { id: 'bx_1', state: 'error', error: 'boom' } } }));
  await assert.rejects(b.client.waitUntilReady('bx_1'), /boom/);
  const c = fake(() => ({ json: sb('provisioning') }));
  await assert.rejects(c.client.waitUntilReady('bx_1', 20), (e: unknown) => e instanceof BoatError && e.status === 504);
});

test('exec posts to /commands and parses result', async () => {
  const { client, calls } = fake(() => ({ json: { ok: true, type: 'command.finished', success: true, exitCode: 3, stdout: 'out', stderr: 'err', timedOut: false } }));
  const r = await client.exec('bx_1', 'ls', { cwd: 'x', timeoutSeconds: 5 });
  assert.deepEqual(r, { exitCode: 3, stdout: 'out', stderr: 'err' });
  assert.equal(calls[0].path, '/sandboxes/bx_1/commands');
  assert.deepEqual(calls[0].body, { command: 'ls', cwd: 'x', timeoutSeconds: 5 });
});

test('stop, resume, files, interrupt hit the right endpoints', async () => {
  const { client, calls } = fake((c) => {
    if (c.path.endsWith('/files') && c.method === 'GET') return { json: { ok: true, content: 'aGk=', encoding: 'base64' } };
    return { status: 202, json: { ok: true } };
  });
  await client.stop('bx_1');
  await client.resume('bx_1', { ttlSeconds: 10, type: 'small' });
  assert.equal(await client.readFile('bx_1', '/tmp/a', 'base64'), 'aGk=');
  await client.writeFile('bx_1', '/tmp/a', 'x');
  await client.interrupt('bx_1');
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'POST /sandboxes/bx_1/stop', 'POST /sandboxes/bx_1/resume', 'GET /sandboxes/bx_1/files',
    'PUT /sandboxes/bx_1/files', 'POST /sandboxes/bx_1/interrupt']);
  assert.equal(calls[2].query.get('encoding'), 'base64');
  assert.deepEqual(calls[1].body, { ttlSeconds: 10, type: 'small' });
});

test('error mapping', async () => {
  const mk = (status: number) => fake(() => ({ status, json: { ok: false, status, code: 'x', message: 'msg' } })).client.get('bx_1');
  await assert.rejects(mk(401), (e: any) => e instanceof BoatError && e.status === 401 && /API key rejected/.test(e.message));
  await assert.rejects(mk(402), (e: any) => e.status === 402 && /billing/i.test(e.message));
  await assert.rejects(mk(403), (e: any) => e.status === 403 && /plan limit/i.test(e.message));
  await assert.rejects(mk(404), (e: any) => e.status === 404);
  await assert.rejects(mk(500), (e: any) => e.status === 500 && /msg/.test(e.message));
  // ok:false with 200
  await assert.rejects(fake(() => ({ json: { ok: false, message: 'soft fail', code: 'c' } })).client.get('bx_1'), /soft fail/);
  // non-JSON body
  await assert.rejects(fake(() => ({ status: 502, text: '<html>bad gateway</html>' })).client.get('bx_1'), (e: any) => e.status === 502);
});

test('prompt sends provider claude, model, new/conversationId', async () => {
  const { client, calls } = fake(() => ({ status: 202, json: { ok: true, promptId: 'p1', promptRun: { conversationId: 'c1' } } }));
  const r = await client.prompt('bx_1', { prompt: 'go', model: 'opus', new: true });
  assert.deepEqual(r, { promptId: 'p1', conversationId: 'c1' });
  assert.deepEqual(calls[0].body, { provider: 'claude', prompt: 'go', model: 'opus', new: true });
  await client.prompt('bx_1', { prompt: 'more', conversationId: 'c1' });
  assert.deepEqual(calls[1].body, { provider: 'claude', prompt: 'more', conversationId: 'c1' });
});

test('waitForPrompt polls status then concatenates non-streaming response content for that prompt', async () => {
  let polls = 0;
  const { client, calls } = fake((c) => {
    if (c.path === '/sandboxes/bx_1/prompts/p1') {
      polls++;
      return { json: { ok: true, promptRun: { id: 'p1', status: polls < 3 ? 'running' : 'finished', done: polls >= 3, conversationId: 'c1' } } };
    }
    if (c.path === '/sandboxes/bx_1/events') {
      return { json: { ok: true, events: [
        { id: 'r0', type: 'response', taskId: 'other', data: { content: 'NOPE' } },
        { id: 'r1-tools', type: 'response', taskId: 'p1', data: { content: '', tools: [{}] } },
        { id: 'r1s', type: 'response', taskId: 'p1', data: { content: 'Tes', is_streaming: true } },
        { id: 'r1', type: 'response', taskId: 'p1', data: { content: 'Part one.' } },
        { id: 'r2', type: 'response', taskId: 'p1', data: { content: 'Part two.' } },
      ], pageInfo: { hasMore: false, nextCursor: null } } };
    }
  });
  const r = await client.waitForPrompt('bx_1', 'p1', 5000);
  assert.deepEqual(r, { status: 'finished', text: 'Part one.\n\nPart two.' });
  const ev = calls.find((c) => c.path.endsWith('/events'))!;
  assert.equal(ev.query.get('type'), 'response');
  assert.equal(ev.query.get('conversation'), 'c1');
});

test('waitForPrompt times out and follows pagination', async () => {
  const slow = fake(() => ({ json: { ok: true, promptRun: { status: 'running', done: false } } }));
  await assert.rejects(slow.client.waitForPrompt('bx_1', 'p', 15), (e: any) => e.status === 504);
  let page = 0;
  const { client } = fake((c) => {
    if (c.path.includes('/prompts/')) return { json: { ok: true, promptRun: { status: 'failed', done: true } } };
    page++;
    return { json: { ok: true, events: [{ type: 'response', taskId: 'p', data: { content: `page${page}` } }], pageInfo: { hasMore: page < 2, nextCursor: page < 2 ? 'cur' : null } } };
  });
  assert.deepEqual(await client.waitForPrompt('bx_1', 'p'), { status: 'failed', text: 'page1\n\npage2' });
});

test('desktopUrl polls while provisioning', async () => {
  let n = 0;
  const { client, calls } = fake(() => ({ json: ++n < 3 ? { ok: true, provisioning: true } : { ok: true, desktopUrl: 'https://d/x?t=1' } }));
  assert.equal(await client.desktopUrl('bx_1'), 'https://d/x?t=1');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].method, 'POST');
});

// ---- error codes: one precise message per code ----------------------------------------------------------------------------------
const coded = (status: number, code: string, message: string, apiKey = 'k_test') => {
  const fetchImpl = (async () => new Response(JSON.stringify({ ok: false, status, code, message }), { status })) as unknown as typeof fetch;
  return new BoatClient({ apiKey, baseUrl: 'https://boat.test/api/v1', fetchImpl, pollMs: 1 });
};

test('code api_key_action_forbidden: names the action and says what to do, never "billing"', async () => {
  const c = coded(403, 'api_key_action_forbidden', 'This API key cannot perform sandbox.resume');
  await assert.rejects(c.resume('bx_1'), (e: any) => {
    assert.ok(e instanceof BoatError);
    assert.equal(e.status, 403);
    assert.equal(e.code, 'api_key_action_forbidden');
    assert.equal(e.action, 'sandbox.resume');
    assert.match(e.message, /This boat\.dev API key cannot sandbox\.resume \(resume a stopped VM\): create a full-access key in boat\.dev and paste it in Settings/);
    assert.doesNotMatch(e.message, /billing|limits/i);
    return true;
  });
});

test('code trial_machine_class_not_allowed: says the trial does not allow that size and what to use instead', async () => {
  const c = coded(403, 'trial_machine_class_not_allowed', "8 vCPU / 16 GB 'large' not available during free trial");
  await assert.rejects(c.create({ type: 'large' }), (e: any) => {
    assert.equal(e.code, 'trial_machine_class_not_allowed');
    assert.match(e.message, /free trial.*does not allow that VM size.*Default size/);
    assert.doesNotMatch(e.message, /billing/i);
    return true;
  });
});

test('code provider_not_configured: says Claude is not configured on boat.dev and where to fix it', async () => {
  const c = coded(409, 'provider_not_configured', 'Prompting is locked until Claude is configured on the Agents page.');
  await assert.rejects(c.prompt('bx_1', { prompt: 'x', new: true }), (e: any) => {
    assert.equal(e.code, 'provider_not_configured');
    assert.match(e.message, /^Claude is not configured on boat\.dev: open the Agents page/);
    return true;
  });
});

test('an unknown 403 code keeps the generic wording (plan limit or a missing key permission)', async () => {
  await assert.rejects(coded(403, 'something_else', 'nope').get('bx_1'), (e: any) => e.code === 'something_else' && /plan limit or a missing permission/.test(e.message));
});

test('an error message that echoes the API key is scrubbed', async () => {
  const key = 'bk_live_SECRETSECRET123';
  const c = coded(401, 'bad_key', `invalid key ${key}`, key);
  await assert.rejects(c.get('bx_1'), (e: any) => !e.message.includes(key) && e.message.includes('***'));
  const net = new BoatClient({ apiKey: key, baseUrl: 'https://boat.test', fetchImpl: (async () => { throw new Error(`socket hang up for ${key}`); }) as unknown as typeof fetch });
  await assert.rejects(net.get('bx_1'), (e: any) => e.status === 0 && !e.message.includes(key));
});

test('checkKey: reads and probes a sandbox id that cannot exist, never creates a sandbox, reports each refusal', async () => {
  const { client, calls } = fake((c) => {
    if (c.path === '/me') return { json: { ok: true } };
    if (c.path === '/sandboxes' && c.method === 'GET') return { json: { ok: true, sandboxes: [] } };
    if (c.path.endsWith('/resume')) return { status: 403, json: { ok: false, code: 'api_key_action_forbidden', message: 'This API key cannot perform sandbox.resume' } };
    if (c.path.endsWith('/prompt')) return { status: 409, json: { ok: false, code: 'provider_not_configured', message: 'locked' } };
    return { status: 404, json: { ok: false, code: 'not_found', message: 'no such sandbox' } };
  });
  const r = await client.checkKey();
  assert.equal(r.me.ok, true);
  assert.deepEqual(r.ops.filter((o) => o.status === 'forbidden'), [{ op: 'resume', status: 'forbidden', action: 'sandbox.resume' }]);
  assert.equal(r.ops.find((o) => o.op === 'stop')!.status, 'allowed');
  assert.equal(r.claude, 'not_configured');
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path === '/sandboxes'), 'a probe must never create a sandbox');
  assert.ok(calls.every((c) => c.method === 'GET' || /bx_legion_probe_does_not_exist/.test(c.path)), 'every write probe targets the impossible id');
});

test('checkKey: a rejected key stops at /me; network failure is unknown, never a throw', async () => {
  const bad = fake((c) => (c.path === '/me' ? { status: 401, json: { ok: false, message: 'bad' } } : undefined));
  const r = await bad.client.checkKey();
  assert.equal(r.me.ok, false);
  assert.equal(r.ops.length, 0);
  const down = new BoatClient({ apiKey: 'k', baseUrl: 'https://boat.test', fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
  const d = await down.checkKey();
  assert.equal(d.me.ok, false);
  assert.ok(d.ops.every((o) => o.status === 'unknown'));
});
