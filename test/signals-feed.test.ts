import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptOpen, BURST_MS, initialPlanState, plan } from '../src/electron/attention.js';
import type { PlanInput } from '../src/electron/attention.js';
import { Feed, follow } from '../src/electron/signals-logic.js';

const NOW = new Date(2026, 9, 14, 12).getTime();
const snap = (over: Record<string, unknown> = {}) => ({
  agents: [{ id: 'scout', name: 'Scout' }], projects: [{ id: 'p1', name: 'Shop' }], tasks: [] as Array<{ id: string; status: string; projectId?: string; agentId: string }>,
  approvals: [] as Array<{ id: string; taskId: string; agentId: string; projectId?: string }>, questions: [], parked: [], attention: { total: 0, working: 0, byProject: {} as Record<string, number> }, ...over,
});
const input = (feed: Feed, over: Partial<PlanInput> = {}): PlanInput => ({
  total: feed.total, asks: [...feed.open.values()], ...feed.takePending(), spentUsd: 0, prefs: { enabled: true, returnSummary: true, levels: {} },
  focus: { focused: false, pageProjectId: null, threadTaskId: null }, ...over,
});
const settle = (s: ReturnType<typeof plan>, inp: PlanInput, t: number) => (s.wakeAt !== null && s.wakeAt <= t + BURST_MS + 5 ? plan(s.state, inp, s.wakeAt) : s);

test('launch: asks that were already open are adopted, not announced; a new one still is', () => {
  const feed = new Feed();
  const keys = feed.reseed(snap({ approvals: [{ id: 'a1', taskId: 't1', agentId: 'scout' }, { id: 'a2', taskId: 't2', agentId: 'scout' }], attention: { total: 2, working: 0, byProject: {} } }));
  const state = adoptOpen(initialPlanState(), keys);
  const first = plan(state, input(feed), NOW);
  assert.equal(first.notifications.length, 0);
  assert.equal(first.overlay?.key, '2', 'the number still shows');
  feed.apply({ type: 'approval.requested', approval: { id: 'a3', taskId: 't3', agentId: 'scout', toolName: 'Bash', summary: '', input: {}, at: '' } } as never);
  const inp = input(feed);
  const next = settle(plan(first.state, inp, NOW + 10), inp, NOW + 10);
  assert.deepEqual(next.notifications.map((n) => n.title), ['Scout needs your OK']);
});

test('the known-key trim never drops a key that is still open', () => {
  const closed = Array.from({ length: 700 }, (_, i) => `a:old${i}`);
  const state = adoptOpen(initialPlanState(), ['a:open1', ...closed]);
  const feed = new Feed();
  feed.reseed(snap({ approvals: [{ id: 'open1', taskId: 't', agentId: 'scout' }], attention: { total: 1, working: 0, byProject: {} } }));
  const r = plan(state, input(feed), NOW);
  assert.ok(r.state.known.length <= 500);
  assert.ok(r.state.known.includes('a:open1'));
  const again = settle(plan(r.state, input(feed), NOW + 5), input(feed), NOW + 5);
  assert.equal(again.notifications.length, 0);
});

test('reconnect: a run that failed while disconnected is announced once; a finished one is not repeated', () => {
  const feed = new Feed();
  feed.reseed(snap({ tasks: [{ id: 'r1', status: 'running', agentId: 'scout', projectId: 'p1' }, { id: 'r2', status: 'error', agentId: 'scout' }] }));
  assert.deepEqual(feed.takePending(), { failed: [], finished: [], budget: [] }, 'a task already failed at the first look is not news');
  feed.reseed(snap({ tasks: [{ id: 'r1', status: 'error', agentId: 'scout', projectId: 'p1' }, { id: 'r2', status: 'error', agentId: 'scout' }] }));
  const p = feed.takePending();
  assert.equal(p.failed.length, 1);
  assert.equal(p.failed[0]!.projectName, 'Shop');
  feed.reseed(snap({ tasks: [{ id: 'r1', status: 'error', agentId: 'scout', projectId: 'p1' }] }));
  assert.equal(feed.takePending().failed.length, 0);
});

test('proposals count but have no toast; "open what needs you" finds their project', () => {
  const feed = new Feed();
  feed.reseed(snap({ attention: { total: 1, working: 0, byProject: { p1: 1 } } }));
  assert.equal(feed.open.size, 0);
  const r = plan(initialPlanState(), input(feed), NOW);
  assert.equal(r.overlay?.key, '1');
  assert.equal(r.notifications.length, 0);
  assert.deepEqual(feed.firstRef(), { projectId: 'p1' });
  feed.reseed(snap({ approvals: [{ id: 'a1', taskId: 't1', agentId: 'scout', projectId: 'p1' }], attention: { total: 2, working: 0, byProject: { p1: 2 } } }));
  assert.deepEqual(feed.firstRef(), { projectId: 'p1', taskId: 't1' });
});

const sse = (...evs: unknown[]) => new Response(new ReadableStream({ start(c) { for (const e of evs) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); } }));

test('follow: seeds on the first connect and again on every reconnect, polls while the stream is down', async () => {
  const log: string[] = [];
  let connects = 0;
  let stop = false;
  const fetchFn = (async (url: string) => {
    if (String(url).endsWith('/api/events')) { connects++; log.push('connect'); return connects === 2 ? new Response('no', { status: 500 }) : sse({ type: 'away.updated' }); }
    return new Response('{"total":3,"working":0,"byProject":{}}');
  }) as unknown as typeof fetch;
  await follow({
    core: () => ({ port: 1, headers: {} }), fetchFn, stopped: () => stop, sleep: async () => { if (connects >= 3) stop = true; },
    onConnected: async () => { log.push('seed'); }, onEvent: () => { log.push('event'); }, onPoll: (a) => { log.push('poll:' + a.total); },
  });
  assert.deepEqual(log, ['connect', 'seed', 'event', 'poll:3', 'connect', 'poll:3', 'connect', 'seed', 'event', 'poll:3']);
});

test('proposals only: "open what needs you" names the oldest proposal the core reported; asks still come first', () => {
  const feed = new Feed();
  feed.reseed(snap({ attention: { total: 1, working: 0, byProject: { p1: 1 }, nextProposal: { projectId: 'p1', itemId: 'wi1' } } }));
  assert.deepEqual(feed.firstRef(), { projectId: 'p1', itemId: 'wi1' });
  feed.apply({ type: 'attention.updated', attention: { total: 1, working: 0, byProject: { p1: 1 }, nextProposal: { projectId: 'p1', itemId: 'wi2' } } } as never);
  assert.deepEqual(feed.firstRef(), { projectId: 'p1', itemId: 'wi2' });
  feed.reseed(snap({ approvals: [{ id: 'a1', taskId: 't1', agentId: 'scout', projectId: 'p1' }], attention: { total: 2, working: 0, byProject: { p1: 2 }, nextProposal: { projectId: 'p1', itemId: 'wi2' } } }));
  assert.deepEqual(feed.firstRef(), { projectId: 'p1', taskId: 't1' });
  feed.apply({ type: 'attention.updated', attention: { total: 0, working: 0, byProject: {} } } as never);
  feed.reseed(snap());
  assert.deepEqual(feed.firstRef(), {});
});
