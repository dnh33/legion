/** Task tabs follow the project dropdown strictly (pure logic). */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Project } from '../src/shared/projects.js';
import { tabTasks, projectToShow, otherProjectsHint } from '../ui/src/chat/taskTabs.js';

const P = (id: string, name: string): Project => ({ id, name, instructions: '', folder: '/f', members: [], status: 'active', createdAt: '', updatedAt: '' });
const atlas = P('proj_aaaaaaaaaaaa', 'Atlas');
const beta = P('proj_bbbbbbbbbbbb', 'Beta');
const T = (id: string, over: Record<string, unknown> = {}): any => ({ id, agentId: 'scout', title: id, status: 'done', archived: false, createdAt: id, updatedAt: id, ...over });

test('tabs: a project shows only its own tasks, even the selected one from elsewhere is not a tab', () => {
  const tasks = [T('t1', { projectId: atlas.id }), T('t2', { projectId: beta.id }), T('t3'), T('t4', { agentId: 'other', projectId: atlas.id })];
  assert.deepEqual(tabTasks(tasks, 'scout', 't2', atlas.id).map((t) => t.id), ['t1']);
  assert.deepEqual(tabTasks(tasks, 'scout', null, null).map((t) => t.id), ['t3', 't2', 't1']);
});

test('switch: a task of another project (or none) moves the dropdown there first; same project or All changes nothing', () => {
  const ps = [atlas, beta];
  assert.equal(projectToShow(T('a', { projectId: beta.id }), atlas.id, ps), beta.id);
  assert.equal(projectToShow(T('a'), atlas.id, ps), null);
  assert.equal(projectToShow(T('a', { projectId: 'proj_cccccccccccc' }), atlas.id, ps), null);
  assert.equal(projectToShow(T('a', { projectId: atlas.id }), atlas.id, ps), undefined);
  assert.equal(projectToShow(T('a', { projectId: beta.id }), null, ps), undefined);
});

test('hint: live tasks of the agent in other projects, plain; amber when one needs you', () => {
  const ps = [atlas, beta];
  const tasks = [T('r1', { status: 'running', projectId: beta.id }), T('r2', { status: 'queued', projectId: beta.id }), T('d', { status: 'done', projectId: beta.id }), T('mine', { status: 'running', projectId: atlas.id })];
  const h = otherProjectsHint(tasks, 'scout', atlas.id, ps, []);
  assert.equal(h?.text, '+2 running in Beta'); assert.equal(h?.tone, 'plain'); assert.equal(h?.tasks.length, 2);
  assert.equal(otherProjectsHint(tasks, 'scout', null, ps, ), undefined);
  assert.equal(otherProjectsHint(tasks, 'scout', beta.id, ps, [])?.text, '+1 running in Atlas');
  const many = [...tasks, T('r3', { status: 'running' })];
  assert.equal(otherProjectsHint(many, 'scout', atlas.id, ps, [])?.text, '+3 running elsewhere');
  const need = otherProjectsHint(tasks, 'scout', atlas.id, ps, [{ taskId: 'r2' }]);
  assert.equal(need?.text, '1 needs you in Beta'); assert.equal(need?.tone, 'amber'); assert.equal(need?.tasks[0]!.id, 'r2');
  assert.equal(otherProjectsHint([T('x', { status: 'running', projectId: atlas.id })], 'scout', atlas.id, ps, []), undefined);
});

test('wiring: selectTask and a sent task switch the project through one function; History and the rail do not duplicate it', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const src = (f: string) => readFileSync(join(root, 'ui', 'src', f), 'utf8');
  const store = src('store.ts');
  assert.match(store, /function projectFollowing\(/);
  assert.equal((store.match(/projectFollowing\(/g) ?? []).length, 3); // definition + selectTask + sendPromptTo
  assert.doesNotMatch(src('history/HistoryList.tsx'), /setProjectFilter/);
  assert.doesNotMatch(src('components/TaskSwitcher.tsx'), /inProject/);
});

test('copy: a task without a project is "outside projects" everywhere; the hint counts only real projects', async () => {
  const { inWhere, alsoWorkingLabel, railAlsoWorking } = await import('../ui/src/projects/projectsLogic.js');
  const ps = [atlas, beta];
  assert.equal(inWhere(ps, undefined), 'outside projects');
  assert.equal(inWhere(ps, atlas.id), 'in Atlas');
  assert.equal(inWhere(ps, 'proj_cccccccccccc'), 'in a removed project');
  assert.equal(alsoWorkingLabel([T('a', { title: 'Loose chat' })], ps), 'Also working outside projects: Loose chat');
  assert.equal(alsoWorkingLabel([T('a', { title: 'Map', projectId: beta.id }), T('b', { projectId: beta.id })], ps), 'Also working in Beta: Map (+1 more)');
  assert.equal(railAlsoWorking('scout', [T('a', { status: 'running', title: 'Loose chat' })], atlas.id, ps), 'Working outside projects: Loose chat');
  const live = (id: string, projectId?: string) => T(id, { status: 'running', ...(projectId ? { projectId } : {}) });
  assert.equal(otherProjectsHint([live('1', beta.id), live('2')], 'scout', atlas.id, ps)?.text, '+2 running elsewhere');
  assert.equal(otherProjectsHint([live('1')], 'scout', atlas.id, ps)?.text, '+1 running outside projects');
  assert.equal(otherProjectsHint([live('1', beta.id), live('2', beta.id)], 'scout', atlas.id, ps)?.text, '+2 running in Beta');
});
