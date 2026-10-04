/** Rooms that belong to a project (control C16). */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/core/projects/store.js';
import type { RoomRequest } from '../src/core/comms/hub.js';
import { makeHarness } from './comms-fakes.test.js';

function setup(hub: Parameters<typeof makeHarness>[0] = {}) {
  const root = cleanupTemp('legion-proj-rooms-');
  const projects = new ProjectStore(join(root, 'data'), join(root, 'data', 'ws'));
  const seen: RoomRequest[] = [];
  const h = makeHarness({ ...hub, hub: { projects, approve: async (r: RoomRequest) => { seen.push(r); return true; }, ...(hub.hub ?? {}) } });
  const started: any[] = [];
  const orig = h.engine.startTask.bind(h.engine);
  h.engine.startTask = ((p: any) => { started.push(p); return orig(p); }) as typeof h.engine.startTask;
  const p = projects.setMembers(projects.create({ name: 'Crew' }).id, ['zealot', 'scout', 'builder']);
  return { h, projects, p, seen, started };
}
const tick = () => new Promise((r) => setImmediate(r));

test('C16 a room joins a project only if the project is active and every member of the room is a member of the project', () => {
  const { h, projects, p } = setup();
  const room = h.hub.createRoom({ name: 'In project', members: ['zealot', 'scout'], projectId: p.id });
  assert.equal(room.projectId, p.id);
  assert.throws(() => h.hub.createRoom({ name: 'Outsider', members: ['zealot', 'ranger'], projectId: p.id }), (e: any) => e.status === 400 && /not in project/.test(e.message));
  assert.throws(() => h.hub.createRoom({ name: 'Ghost', members: ['zealot', 'scout'], projectId: 'proj_000000000000' }), (e: any) => e.status === 404);
  const plain = h.hub.createRoom({ name: 'Plain', members: ['zealot', 'ranger'] });
  assert.equal(plain.projectId, undefined);
  assert.throws(() => h.hub.updateRoom(plain.id, { projectId: p.id }), (e: any) => e.status === 400, 'assigning a room with an outsider is refused');
  const fit = h.hub.createRoom({ name: 'Fit', members: ['scout', 'builder'] });
  assert.equal(h.hub.updateRoom(fit.id, { projectId: p.id }).projectId, p.id);
  assert.equal(h.hub.updateRoom(fit.id, { projectId: null }).projectId, undefined, 'cleared');
  projects.update(p.id, { status: 'archived' });
  assert.throws(() => h.hub.updateRoom(fit.id, { projectId: p.id }), (e: any) => e.status === 409);
});

test('C16 a project room keeps its members inside the project: the owner\'s add is refused, and a bot\'s add is refused before any card is shown', async () => {
  const { h, p, seen } = setup();
  const room = h.hub.createRoom({ name: 'In project', members: ['zealot', 'scout'], projectId: p.id });
  assert.throws(() => h.hub.updateMembers(room.id, { add: ['ranger'] }), (e: any) => e.status === 400 && /not in project/.test(e.message));
  assert.deepEqual(h.hub.getRoom(room.id).members, ['zealot', 'scout']);
  await assert.rejects(h.hub.botAddMember('zealot', room.id, 'ranger', { taskId: 'task_1' }), /not in project/);
  await tick();
  assert.equal(seen.length, 0, 'the owner was not even asked');
  // a member of the project can be added (the bot asks, the owner allows)
  const added = await h.hub.botAddMember('zealot', room.id, 'builder', { taskId: 'task_1' });
  assert.ok(added.members.includes('builder'));
  assert.equal(seen.length, 1);
});

test('C16 a bot\'s room_create has no project, and a room wake carries the room\'s project (null for a room with none)', async () => {
  const { h, p, started } = setup();
  const botRoom = await h.hub.botCreateRoom('zealot', { name: 'Bot room', members: ['scout', 'builder'] }, { taskId: 'task_1' });
  assert.equal(botRoom.projectId, undefined);
  const room = h.hub.createRoom({ name: 'In project', members: ['zealot', 'scout'], projectId: p.id });
  h.hub.postHuman(room.id, 'hello @scout');
  await tick();
  const wake = started.find((s) => s.agentId === 'scout' && s.source === 'bot');
  assert.ok(wake, 'a wake happened');
  assert.equal(wake.projectId, p.id);
  const other = h.hub.createRoom({ name: 'Outside', members: ['zealot', 'ranger'] });
  h.hub.postHuman(other.id, 'hello @ranger');
  await tick();
  const w2 = started.find((s) => s.agentId === 'ranger' && s.source === 'bot');
  assert.equal(w2.projectId, null);
});
