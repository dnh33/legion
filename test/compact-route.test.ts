/**
 * POST /api/tasks/:id/compact - the route the "Compact now" button and the /compact command call.
 *
 * The UI was written first, against an endpoint that did not exist, so every press returned 404. These pin the
 * contract, and the DECLINE paths matter as much as the success one: compaction turned off, a conversation too short
 * to cut, and an unknown task are ordinary outcomes the UI renders, not crashes.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakes, mkAgent, start, AUTH } from './helpers-c.js';
import { newId, nowIso } from '../src/shared/util.js';

const open: Array<() => Promise<void>> = [];
after(async () => { for (const c of open) await c().catch(() => undefined); });

async function setup() {
  const f = makeFakes();
  const srv = await start(f.ctx);
  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const r = await fetch(srv.base + path, {
      method,
      headers: { ...(auth ? { ...AUTH } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  const close = async () => { await srv.close(); };
  open.push(close);
  return { ...f, call, close };
}

test('an unknown task is a 404, not a crash', async () => {
  const { call } = await setup();
  const r = await call('POST', '/api/tasks/nope-not-here/compact', {});
  assert.equal(r.status, 404);
});

test('a conversation that never ran on a provider model declines with a sentence the user can act on', async () => {
  const { ctx, call } = await setup();
  const agent = mkAgent('a1', 'Ada');
  ctx.store.upsertAgent(agent);
  const task = ctx.store.upsertTask({
    id: newId('task'), agentId: 'a1', title: 't', status: 'done', createdAt: nowIso(), updatedAt: nowIso(), requestedModel: 'auto',
  } as never);
  const r = await call('POST', `/api/tasks/${task.id}/compact`, {});
  assert.equal(r.status, 200, 'a decline is a normal outcome, not an HTTP error');
  assert.equal(r.body.ok, false);
  assert.match(r.body.detail, /provider model/i, 'and it says what to do');
});

test('the route is admin-only like every other task-driving route', async () => {
  const { call } = await setup();
  const r = await call('POST', '/api/tasks/whatever/compact', {}, false);
  assert.notEqual(r.status, 200, 'an unauthenticated client cannot make Legion spend a summariser call');
});
