/** The project page's decisions (pure): meta, tabs, digest, groups, units, runs menu, rail line, project menu. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkItem } from '../src/shared/board.js';
import { PARKED_PREFIX, TURN_LIMIT_PREFIX } from '../src/shared/continue.js';
import type { ApprovalRequest, PendingQuestion, Task } from '../src/shared/types.js';
import {
  ageText, asksOf, budgetBanner, digestHeader, foldedLine, hereRuns, liveRuns, metaParts, money, nextTab, pageStatus, projectMenu, railLine,
  runsMenu, shortProjectName, sinceFor, spendBlock, stateGroups, stopDetail, tabDefs, unitModel, workingAgents, type PageFacts,
} from '../ui/src/projects/page/pageLogic.js';

const NOW = Date.parse('2026-10-14T11:30:00');
const iso = (hhmm: string, day = '2026-10-14'): string => new Date(`${day}T${hhmm}:00`).toISOString();
const P1 = 'proj_aaaaaaaaaaaa', P2 = 'proj_bbbbbbbbbbbb';
const task = (id: string, agentId: string, over: Partial<Task> = {}): Task => ({ id, agentId, title: `Task ${id}`, status: 'running', source: 'ui', requestedModel: 'auto', projectId: P1, createdAt: iso('08:00'), updatedAt: iso('11:00'), ...over } as Task);
const approval = (id: string, taskId: string, agentId: string, over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ id, taskId, agentId, toolName: 'Bash', summary: 'npm publish', input: { command: 'npm publish' }, at: iso('11:16'), projectId: P1, ...over });
const agents = ['builder', 'scout', 'scribe', 'forgemaster'].map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), description: `${id} role`, model: 'sonnet' as const, approval: 'ask' as const, vm: { enabled: false } }));
const base = (over: Partial<PageFacts> = {}): PageFacts => ({
  project: { id: P1, name: 'Shop', members: ['builder', 'scout', 'scribe', 'forgemaster'], status: 'active', createdAt: iso('00:00', '2026-10-01') },
  projects: [{ id: P1, name: 'Shop', status: 'active' }, { id: P2, name: 'Atlas', status: 'active' }],
  agents, tasks: [], approvals: [], questions: [], queue: null, nowMs: NOW, ...over,
});

test('money and age use the mockup words', () => {
  assert.equal(money(41.2), '$41.20');
  assert.equal(money(NaN), '$0.00');
  assert.equal(ageText(NOW, iso('11:29')), 'now');
  assert.equal(ageText(NOW, iso('11:10')), '20 min');
  assert.equal(ageText(NOW, iso('08:30')), '3 h');
  assert.equal(ageText(NOW, iso('08:30', '2026-10-11')), '3 d');
});

test('meta line: parts appear only when non-zero; archived and empty have their own', () => {
  const f = base();
  assert.deepEqual(metaParts(f, { asks: 5, working: 3, paused: true, weekUsd: 41.2 }), ['4 members', '3 working here', '5 need you', 'new starts paused', '$41.20 this week']);
  assert.deepEqual(metaParts(f, { asks: 1, working: 0, paused: false }), ['4 members', '1 needs you']);
  assert.deepEqual(metaParts(f, { asks: 0, working: 0, paused: false, weekUsd: 0 }), ['4 members']);
  assert.deepEqual(metaParts(base({ project: { ...f.project, members: [] } }), { asks: 0, working: 0, paused: false }), ['New project', 'no members yet']);
  const arch = base({ project: { ...f.project, status: 'archived' }, tasks: [task('t1', 'builder', { status: 'done' })] });
  assert.deepEqual(metaParts(arch, { asks: 0, working: 0, paused: false }), ['Archived', '4 members', '1 task']);
});

test('tabs: the pip carries a screen reader text, counts show only above zero, arrows rove', () => {
  const t = tabDefs({ asks: 5, board: 7, tasks: 46, rooms: 0 });
  assert.deepEqual(t.map((x) => x.key), ['overview', 'board', 'tasks', 'rooms', 'settings']);
  assert.equal(t[0]!.pip, true);
  assert.equal(t[0]!.pipText, '5 need you');
  assert.equal(t[1]!.count, 7);
  assert.equal(t[3]!.count, undefined);
  assert.equal(tabDefs({ asks: 0, board: 0, tasks: 0, rooms: 0 })[0]!.pip, false);
  const keys = t.map((x) => x.key);
  assert.equal(nextTab(keys, 'overview', 'ArrowRight'), 'board');
  assert.equal(nextTab(keys, 'overview', 'ArrowLeft'), 'settings');
  assert.equal(nextTab(keys, 'tasks', 'Home'), 'overview');
  assert.equal(nextTab(keys, 'tasks', 'End'), 'settings');
  assert.equal(nextTab(keys, 'tasks', 'x'), undefined);
});

test('the digest window: lastLooked, else 24 h, never longer than 7 days', () => {
  const p = { createdAt: iso('00:00', '2026-10-01') };
  assert.equal(sinceFor(p, iso('09:40'), NOW), Date.parse(iso('09:40')));
  assert.equal(sinceFor(p, undefined, NOW), NOW - 86_400_000);
  assert.equal(sinceFor(p, iso('09:40', '2026-09-01'), NOW), NOW - 7 * 86_400_000);
  assert.equal(sinceFor({ createdAt: iso('10:00') }, undefined, NOW), Date.parse(iso('10:00')), 'a project made an hour ago starts there');
  assert.equal(sinceFor(p, 'garbage', NOW), NOW - 86_400_000);
});

test('digest header and the quiet state still say how many wait', () => {
  assert.deepEqual(digestHeader({ needYou: 5, hasNew: true, since: '09:40', spendUsd: 6.1 }), { kind: 'new', title: 'Since 09:40', need: '5 need you', spent: '$6.10 spent' });
  assert.equal((digestHeader({ needYou: 0, hasNew: true, since: '09:40', spendUsd: 0 }) as { need: string }).need, 'Nothing needs you');
  assert.deepEqual(digestHeader({ needYou: 4, hasNew: false, since: '11:30', spendUsd: 0 }), { kind: 'quiet', text: 'Nothing new since 11:30. 4 still wait on you.' });
  assert.deepEqual(digestHeader({ needYou: 1, hasNew: false, since: '11:30', spendUsd: 0 }), { kind: 'quiet', text: 'Nothing new since 11:30. 1 still waits on you.' });
  assert.deepEqual(digestHeader({ needYou: 0, hasNew: false, since: '11:30', spendUsd: 0 }), { kind: 'quiet', text: 'Nothing new since 11:30. Nothing waits on you.' });
  assert.equal(foldedLine(1, 1, 5, '09:40'), '1 failed, 1 stopped, 5 finished or in review since 09:40');
  assert.equal(foldedLine(0, 0, 0, '09:40'), undefined);
});

test('asks of this project only, riskiest first, questions and proposals included', () => {
  const q: PendingQuestion = { id: 'q1', taskId: 't2', agentId: 'scribe', questions: [], at: iso('10:49'), projectId: P1 };
  const prop = { id: 'wi_aaaaaaaaaaaa', projectId: P1, createdAt: iso('10:02'), createdBy: { kind: 'agent', id: 'scout' } } as unknown as WorkItem;
  const f = base({
    tasks: [task('t1', 'builder'), task('t2', 'scribe'), task('t3', 'builder', { projectId: P2 })],
    approvals: [approval('a1', 't1', 'builder'), approval('a2', 't3', 'builder', { projectId: P2 }), approval('a3', 't1', 'scout', { toolName: 'Read', summary: 'a.csv', input: { file_path: '/p/a.csv' } })],
    questions: [q], board: { items: [], inbox: [prop] },
  });
  const asks = asksOf(f);
  assert.deepEqual(asks.map((a) => a.id), ['a1', 'wi_aaaaaaaaaaaa', 'a3', 'q1'], 'publish (3), proposal (2), read (1), question (0)');
  assert.ok(!asks.some((a) => a.id === 'a2'), 'another project stays out');
});

test('a task with an open ask reads as waiting on you, not working', () => {
  const f = base({ tasks: [task('t1', 'builder'), task('t2', 'scout')], approvals: [approval('a1', 't1', 'builder')] });
  const asks = asksOf(f);
  assert.deepEqual(workingAgents(f, asks), ['scout']);
  const waiting = new Set(['t1']);
  assert.equal(pageStatus(f.tasks[0]!, waiting), 'waiting');
  assert.equal(pageStatus(f.tasks[1]!, waiting), 'working');
  assert.equal(pageStatus(task('x', 'a', { status: 'error', error: `${TURN_LIMIT_PREFIX} (200)` }), waiting), 'stopped');
  assert.equal(pageStatus(task('x', 'a', { status: 'error', error: 'boom' }), waiting), 'failed');
  assert.equal(pageStatus(task('x', 'a', { status: 'error', error: PARKED_PREFIX }), waiting), 'waiting');
  assert.equal(pageStatus(task('x', 'a', { status: 'queued' }), waiting), 'queued');
});

test('run counts: running only, in every project; the strip counts this project', () => {
  const tasks = [task('1', 'builder'), task('2', 'builder'), task('3', 'builder', { projectId: P2 }), task('4', 'builder', { status: 'queued' }), task('5', 'builder', { status: 'done' })];
  assert.equal(liveRuns('builder', tasks), 3);
  assert.equal(hereRuns(base({ tasks }), 'builder'), 2);
});

test('state groups: reasons, caps, stopped versus failed, review from the board, done today only', () => {
  const tasks = [
    ...Array.from({ length: 7 }, (_, i) => task(`w${i}`, 'builder', { updatedAt: iso(`10:${String(10 + i)}`) })),
    task('q1', 'scout', { status: 'queued' }),
    task('s1', 'scout', { status: 'error', error: `${TURN_LIMIT_PREFIX} (200 turns)`, turns: 200, costUsd: 2.64 }),
    task('f1', 'scribe', { status: 'error', error: 'The build exited with code 1.', costUsd: 0.05 }),
    ...Array.from({ length: 5 }, (_, i) => task(`d${i}`, 'builder', { status: 'done', result: `Shipped ${i}\nmore`, costUsd: 1, updatedAt: iso(`09:${String(10 + i)}`) })),
    task('old', 'builder', { status: 'done', updatedAt: iso('09:00', '2026-10-10') }),
  ];
  const review = { id: 'wi_bbbbbbbbbbbb', projectId: P1, title: 'Fix the header', status: 'review', assignee: { kind: 'agent', id: 'forgemaster' }, updatedAt: iso('10:25') } as unknown as WorkItem;
  const f = base({ tasks, queue: { cap: 4, running: 4, items: [{ taskId: 'q1', reason: 'slot', position: 1 }] }, board: { items: [review], inbox: [] } });
  const g = Object.fromEntries(stateGroups(f).map((x) => [x.key, x]));
  assert.equal(g.working!.total, 7);
  assert.equal(g.working!.cap, 5);
  assert.equal(g.queue!.items[0]!.detail, 'Waiting for a free slot (4 of 4 running in all projects)');
  assert.equal(g.review!.items[0]!.title, 'Fix the header');
  assert.equal(g.review!.items[0]!.agentName, 'Forgemaster');
  const stop = g.stop!.items;
  assert.equal(stop.find((i) => i.taskId === 's1')!.action, 'continue');
  assert.equal(stop.find((i) => i.taskId === 's1')!.detail, 'Stopped after 200 steps. Work kept.');
  assert.equal(stop.find((i) => i.taskId === 'f1')!.action, 'retry');
  assert.equal(stop.find((i) => i.taskId === 'f1')!.detail, 'Failed: the build exited with code 1.');
  assert.equal(g.done!.total, 5, 'an older done task is not "today"');
  assert.equal(g.done!.cap, 3);
  assert.equal(g.done!.items[0]!.detail.startsWith('Shipped'), true);
  assert.equal(g.done!.items[0]!.detail.includes('more'), false, 'first line only');
});

test('a queued task whose reason is unknown still explains itself', () => {
  const f = base({ tasks: [task('q1', 'scout', { status: 'queued' })], queue: { cap: 4, running: 2, items: [] } });
  assert.equal(stateGroups(f)[0]!.items[0]!.detail, 'Waiting for a free slot (2 of 4 running in all projects)');
  assert.equal(stateGroups(base({ tasks: [task('q1', 'scout', { status: 'queued' })] }))[0]!.items[0]!.detail.startsWith('Waiting for a free slot'), true, 'no queue snapshot at all');
});

test('groups never throw for a task of a removed project or an ask with no task', () => {
  const f = base({ tasks: [task('t1', 'ghost', { projectId: 'proj_gone' })], approvals: [approval('a1', 'nope', 'ghost', { projectId: P1 })] });
  assert.doesNotThrow(() => { stateGroups(f); unitModel(f); asksOf(f); });
  assert.equal(stateGroups(f).length, 0);
});

test('units: lead line priority, asks without a task, also elsewhere, idle and no-task members', () => {
  const tasks = [
    task('t1', 'builder', { title: 'Publish the package' }), task('t2', 'builder', { title: 'Storefront review' }),
    task('t3', 'scout', { status: 'error', error: 'boom', title: 'Basket total' }),
    task('t4', 'scout', { status: 'queued', title: 'Sitemap check' }),
    task('t5', 'scribe', { status: 'done', updatedAt: iso('08:30'), title: 'Old docs' }),
    task('t6', 'forgemaster', { projectId: P2, title: 'Deploy preview' }),
    task('t7', 'forgemaster', { title: 'Payment flag' }),
  ];
  const f = base({ tasks, approvals: [approval('a1', 't1', 'builder'), approval('a9', 'gone', 'scout', { toolName: 'Read', summary: 'orders.csv', input: { file_path: '/p/orders.csv' } })] });
  const { units, idle, noTasks } = unitModel(f, { weekByAgent: { builder: 14.2 } });
  const by = Object.fromEntries(units.map((u) => [u.agentId, u]));
  assert.equal(by.builder!.lead.text, 'Needs you: Publish the package');
  assert.equal(by.builder!.rest[0]!.text.startsWith('Storefront review'), true);
  assert.equal(by.builder!.runs, 2);
  assert.equal(by.builder!.weekUsd, 14.2);
  assert.equal(by.scout!.lead.icon, 'hand', 'an ask with no task still leads');
  assert.equal(by.scout!.rest.length, 2, 'and the queued and failed runs follow');
  assert.equal(by.scout!.rest[0]!.icon, 'queue', 'queued before failed');
  assert.equal(by.forgemaster!.also, 'Also working in Atlas: Deploy preview');
  assert.equal(by.forgemaster!.lead.text.startsWith('Payment flag'), true);
  assert.deepEqual(units.map((u) => u.agentId).slice(0, 2).sort(), ['builder', 'scout'], 'needs-you units first');
  assert.equal(idle.length, 1);
  assert.equal(idle[0]!.text, 'Idle. Last worked 3 h ago.');
  assert.deepEqual(noTasks, []);
  const lonely = unitModel(base({ project: { ...f.project, members: ['builder', 'scout'] }, tasks: [] }));
  assert.deepEqual(lonely.noTasks, ['Builder', 'Scout']);
});

test('runs menu: grouped by project, current first, stop only where the run is not waiting on you', () => {
  const tasks = [task('t1', 'builder', { title: 'A' }), task('t2', 'builder', { projectId: P2, title: 'B' }), task('t3', 'builder', { title: 'C' })];
  const f = base({ tasks, approvals: [approval('a1', 't3', 'builder')], queue: { cap: 4, running: 3, items: [] } });
  const m = runsMenu(f, 'builder');
  assert.equal(m.header, 'Builder: 3 live runs. 3 of 4 slots in use.');
  assert.deepEqual(m.groups.map((g) => g.projectName), ['Shop', 'Atlas']);
  const c = m.groups[0]!.rows.find((r) => r.taskId === 't3')!;
  assert.equal(c.needsYou, true);
  assert.equal(c.canStop, false);
  assert.equal(c.detail, 'Needs you');
  assert.equal(m.groups[0]!.rows.find((r) => r.taskId === 't1')!.canStop, true);
});

test('budget banner and spend block', () => {
  const hit = { limited: true, reached: true, overridden: false, spent: 50, limit: 50, period: 'week' as const, periodEnd: new Date('2026-10-19T00:00:00').getTime() };
  assert.deepEqual(budgetBanner(hit), { title: 'Budget reached: $50.00 this week.', text: 'New runs wait until Monday.' });
  assert.equal(budgetBanner({ ...hit, reached: false }), undefined);
  assert.equal(budgetBanner(undefined), undefined);
  assert.equal(budgetBanner({ ...hit, overridden: true, reached: false }), undefined);
  assert.deepEqual(spendBlock(41.2, undefined), { big: '$41.20', pct: 0, hi: false, foot: 'No budget set. Optional.' });
  const s = spendBlock(0, { ...hit, reached: false, spent: 41.2 });
  assert.equal(s.of, 'of $50.00');
  assert.equal(s.pct, 82);
  assert.equal(s.hi, true);
  assert.equal(s.foot, '82%. New runs wait at $50.00, you get one notification.');
});

test('rail line: one priority; this project asks, then work here, then work elsewhere, then the role', () => {
  const tasks = [
    task('t1', 'builder', { title: 'Publish the package' }), task('t1b', 'builder', { title: 'Second thing' }),
    task('t2', 'scout', { title: 'Payment flag' }), task('t3', 'scout', { projectId: P2, title: 'Map theme variables' }),
    task('t4', 'scribe', { projectId: P2, title: 'Map theme variables' }),
  ];
  const f = base({ tasks, approvals: [approval('a1', 't1', 'builder'), approval('a2', 't1b', 'builder')] });
  const line = (id: string, filter: string | null) => railLine(f, id, filter, 'role');
  assert.deepEqual(line('builder', P1), { text: '2 things need you', full: '2 things need you: Publish the package, Second thing', tone: 'attn', runs: 2 });
  const one = railLine({ ...f, approvals: [approval('a1', 't1', 'builder')] }, 'builder', P1, 'role');
  assert.equal(one.text, 'Needs you: Publish the package');
  assert.equal(line('scout', P1).text, 'Payment flag · also Atlas');
  assert.equal(line('scout', P1).tone, 'work');
  assert.equal(line('scribe', P1).text, 'In Atlas: Map theme variables');
  assert.equal(line('forgemaster', P1).text, 'role');
  assert.equal(line('forgemaster', P1).tone, '');
  assert.equal(line('scout', null).text.startsWith('Working: '), true, 'under All projects the run is in view, nothing is "elsewhere"');
});

test('project menu: counts per project, archived last, the dot counts asks in other projects', () => {
  const f = base({ tasks: [task('t1', 'builder'), task('t2', 'scout', { projectId: P2 })], approvals: [approval('a1', 't1', 'builder'), approval('a2', 't2', 'scout', { projectId: P2 }), approval('a3', 't2', 'scout', { projectId: P2 })] });
  const asks = asksOfAll(f);
  const m = projectMenu([...f.projects, { id: 'proj_cccccccccccc', name: 'Old', status: 'archived' }], asks, P1);
  assert.deepEqual(m.rows.map((r) => [r.label, r.needYou, r.current]), [['All projects', 3, false], ['Atlas', 2, false], ['Shop', 1, true], ['Old (archived)', 0, false]]);
  assert.equal(m.elsewhere, 2);
  assert.equal(projectMenu(f.projects, asks, null).elsewhere, 0, 'under All projects nothing is elsewhere');
});

import { deriveAsks } from '../src/shared/attention.js';
function asksOfAll(f: PageFacts) { return deriveAsks({ approvals: f.approvals, questions: f.questions, tasks: f.tasks }); }

test('a long project name is shortened in the rail and the units: the part before a colon or dash, else clipped', () => {
  assert.equal(shortProjectName('Atlas: migrate every client webshop from the old DanDomain theme to the new one'), 'Atlas');
  assert.equal(shortProjectName('Atlas - the migration'), 'Atlas');
  assert.equal(shortProjectName('Shop'), 'Shop');
  assert.equal(shortProjectName('Spring campaign for every single client'), 'Spring campaign fo…');
  assert.equal(shortProjectName(''), 'a project');
  const long = base({ projects: [{ id: P1, name: 'Shop', status: 'active' }, { id: P2, name: 'Atlas: migrate every client webshop', status: 'active' }], tasks: [task('t3', 'scout', { projectId: P2, title: 'Map theme variables' })] });
  assert.equal(railLine(long, 'scout', P1, 'role').text, 'In Atlas: Map theme variables');
});

test('stop detail says "1 step", not "1 steps"', () => {
  assert.equal(stopDetail(task('s', 'a', { status: 'error', error: TURN_LIMIT_PREFIX, turns: 1 })), 'Stopped after 1 step. Work kept.');
  assert.equal(stopDetail(task('s', 'a', { status: 'error', error: TURN_LIMIT_PREFIX, turns: 200 })), 'Stopped after 200 steps. Work kept.');
  assert.equal(stopDetail(task('s', 'a', { status: 'error', error: TURN_LIMIT_PREFIX })), 'Stopped at a limit. Work kept.');
});

test('shortProjectName also cuts at an en or em dash', () => {
  assert.equal(shortProjectName('Atlas \u2013 the migration'), 'Atlas');
  assert.equal(shortProjectName('Atlas \u2014 the migration'), 'Atlas');
});
