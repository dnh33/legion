import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { createCommsModule } from '../src/core/comms/index.js';
import type { ModuleDeps } from '../src/core/modules.js';
import type { Room, RoomMessage } from '../src/shared/comms.js';
import { makeFakes, start, TOKEN } from './helpers-c.js';
import { makeHarness } from './comms-fakes.test.js';

describe('comms HTTP API', () => {
  const h = makeHarness();
  const f = makeFakes();
  let base = '';
  let close: () => Promise<void>;
  let mod: ReturnType<typeof createCommsModule>;

  before(async () => {
    const deps = {
      config: f.ctx.config, store: h.store, bus: h.bus, engine: h.engine, approvals: f.ctx.approvals, dataDir: h.dir, bsvEnabled: () => false,
    } as unknown as ModuleDeps;
    mod = createCommsModule(deps);
    const s = await start({ ...f.ctx, store: h.store as never, bus: h.bus, engine: h.engine as never, modules: [mod] });
    base = s.base;
    close = s.close;
  });
  after(async () => { await mod.dispose?.(); await close(); });

  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text, headers: res.headers };
  };
  const mk = async (over: Record<string, unknown> = {}): Promise<Room> => {
    const r = await call('POST', '/api/rooms', { name: 'Ops', members: ['zealot', 'scout'], ...over });
    assert.equal(r.status, 201, r.text);
    return r.json;
  };

  it('requires the bearer token', async () => {
    assert.equal((await call('GET', '/api/rooms', undefined, false)).status, 401);
    assert.equal((await call('POST', '/api/rooms', { name: 'x', members: [] }, false)).status, 401);
  });

  it('POST /api/rooms creates (201) with defaults; GET lists; GET :id returns room + messages', async () => {
    const room = await mk({ strategy: 'manager', guards: { maxHops: 4 } });
    assert.equal(room.kind, 'group');
    assert.equal(room.strategy, 'manager');
    assert.equal(room.lead, 'zealot');
    assert.equal(room.guards.maxHops, 4);
    assert.equal(room.guards.budgetUsd, 2);
    const list = await call('GET', '/api/rooms');
    assert.equal(list.status, 200);
    assert.ok(list.json.some((r: Room) => r.id === room.id));
    const one = await call('GET', `/api/rooms/${room.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.json.room.id, room.id);
    assert.deepEqual(one.json.messages, []);
  });

  it('POST /api/rooms validation: 400s', async () => {
    const bad = async (body: unknown) => assert.equal((await call('POST', '/api/rooms', body)).status, 400, JSON.stringify(body));
    await bad(undefined);
    await bad('not json{');
    await bad([]);
    await bad({ members: ['zealot', 'scout'] });
    await bad({ name: 'x' });
    await bad({ name: 'x', members: 'zealot' });
    await bad({ name: 'x', members: [1, 2] });
    await bad({ name: 'x', members: ['zealot'] });
    await bad({ name: 'x', members: ['zealot', 'ghost'] });
    await bad({ name: 'x', members: ['zealot', 'scout'], strategy: 'nope' });
    await bad({ name: 'x', members: ['zealot', 'scout'], guards: 'no' });
    await bad({ name: 'x', members: ['zealot', 'scout'], guards: { maxHops: 'many' } });
    await bad({ name: 'x', members: ['zealot', 'scout'], lead: 'builder' });
    await bad({ name: '   ', members: ['zealot', 'scout'] });
  });

  it('GET /api/rooms/:id: 404 for unknown rooms', async () => {
    const r = await call('GET', '/api/rooms/room_nope');
    assert.equal(r.status, 404);
    assert.match(r.json.error, /Unknown room/);
  });

  it('GET /api/rooms/:id returns the last 200 messages only', async () => {
    const room = await mk({ name: 'Long' });
    await call('POST', `/api/rooms/${room.id}/freeze`);
    for (let i = 0; i < 205; i++) await call('POST', `/api/rooms/${room.id}/messages`, { text: `m${i}` });
    const r = await call('GET', `/api/rooms/${room.id}`);
    const msgs: RoomMessage[] = r.json.messages;
    assert.equal(msgs.length, 200);
    assert.equal(msgs.at(-1)!.text, 'm204');
  });

  it('PATCH /api/rooms/:id updates fields; 400 on invalid values; 404 unknown', async () => {
    const room = await mk();
    const ok = await call('PATCH', `/api/rooms/${room.id}`, { name: 'Renamed', strategy: 'round-robin', lead: 'scout', guards: { budgetUsd: 9 } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.name, 'Renamed');
    assert.equal(ok.json.strategy, 'round-robin');
    assert.equal(ok.json.lead, 'scout');
    assert.equal(ok.json.guards.budgetUsd, 9);
    for (const body of [{ strategy: 'x' }, { lead: 'builder' }, { name: '' }, { guards: { maxHops: -1 } }, { name: 5 }, { guards: [] }, undefined]) {
      const r = await call('PATCH', `/api/rooms/${room.id}`, body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal((await call('PATCH', '/api/rooms/room_nope', { name: 'x' })).status, 404);
  });

  it('DELETE /api/rooms/:id removes the room; 404 afterwards', async () => {
    const room = await mk();
    assert.deepEqual((await call('DELETE', `/api/rooms/${room.id}`)).json, { ok: true });
    assert.equal((await call('GET', `/api/rooms/${room.id}`)).status, 404);
    assert.equal((await call('DELETE', `/api/rooms/${room.id}`)).status, 404);
  });

  it('POST /api/rooms/:id/members adds and removes; validates', async () => {
    const room = await mk();
    const add = await call('POST', `/api/rooms/${room.id}/members`, { add: ['builder'] });
    assert.equal(add.status, 200);
    assert.deepEqual(add.json.members, ['zealot', 'scout', 'builder']);
    const rm = await call('POST', `/api/rooms/${room.id}/members`, { remove: ['zealot'] });
    assert.deepEqual(rm.json.members, ['scout', 'builder']);
    assert.equal(rm.json.lead, 'scout');
    for (const body of [{ add: 'builder' }, { remove: [1] }, { add: ['ghost'] }, { remove: ['zealot'] }, { remove: ['scout', 'builder'] }, undefined]) {
      assert.equal((await call('POST', `/api/rooms/${room.id}/members`, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await call('POST', '/api/rooms/room_nope/members', { add: ['builder'] })).status, 404);
  });

  it('POST /api/rooms/:id/messages stores a human message (201) and wakes the lead through the engine', async () => {
    const room = await mk({ name: 'Wake' });
    const before = h.engine.starts.length;
    const r = await call('POST', `/api/rooms/${room.id}/messages`, { text: 'hello @scout' });
    assert.equal(r.status, 201);
    assert.equal(r.json.from.kind, 'human');
    assert.equal(r.json.hop, 0);
    assert.deepEqual(r.json.to, ['scout']);
    assert.equal(h.engine.starts.length, before + 1);
    assert.equal(h.engine.last('scout').source, 'bot');
    const got = await call('GET', `/api/rooms/${room.id}`);
    assert.equal(got.json.messages.length, 1);
    for (const body of [{}, { text: '' }, { text: 7 }, undefined, []]) {
      assert.equal((await call('POST', `/api/rooms/${room.id}/messages`, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await call('POST', '/api/rooms/room_nope/messages', { text: 'x' })).status, 404);
  });

  it('freeze and resume', async () => {
    const room = await mk({ name: 'Freeze' });
    await call('POST', `/api/rooms/${room.id}/messages`, { text: '@scout work' });
    const taskId = h.engine.last('scout').taskId;
    const fr = await call('POST', `/api/rooms/${room.id}/freeze`);
    assert.equal(fr.status, 200);
    assert.equal(fr.json.paused.reason, 'frozen');
    assert.ok(h.engine.cancels.includes(taskId));
    const before = h.engine.starts.length;
    await call('POST', `/api/rooms/${room.id}/messages`, { text: '@scout still there?' });
    assert.equal(h.engine.starts.length, before);
    const rs = await call('POST', `/api/rooms/${room.id}/resume`);
    assert.equal(rs.status, 200);
    assert.equal(rs.json.paused, undefined);
    assert.equal(rs.json.hopsSinceHuman, 0);
    assert.equal((await call('POST', '/api/rooms/room_nope/freeze')).status, 404);
    assert.equal((await call('POST', '/api/rooms/room_nope/resume')).status, 404);
  });

  it('GET /api/rooms/:id/export in md and json; 400 on a bad format; 404 unknown', async () => {
    const room = await mk({ name: 'Export me' });
    await call('POST', `/api/rooms/${room.id}/messages`, { text: 'hello there' });
    const md = await call('GET', `/api/rooms/${room.id}/export?format=md`);
    assert.equal(md.status, 200);
    assert.match(md.headers.get('content-type') ?? '', /text\/markdown/);
    assert.match(md.text, /^# Export me/);
    assert.match(md.text, /\*\*You\*\*/);
    assert.match(md.text, /hello there/);
    assert.equal((await call('GET', `/api/rooms/${room.id}/export`)).status, 200, 'format defaults to md');
    const js = await call('GET', `/api/rooms/${room.id}/export?format=json`);
    assert.equal(js.status, 200);
    assert.equal(js.json.room.id, room.id);
    assert.equal(js.json.messages[0].text, 'hello there');
    assert.equal((await call('GET', `/api/rooms/${room.id}/export?format=pdf`)).status, 400);
    assert.equal((await call('GET', '/api/rooms/room_nope/export?format=md')).status, 404);
  });

  it('GET /api/rooms/search?q= finds messages and rooms; 400 without q (not captured by :id)', async () => {
    const room = await mk({ name: 'Searchable Room' });
    await call('POST', `/api/rooms/${room.id}/messages`, { text: 'the quokka is the happiest animal' });
    const r = await call('GET', '/api/rooms/search?q=QUOKKA');
    assert.equal(r.status, 200);
    assert.equal(r.json.messages.length, 1);
    assert.equal(r.json.messages[0].roomId, room.id);
    const byName = await call('GET', '/api/rooms/search?q=searchable');
    assert.equal(byName.json.rooms.length, 1);
    assert.equal((await call('GET', '/api/rooms/search')).status, 400);
    assert.equal((await call('GET', '/api/rooms/search?q=%20')).status, 400);
  });

  it('wrong methods answer 405', async () => {
    const room = await mk();
    assert.equal((await call('PUT', `/api/rooms/${room.id}`, {})).status, 405);
    assert.equal((await call('GET', `/api/rooms/${room.id}/freeze`)).status, 405);
  });

  it('guard messages are visible through the API after a trip', async () => {
    const room = await mk({ name: 'Hops', guards: { maxHops: 1 } });
    await call('POST', `/api/rooms/${room.id}/messages`, { text: '@zealot go' });
    h.engine.finish(h.engine.last('zealot').taskId, '@scout one');
    h.engine.finish(h.engine.last('scout').taskId, '@zealot two');
    const got = await call('GET', `/api/rooms/${room.id}`);
    assert.equal(got.json.room.paused.reason, 'max-hops');
    assert.ok(got.json.messages.some((m: RoomMessage) => m.kind === 'guard'));
  });
});
