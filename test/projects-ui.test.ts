/** Projects UI logic (pure) and accessible names in the sources (control C19). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project } from '../src/shared/projects.js';
import type { Room } from '../src/shared/comms.js';
import { agentsFor, assignableRooms, inProject, instructionsCounter, INSTRUCTIONS_MAX, memberDiff, newTaskProjectId, projectLabel, resolveFilter, roomsOf, sortProjects, statusLine } from '../ui/src/projects/projectsLogic.js';

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
