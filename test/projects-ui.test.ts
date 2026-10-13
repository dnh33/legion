/** Projects UI logic (pure) and accessible names in the sources (control C19). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project } from '../src/shared/projects.js';
import type { Room } from '../src/shared/comms.js';
import { agentsFor, assignableRooms, inProject, instructionsCounter, INSTRUCTIONS_MAX, memberDiff, newTaskProjectId, projectLabel, resolveFilter, roomsOf, sortProjects, statusLine, taskProjectChip, newTaskTarget } from '../ui/src/projects/projectsLogic.js';

const P = (id: string, name: string, over: Partial<Project> = {}): Project => ({ id, name, instructions: '', folder: '/f', members: [], status: 'active', createdAt: '', updatedAt: '', ...over });
const agents = ['zealot', 'scout', 'builder'].map((id) => ({ id } as any));
const a = P('proj_aaaaaaaaaaaa', 'Alpha', { members: ['scout'] });
const z = P('proj_bbbbbbbbbbbb', 'Zed', { status: 'archived', members: ['zealot'] });

test('switcher: active first, archived last and labelled; an unknown stored choice falls back to All', () => {
  assert.deepEqual(sortProjects([z, P('proj_cccccccccccc', 'Beta'), a]).map((p) => p.name), ['Alpha', 'Beta', 'Zed']);
  assert.equal(projectLabel(z), 'Zed (archived)');
  assert.equal(resolveFilter([a], 'proj_ffffffffffff'), null);
  assert.equal(resolveFilter([a], a.id), a.id);
  assert.equal(resolveFilter([a], null), null);
});

test('All shows everything; a project shows only its members and its own tasks', () => {
  assert.equal(agentsFor(agents, [a], null).length, 3);
  assert.deepEqual(agentsFor(agents, [a], a.id).map((x: any) => x.id), ['scout']);
  assert.equal(inProject({} as any, null), true);
  assert.equal(inProject({ projectId: a.id }, a.id), true);
  assert.equal(inProject({} as any, a.id), false);
  assert.equal(inProject({ projectId: z.id }, a.id), false);
});

test('a new task names the chosen project only when it is active, the agent is a member, and it is not a follow-up', () => {
  assert.equal(newTaskProjectId([a], a.id, 'scout', false), a.id);
  assert.equal(newTaskProjectId([a], a.id, 'scout', true), undefined);
  assert.equal(newTaskProjectId([a], a.id, 'builder', false), undefined);
  assert.equal(newTaskProjectId([a], null, 'scout', false), undefined);
  assert.equal(newTaskProjectId([z], z.id, 'zealot', false), undefined);
});

test('rooms: only ungrouped group rooms whose members all belong to the project can be added', () => {
  const r = (id: string, members: string[], over: Partial<Room> = {}): Room => ({ id, kind: 'group', name: id, members, lead: members[0]!, strategy: 'mention', guards: {} as any, costUsd: 0, hopsSinceHuman: 0, createdAt: '', updatedAt: '', ...over });
  const p = P('proj_dddddddddddd', 'D', { members: ['scout', 'builder'] });
  const rooms = [r('fit', ['scout', 'builder']), r('out', ['scout', 'zealot']), r('taken', ['scout', 'builder'], { projectId: 'proj_x' }), r('mine', ['scout', 'builder'], { projectId: p.id }), r('dm', ['scout', 'builder'], { kind: 'dm' })];
  assert.deepEqual(assignableRooms(rooms, p).map((x) => x.id), ['fit']);
  assert.deepEqual(roomsOf(rooms, p.id).map((x) => x.id), ['mine']);
});

test('helpers: member diff, counter, status line', () => {
  assert.deepEqual(memberDiff(['a', 'b'], ['b', 'c']), { added: ['c'], removed: ['a'] });
  assert.equal(instructionsCounter('abc').over, false);
  assert.equal(instructionsCounter('x'.repeat(INSTRUCTIONS_MAX + 5)).over, true);
  assert.match(instructionsCounter('x'.repeat(INSTRUCTIONS_MAX + 5)).label, /extra 5 will be cut/);
  assert.equal(statusLine(a, 1, 0), 'Active, 1 member, 1 task, 0 rooms');
});

test('C19 every control on the project UI has a visible label or aria-label, selects are labelled, dialogs use Modal, no absolute claims', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const src = (f: string) => readFileSync(join(root, 'ui', 'src', 'projects', f), 'utf8');
  const sw = src('ProjectSwitcher.tsx');
  assert.match(sw, /<label htmlFor="proj-select"/);
  assert.match(sw, /<select id="proj-select"/);
  const view = src('ProjectView.tsx');
  assert.match(view, /aria-label=\{`Remove \$\{a\.name\} from this project`\}/);
  assert.match(view, /aria-labelledby="proj-title"/);
  assert.equal((view.match(/<section [^>]*aria-labelledby=/g) ?? []).length, 6, 'every section is named by its heading');
  assert.match(src('NewProjectDialog.tsx'), /<Modal title="New project"/);
  for (const f of ['ProjectSwitcher.tsx', 'ProjectView.tsx', 'NewProjectDialog.tsx']) assert.doesNotMatch(src(f), /cannot be bypassed|guarantee|100 ?%|fully safe|impossible/i, f);
});

test('council A8: the composer says where a new task goes, and why it is no project when the owner might expect one', () => {
  const ps = [P('p1', 'Site', { members: ['scout'] }), P('p2', 'Old', { status: 'archived', members: ['scout'] })];
  const scout = { id: 'scout', name: 'Scout' };
  const builder = { id: 'builder', name: 'Builder' };
  assert.deepEqual(newTaskTarget(ps, 'p1', scout, false), { label: 'Site' });
  assert.deepEqual(newTaskTarget(ps, null, scout, false), { label: 'No project' }, 'All: a new task has no project');
  assert.match(newTaskTarget(ps, 'p1', builder, false)!.why ?? '', /Builder is not a member of Site/);
  assert.match(newTaskTarget(ps, 'p2', scout, false)!.why ?? '', /Old is archived/);
  assert.equal(newTaskTarget(ps, 'p1', scout, true), undefined, 'a follow-up stays in its task: nothing to say');
  assert.equal(newTaskTarget([], null, scout, false), undefined, 'no projects at all: nothing to say');
  // the label and the rule that sends agree
  for (const [f, a] of [['p1', scout], ['p1', builder], ['p2', scout], [null, scout]] as const) {
    assert.equal(newTaskTarget(ps, f, a, false)!.label === 'No project', newTaskProjectId(ps, f, a.id, false) === undefined);
  }
});

test('council A7: a task shows its project when it is not the one in view; an unknown id reads as a removed project', () => {
  const ps = [P('p1', 'Site'), P('p2', 'Old', { status: 'archived' })];
  assert.equal(taskProjectChip(ps, 'p1', null), 'Site', 'under All, every task names its project');
  assert.equal(taskProjectChip(ps, 'p1', 'p1'), undefined, 'inside its own project the chip would repeat the filter');
  assert.equal(taskProjectChip(ps, 'p2', 'p1'), 'Old (archived)');
  assert.equal(taskProjectChip(ps, 'p9', null), 'removed project');
  assert.equal(taskProjectChip(ps, undefined, 'p1'), undefined, 'no project: no chip (the header says "No project")');
});

test('council A9: the archive question says what archiving touches', async () => {
  const { archiveQuestion } = await import('../ui/src/projects/projectsLogic.js');
  const q = archiveQuestion('Site', { live: 2, open: 5, rooms: 1 });
  assert.match(q, /^Archive "Site"\?/);
  assert.match(q, /2 runs in progress finish first\./);
  assert.match(q, /Its 5 open tasks cannot be continued, and no new task can start in it, until you unarchive it\./);
  assert.match(q, /1 room keeps working, without the project's instructions and notes\./);
  assert.doesNotMatch(archiveQuestion('Site', { live: 0, open: 0, rooms: 0 }), /run|room|open task/);
});

test('B4 roomOutOfProject: the reason a room is out of its project, or nothing', async () => {
  const { roomOutOfProject } = await import('../ui/src/projects/projectsLogic.js');
  const P = { id: 'proj_aaaaaaaaaaaa', name: 'Crew', status: 'active', members: ['zealot', 'scout'] } as any;
  const names = { zealot: 'Zealot', scout: 'Scout', ranger: 'Ranger' };
  assert.equal(roomOutOfProject({ projectId: P.id, members: ['zealot', 'scout'] }, [P], names), undefined);
  assert.equal(roomOutOfProject({ members: ['zealot', 'ranger'] }, [P], names), undefined, 'no project, nothing to say');
  assert.equal(roomOutOfProject({ projectId: P.id, members: ['zealot', 'ranger'] }, [P], names), 'Ranger is not a member of it');
  assert.equal(roomOutOfProject({ projectId: P.id, members: ['zealot'] }, [{ ...P, status: 'archived' }], names), 'the project is archived');
  assert.equal(roomOutOfProject({ projectId: P.id, members: ['zealot'] }, [], names), 'the project was deleted');
});

test('B4 the room header names the room\'s project, and marks it "out of project" with the reason', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const head = readFileSync(join(root, 'ui', 'src', 'rooms', 'RoomHeader.tsx'), 'utf8');
  assert.match(head, /roomOutOfProject\(room, projects, names\)/);
  assert.match(head, /data-testid="room-out-of-project"/);
  const view = readFileSync(join(root, 'ui', 'src', 'projects', 'ProjectView.tsx'), 'utf8');
  assert.match(view, /roomOutOfProject\(r, \[project\], names\)/);
});
