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
  assert.match(q, /1 room is marked out of project, with a notice in it; it keeps working without the project's instructions, board and notes\./);
  assert.doesNotMatch(archiveQuestion('Site', { live: 0, open: 0, rooms: 0 }), /run|room|open task|board/);
  assert.match(archiveQuestion('Site', { live: 0, open: 0, rooms: 0, board: 3 }), /3 unfinished board items are assigned to agents; they stay on the board\./);
  assert.match(archiveQuestion('Site', { live: 0, open: 0, rooms: 0, board: 1 }), /1 unfinished board item is assigned to an agent; it stays on the board\./);
});

test('council A9 boardItemsAssigned counts unfinished items assigned to an agent, nothing else', async () => {
  const { boardItemsAssigned } = await import('../ui/src/projects/projectsLogic.js');
  const it = (status: string, assignee: any) => ({ status, assignee }) as any;
  assert.equal(boardItemsAssigned([it('doing', { kind: 'agent', id: 'a' }), it('backlog', { kind: 'agent', id: 'b' }), it('done', { kind: 'agent', id: 'a' }), it('doing', { kind: 'owner' }), it('doing', null)]), 2);
  assert.equal(boardItemsAssigned([]), 0);
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

test('B1 waitingElsewhere: what waits on the owner but is hidden by the project in view, oldest first, with where it is', async () => {
  const { waitingElsewhere } = await import('../ui/src/projects/projectsLogic.js');
  const P = { id: 'proj_aaaaaaaaaaaa', name: 'Site', status: 'active', members: ['builder'] } as any;
  const Q = { id: 'proj_bbbbbbbbbbbb', name: 'Shop', status: 'active', members: ['scout', 'builder'] } as any;
  const tasks = [
    { id: 't_p', projectId: P.id, title: 'Fix the header' },
    { id: 't_q', projectId: Q.id, title: 'Price list for the summer sale in all the shops' },
    { id: 't_none', title: 'Loose task' },
  ];
  const names = { scout: 'Scout', builder: 'Builder' };
  const approvals = [
    { id: 'a1', taskId: 't_q', agentId: 'scout', at: '2026-10-13T10:00:02Z' },
    { id: 'a2', taskId: 't_p', agentId: 'builder', at: '2026-10-13T10:00:01Z' },
    { id: 'a3', taskId: 't_gone', agentId: 'scout', at: '2026-10-13T10:00:04Z' },
  ];
  const questions = [{ id: 'q1', taskId: 't_none', agentId: 'builder', at: '2026-10-13T10:00:03Z' }];
  const rows = waitingElsewhere(approvals, questions, tasks, [P, Q], names, P.id);
  assert.deepEqual(rows.map((r) => r.taskId), ['t_q', 't_none', 't_gone'], 'the P approval shows on its own rail row; the rest, oldest first');
  assert.equal(rows[0]!.label, 'Scout needs your OK in Shop: Price list for the summer sale in all t…');
  assert.equal(rows[0]!.projectId, Q.id);
  assert.equal(rows[1]!.label, 'Builder asks you something in no project: Loose task');
  assert.equal(rows[1]!.projectId, null);
  assert.equal(rows[2]!.label, 'Scout needs your OK in another task');
  assert.deepEqual(waitingElsewhere(approvals, questions, tasks, [P, Q], names, null), [], 'All shows everything already');
  // an agent removed from P whose old P task waits: its row is hidden, so it is listed
  const removed = waitingElsewhere([{ id: 'a9', taskId: 't_p', agentId: 'scout', at: 'x' }], [], tasks, [P, Q], names, P.id);
  assert.equal(removed.length, 1);
  assert.equal(removed[0]!.label, 'Scout needs your OK in Site: Fix the header');
});

test('B1 the rail shows a "Needs you in other projects" block built from waitingElsewhere, and a click opens the item in its project', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const rail = readFileSync(join(root, 'ui', 'src', 'components', 'AgentRail.tsx'), 'utf8');
  assert.match(rail, /waitingElsewhere\(approvals, questions, tasks, projects, names, filter\)/);
  assert.match(rail, /data-testid="rail-waiting"/);
  assert.match(rail, /Needs you in other projects/);
  assert.match(rail, /setProjectFilter\(row\.projectId\)/);
  assert.match(rail, /selectTask\(row\.taskId\)/);
  assert.match(rail, /aria-live="polite"/);
});

test('B2 liveElsewhere and alsoWorkingLabel: the agent\'s live runs outside the project in view or the thread\'s project', async () => {
  const { liveElsewhere, alsoWorkingLabel } = await import('../ui/src/projects/projectsLogic.js');
  const P = { id: 'proj_aaaaaaaaaaaa', name: 'Site', status: 'active', members: ['builder'] } as any;
  const Q = { id: 'proj_bbbbbbbbbbbb', name: 'Shop', status: 'active', members: ['builder'] } as any;
  const t = (id: string, status: string, projectId?: string, updatedAt = '2026-10-13T10:00:00Z') => ({ id, agentId: 'builder', status, title: 'Task ' + id, updatedAt, ...(projectId ? { projectId } : {}) }) as any;
  const tasks = [t('q1', 'running', Q.id, '2026-10-13T10:00:02Z'), t('p1', 'running', P.id), t('n1', 'queued', undefined, '2026-10-13T10:00:01Z'), t('q2', 'done', Q.id)];
  // project P in view: q1 and n1 are elsewhere, newest first; p1 is here; done does not count
  assert.deepEqual(liveElsewhere('builder', tasks, { filter: P.id, taskId: null }).map((x: any) => x.id), ['q1', 'n1']);
  // a thread in Q under "All": everything live that is not in Q, and never the thread itself
  assert.deepEqual(liveElsewhere('builder', tasks, { filter: null, taskId: 'q1', taskProjectId: Q.id }).map((x: any) => x.id), ['n1', 'p1']);
  // "All" with no thread: any live task other than this one
  assert.deepEqual(liveElsewhere('builder', tasks, { filter: null, taskId: 'p1' }).map((x: any) => x.id), ['q1', 'n1']);
  assert.equal(alsoWorkingLabel([], [P, Q]), undefined);
  assert.equal(alsoWorkingLabel([tasks[0]], [P, Q]), 'Also working in Shop: Task q1');
  assert.equal(alsoWorkingLabel([tasks[2]], [P, Q]), 'Also working in no project: Task n1');
  assert.equal(alsoWorkingLabel([tasks[0], tasks[2], tasks[1]], [P, Q]), 'Also working in Shop: Task q1 (+2 more)');
});

test('B2 the rail row and the composer show the "Also working" line; it never blocks sending', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const rail = readFileSync(join(root, 'ui', 'src', 'components', 'AgentRail.tsx'), 'utf8');
  assert.match(rail, /railAlsoWorking\(a\.id, tasks, filter, projects\)/);
  const comp = readFileSync(join(root, 'ui', 'src', 'components', 'Composer.tsx'), 'utf8');
  assert.match(comp, /className="also-pill" role="status"/);
  assert.match(comp, /busyIn\(/, 'the composer asks the shared busy rule');
  const busy = readFileSync(join(root, 'ui', 'src', 'chat', 'busy.ts'), 'utf8');
  assert.doesNotMatch(busy, /liveElsewhere|alsoWorking/, 'busy rules never read the "Also working" list (decision B1: no block)');
});

test('council A1 the block and the "Also working" line split the same runs: what blocks is never listed, what is listed never blocks', async () => {
  const { liveElsewhere } = await import('../ui/src/projects/projectsLogic.js');
  const { busyReason } = await import('../ui/src/chat/busy.js');
  const mk = (id: string, projectId?: string) => ({ id, agentId: 'z', status: 'running', title: id, updatedAt: '', createdAt: '', requestedModel: 'auto', source: 'bot', ...(projectId ? { projectId } : {}) }) as any;
  const tasks = [mk('a', 'pA'), mk('b', 'pB'), mk('n')];
  for (const scope of ['pA', 'pB', undefined] as const) {
    const listed = liveElsewhere('z', tasks, { filter: null, taskId: null, ...(scope ? { taskProjectId: scope } : {}) }).map((t: any) => t.id);
    const blocking = tasks.filter((t: any) => busyReason('z', null, [t], [], scope) === 'other').map((t: any) => t.id);
    assert.deepEqual(blocking, tasks.filter((t: any) => t.projectId === scope).map((t: any) => t.id), String(scope));
    // (with no project to compare, the list is every other run: a no-project run blocks AND is mentioned, by design)
    if (scope) {
      assert.deepEqual([...listed, ...blocking].sort(), ['a', 'b', 'n'], 'every run is either listed or blocking: ' + scope);
      assert.equal(listed.filter((id: string) => blocking.includes(id)).length, 0);
    }
  }
});

test('C1 followRemote: an untouched editor follows a change made elsewhere; an edited one keeps the owner\'s text', async () => {
  const { followRemote } = await import('../ui/src/projects/projectsLogic.js');
  assert.equal(followRemote('old', 'old', 'new'), 'new', 'untouched: follows');
  assert.equal(followRemote('mine', 'old', 'new'), 'mine', 'edited: kept');
  assert.equal(followRemote('old', 'old', 'old'), 'old');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const view = readFileSync(join(root, 'ui', 'src', 'projects', 'ProjectView.tsx'), 'utf8');
  assert.doesNotMatch(view, /setText\(\(t\) => \(t === project\.instructions \? t : t\)\)/, 'the no-op is gone');
  assert.match(view, /followRemote\(t, prev\.current\.instructions, project\.instructions\)/);
});

test('C2 defaultStarter: the selected agent when it is a member, else the first member; the page offers a labelled choice', async () => {
  const { defaultStarter } = await import('../ui/src/projects/projectsLogic.js');
  assert.equal(defaultStarter(['scout', 'builder'], 'builder'), 'builder');
  assert.equal(defaultStarter(['scout', 'builder'], 'herald'), 'scout');
  assert.equal(defaultStarter(['scout'], null), 'scout');
  assert.equal(defaultStarter([], 'scout'), undefined);
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const view = readFileSync(join(root, 'ui', 'src', 'projects', 'ProjectView.tsx'), 'utf8');
  assert.match(view, /<select aria-label="Agent for the new task"/);
  assert.doesNotMatch(view, /const first = project\.members\[0\];/, 'no longer always the first member');
});

test('C3 the project page shows 30 tasks, and all of them on request', async () => {
  const { visibleTasks, PROJECT_TASKS_FOLDED } = await import('../ui/src/projects/projectsLogic.js');
  const list = Array.from({ length: 45 }, (_, i) => i);
  assert.equal(PROJECT_TASKS_FOLDED, 30);
  assert.equal(visibleTasks(list, false).length, 30);
  assert.equal(visibleTasks(list, true).length, 45);
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const view = readFileSync(join(root, 'ui', 'src', 'projects', 'ProjectView.tsx'), 'utf8');
  assert.match(view, /Show all \$\{inTasks\.length\}/);
  assert.match(view, /loadProjectTasks\(project\.id, 100\)/);
  assert.doesNotMatch(view, /inTasks\.slice\(0, 30\)/);
});

test('C4 unarchive asks first and says what comes back', async () => {
  const { unarchiveQuestion } = await import('../ui/src/projects/projectsLogic.js');
  assert.equal(unarchiveQuestion('Site'), 'Unarchive "Site"?\n\nIts tasks can be continued again and new tasks can start in it. Its rooms and members get its instructions, board and notes again.');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const view = readFileSync(join(root, 'ui', 'src', 'projects', 'ProjectView.tsx'), 'utf8');
  assert.match(view, /unarchiveProject\(project\)/);
  assert.doesNotMatch(view, /saveProject\(project\.id, \{ status: 'active' \}\)/, 'no unarchive without the question');
});

test('review #9 the agent rail says "Also working in" only while a project is in view; under All every run is already on the rail', async () => {
  const { railAlsoWorking } = await import('../ui/src/projects/projectsLogic.js');
  const now = '2026-10-13T10:00:00Z';
  const tasks = [{ id: 't1', agentId: 'a1', status: 'running' as const, projectId: 'p2', title: 'Fix the header', updatedAt: now }];
  const projects = [{ id: 'p2', name: 'Shop' }] as Project[];
  assert.equal(railAlsoWorking('a1', tasks, null, projects), undefined);
  assert.equal(railAlsoWorking('a1', tasks, 'p1', projects), 'Working in Shop: Fix the header', 'its only run is elsewhere: not "Also"');
});

test('rail and bust agree: a run in another project makes the row busy, and the sub-line says where', async () => {
  const { railAlsoWorking, railRowBusy } = await import('../ui/src/projects/projectsLogic.js');
  const projects = [{ id: 'p1', name: 'Site' }, { id: 'p2', name: 'Atlas' }] as Project[];
  const t = (id: string, projectId: string | undefined, status: any = 'running') => ({ id, agentId: 'a1', status, projectId, title: 'Task ' + id, updatedAt: '2026-10-14T10:00:00Z' }) as any;
  // the only run is in Atlas while Site is in view: busy (like the bust), and the line is not "Also"
  assert.equal(railRowBusy('a1', [t('x', 'p2')]), true);
  assert.equal(railRowBusy('a1', [t('x', 'p2', 'done')]), false);
  assert.equal(railRowBusy('a2', [t('x', 'p2')]), false);
  assert.equal(railAlsoWorking('a1', [t('x', 'p2')], 'p1', projects), 'Working in Atlas: Task x');
  // a run here too: "Also"
  assert.equal(railAlsoWorking('a1', [t('x', 'p2'), t('y', 'p1')], 'p1', projects), 'Also working in Atlas: Task x');
  // all projects: nothing to add
  assert.equal(railAlsoWorking('a1', [t('x', 'p2')], null, projects), undefined);
});

test('rail row counts only this project\'s asks under a project filter; All counts everything', async () => {
  const { railPending } = await import('../ui/src/projects/projectsLogic.js');
  const tasks = [{ id: 't1', projectId: 'p1' }, { id: 't2', projectId: 'p2' }, { id: 't3' }] as any[];
  const ap = (id: string, taskId: string, agentId = 'a1') => ({ id, taskId, agentId, at: '' }) as any;
  const approvals = [ap('1', 't1'), ap('2', 't2'), ap('3', 't3'), ap('4', 'gone'), ap('5', 't1', 'a2')];
  assert.equal(railPending('a1', approvals, tasks, null), 4, 'All');
  assert.equal(railPending('a1', approvals, tasks, 'p1'), 1, 'only the ask in p1');
  assert.equal(railPending('a1', approvals, tasks, 'p2'), 1);
  assert.equal(railPending('a2', approvals, tasks, 'p2'), 0);
});

test('the bust asks (awaiting) for a question from the agent too, not only an approval', async () => {
  const { agentAwaitsOwner } = await import('../ui/src/mascot/awaiting.js');
  const ap = [{ agentId: 'a1' }] as any[], qs = [{ agentId: 'a2' }] as any[];
  assert.equal(agentAwaitsOwner('a1', ap, qs), true);
  assert.equal(agentAwaitsOwner('a2', ap, qs), true, 'a question');
  assert.equal(agentAwaitsOwner('a3', ap, qs), false);
});
