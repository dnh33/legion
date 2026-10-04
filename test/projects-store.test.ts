/** Project store: limits, atomic file, corrupt file, folder rules, migration and downgrade (controls C8, C13, C18). */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { ProjectError, ProjectStore, validateFolder } from '../src/core/projects/store.js';
import { Store } from '../src/core/store.js';
import { RoomStore } from '../src/core/comms/rooms.js';
import { PROJECT_LIMITS, projectIdOfScope, projectScope } from '../src/shared/projects.js';
import { Graph } from '../src/core/kg/graph.js';
import { agentActor, HUMAN } from '../src/core/kg/types.js';
import { slugify } from '../src/shared/util.js';

const mk = () => {
  const root = cleanupTemp('legion-proj-store-');
  const data = join(root, 'data');
  const ws = join(data, 'workspaces');
  return { root, data, ws, store: new ProjectStore(data, ws) };
};

test('C18 create / update / members: names and text are cleaned and limited, the default folder is under the workspace', async () => {
  const { store, ws } = mk();
  const p = store.create({ name: '  My\n project  ', instructions: 'Line 1\r\nLine 2\u0000‮' });
  assert.equal(p.name, 'My project');
  assert.equal(p.instructions, 'Line 1\nLine 2');
  assert.equal(p.status, 'active');
  assert.deepEqual(p.members, []);
  assert.equal(p.folder, join(ws, 'projects', p.id));
  assert.match(p.id, /^proj_[a-f0-9]{12}$/);
  assert.throws(() => store.create({ name: '' }), ProjectError);
  assert.throws(() => store.create({ name: 'x'.repeat(PROJECT_LIMITS.nameChars + 1) }), ProjectError);
  assert.throws(() => store.create({ name: 5 as any }), ProjectError);
  assert.equal(store.update(p.id, { instructions: 'y'.repeat(99_999) }).instructions.length, PROJECT_LIMITS.instructionsChars);
  assert.throws(() => store.update(p.id, { status: 'deleted' }), ProjectError);
  assert.throws(() => store.update('proj_000000000000', { name: 'x' }), (e: any) => e.status === 404);
  assert.deepEqual(store.setMembers(p.id, ['a', 'a', 'b']).members, ['a', 'b'], 'deduplicated');
  assert.throws(() => store.setMembers(p.id, Array.from({ length: PROJECT_LIMITS.members + 1 }, (_, i) => 'a' + i)), ProjectError);
  for (let i = 1; i < PROJECT_LIMITS.projects; i++) store.create({ name: 'p' + i });
  assert.throws(() => store.create({ name: 'one too many' }), (e: any) => e.status === 409);
});

test('C18 persistence: atomic write, reload, and a corrupt file is moved aside and the list starts empty', async () => {
  const { store, data, ws } = mk();
  const a = store.create({ name: 'A', instructions: 'i' });
  store.setMembers(a.id, ['zealot']);
  await store.flush();
  const again = new ProjectStore(data, ws);
  assert.deepEqual(again.get(a.id), store.get(a.id));
  assert.ok(!readdirSync(data).some((f) => f.endsWith('.tmp')), 'no temp file left');
  writeFileSync(join(data, 'projects.json'), '{ not json');
  const broken = new ProjectStore(data, ws);
  assert.deepEqual(broken.list(), []);
  assert.ok(readdirSync(data).some((f) => f.startsWith('projects.json.corrupt-')), 'the broken file was kept');
});

test('C13 unknown fields on a project (from a later build) are kept when this build edits it', async () => {
  const { data, ws } = mk();
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'projects.json'), JSON.stringify({ version: 1, futureTop: { x: 1 }, projects: [{
    id: 'proj_0123456789ab', name: 'Old', instructions: '', folder: join(ws, 'projects', 'proj_0123456789ab'), members: ['zealot'], status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', dueDate: '2027-01-01', labels: ['a'],
  }] }));
  const s = new ProjectStore(data, ws);
  s.update('proj_0123456789ab', { name: 'Renamed' });
  await s.flush();
  const file = JSON.parse(readFileSync(join(data, 'projects.json'), 'utf8'));
  assert.equal(file.futureTop.x, 1);
  assert.equal(file.projects[0].dueDate, '2027-01-01');
  assert.deepEqual(file.projects[0].labels, ['a']);
  assert.equal(file.projects[0].name, 'Renamed');
});

test('C13 old data keeps working: no projects.json is an empty list and nothing is written; tasks and rooms keep unknown fields through the old stores', async () => {
  const { data, ws } = mk();
  const s = new ProjectStore(data, ws);
  assert.deepEqual(s.list(), []);
  await s.flush();
  assert.equal(existsSync(join(data, 'projects.json')), false, 'a read-only start writes nothing');
  // an older build's Store (which only knows its own fields) round-trips a task that carries projectId
  const dir = cleanupTemp('legion-proj-old-');
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ agents: [], vms: [], migrations: ['builder-vm-size-default-v1'], tasks: [{
    id: 't1', agentId: 'zealot', title: 'x', status: 'done', source: 'ui', requestedModel: 'auto', createdAt: 'a', updatedAt: 'b', projectId: 'proj_0123456789ab', someFutureField: { y: 2 },
  }] }));
  const store = new Store(dir);
  store.upsertTask({ ...store.getTask('t1')!, title: 'renamed' });
  await store.flush();
  const out = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(out.tasks[0].projectId, 'proj_0123456789ab');
  assert.deepEqual(out.tasks[0].someFutureField, { y: 2 });
  // rooms
  const rd = cleanupTemp('legion-proj-oldroom-');
  mkdirSync(join(rd, 'rooms'), { recursive: true });
  const room = { id: 'room_1', kind: 'group', name: 'R', members: ['a', 'b'], lead: 'a', strategy: 'mention', guards: { maxHops: 6, budgetUsd: 2, cycleRepeats: 3, everyoneCooldownSec: 30 }, costUsd: 0, hopsSinceHuman: 0, createdAt: 'a', updatedAt: 'b', projectId: 'proj_0123456789ab' };
  writeFileSync(join(rd, 'rooms', 'index.json'), JSON.stringify([room]));
  const rs = new RoomStore(rd);
  rs.save({ ...rs.get('room_1')!, name: 'R2' });
  assert.equal(JSON.parse(readFileSync(join(rd, 'rooms', 'index.json'), 'utf8'))[0].projectId, 'proj_0123456789ab');
});

test('C13 the project scope string passes the scope check an older build has and is private-shaped there; it cannot equal any agent id', () => {
  const OLD_SCOPE_RE = /^agent:[A-Za-z0-9_.-]{1,64}$/; // the pre-Projects pattern, copied
  const sc = projectScope('proj_0123456789ab');
  assert.match(sc, OLD_SCOPE_RE, 'an older build accepts the string (and treats it as an agent\'s private scope: hidden from every bot)');
  assert.equal(projectIdOfScope(sc), 'proj_0123456789ab');
  assert.equal(projectIdOfScope('shared'), undefined);
  assert.equal(projectIdOfScope('agent:zealot'), undefined);
  assert.equal(projectIdOfScope('agent:project.nope'), undefined);
  // agent ids come from slugify: no dot, so no agent can own a project scope
  for (const n of ['project.proj_0123456789ab', 'Project.Proj_0123456789AB', 'project proj_0123456789ab']) assert.ok(!slugify(n).includes('.'));
  // the new Graph really hides it from a bot of another project and from a bot with no project, and shows it to the owner
  const g = new Graph({ dir: cleanupTemp('legion-proj-g-'), bsvEnabled: () => false });
  const n = g.upsertNode(HUMAN, { title: 'Project fact', body: 'fact', scope: sc }).node;
  assert.equal(n.scope, sc);
  assert.ok(g.getNode(HUMAN, n.id));
  assert.equal(g.getNode(agentActor('zealot'), n.id), undefined, 'a run with no project cannot read it');
  assert.equal(g.getNode(agentActor('zealot', { projectId: 'proj_ffffffffffff' }), n.id), undefined, 'another project cannot');
  assert.ok(g.getNode(agentActor('zealot', { projectId: 'proj_0123456789ab' }), n.id));
});

test('C8 folder rules: absolute, not a root, not the data folder (or above or inside it, except the projects area), no overlap with another project', async () => {
  const { store, data, ws, root } = mk();
  const a = store.create({ name: 'A' });
  const b = store.create({ name: 'B' });
  const other = join(root, 'elsewhere');
  mkdirSync(other, { recursive: true });
  const reject = (v: unknown, status?: number) => assert.throws(() => store.setFolder(a.id, v), (e: any) => e instanceof ProjectError && (status === undefined || e.status === status), String(v));
  reject('relative/path', 400);
  reject('', 400);
  reject(undefined, 400);
  reject(parse(root).root, 400);
  reject(data, 400);
  reject(join(data, 'kg'), 400);
  reject(join(data, 'config.json'), 400);
  reject(join(data, '..'), 400); // contains the data folder
  reject(ws, 400); // the workspace root holds the taint list and every agent's workspace
  reject(join(ws, 'projects'), 400);
  // another project's folder, nested or containing
  assert.equal(store.setFolder(b.id, other).folder, resolve(other));
  reject(other, 409);
  reject(join(other, 'inner'), 409);
  reject(root, 400);
  // a folder inside the projects area of the workspace is fine, null = default
  const inArea = join(ws, 'projects', 'mine');
  assert.equal(store.setFolder(a.id, inArea).folder, resolve(inArea));
  assert.equal(store.setFolder(a.id, null).folder, join(ws, 'projects', a.id));
  // validateFolder is pure about the others it is given
  assert.throws(() => validateFolder(other, { dataDir: data, workspaceDir: ws, others: [{ id: 'x', folder: other }] }), ProjectError);
  assert.equal(validateFolder(other, { dataDir: data, workspaceDir: ws, others: [{ id: 'x', folder: other }], selfId: 'x' }), resolve(other));
});

test('forRun: only an active project whose members include the agent', () => {
  const { store } = mk();
  const p = store.create({ name: 'P' });
  assert.equal(store.forRun(p.id, 'a'), undefined);
  store.setMembers(p.id, ['a']);
  assert.equal(store.forRun(p.id, 'a')?.id, p.id);
  assert.equal(store.forRun(p.id, 'b'), undefined);
  assert.equal(store.forRun(undefined, 'a'), undefined);
  store.update(p.id, { status: 'archived' });
  assert.equal(store.forRun(p.id, 'a'), undefined);
});
