import test from 'node:test';
import assert from 'node:assert/strict';
import { capAsks, countAsks, deriveAsks, digestEvents, digestState, mergeReads, NO_PROJECT, sortAsks } from '../src/shared/attention.js';
import type { Ask } from '../src/shared/attention.js';
import type { ApprovalRequest, ParkedAsk, PendingQuestion } from '../src/shared/types.js';

const iso = (min: number): string => new Date(Date.UTC(2026, 9, 14, 12, min)).toISOString();
const apr = (id: string, toolName: string, input: Record<string, unknown>, min: number, extra: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ id, taskId: `t-${id}`, agentId: 'scout', toolName, summary: '', input, at: iso(min), ...extra });
const question = (id: string, min: number, projectId?: string): PendingQuestion => ({ id, taskId: `t-${id}`, agentId: 'scribe', questions: [], at: iso(min), ...(projectId ? { projectId } : {}) });
const parked = (id: string, min: number): ParkedAsk => ({ id, kind: 'approval', taskId: `t-${id}`, agentId: 'builder', projectId: 'p1', toolName: 'Bash', summary: 's', consequence: { level: 3, tags: ['leaves'], chip: 'c', certain: true }, askedAt: iso(min), parkedAt: iso(min + 3) });

test('deriveAsks counts approvals, questions, parked asks and proposals', () => {
  const asks = deriveAsks({
    approvals: [apr('a1', 'Bash', { command: 'git push' }, 1, { projectId: 'p1' })],
    questions: [question('q1', 2, 'p2')],
    parked: [parked('k1', 3)],
    proposals: [{ id: 'i1', projectId: 'p1', createdAt: iso(4), createdBy: { kind: 'agent', id: 'scout' } }],
  });
  assert.deepEqual(asks.map((a) => a.kind).sort(), ['approval', 'parked', 'proposal', 'question']);
  assert.equal(asks.find((a) => a.kind === 'question')!.consequence.level, 0);
  assert.equal(asks.find((a) => a.kind === 'proposal')!.consequence.level, 2);
});

test('an ask with no project on the request finds it through its task, else none', () => {
  const asks = deriveAsks({
    approvals: [apr('a1', 'Bash', { command: 'ls' }, 1), apr('a2', 'Bash', { command: 'ls' }, 2)],
    tasks: [{ id: 't-a1', projectId: 'p9' }],
  });
  assert.equal(asks.find((a) => a.id === 'a1')!.projectId, 'p9');
  assert.equal(asks.find((a) => a.id === 'a2')!.projectId, null);
});

test('an approval without a consequence is classified here, and unknown tools are level 3', () => {
  const [a] = deriveAsks({ approvals: [apr('a1', 'mcp__x__y', {}, 1)] });
  assert.equal(a!.consequence.level, 3);
  assert.equal(a!.consequence.certain, false);
});

test('counts agree across every derivation of the same asks', () => {
  const asks = deriveAsks({
    approvals: [apr('a1', 'Bash', { command: 'ls' }, 1, { projectId: 'p1' }), apr('a2', 'Bash', { command: 'ls' }, 2)],
    questions: [question('q1', 3, 'p1')],
    proposals: [{ id: 'i1', projectId: 'p1', createdAt: iso(4), createdBy: { kind: 'owner' } }],
  });
  const c = countAsks(asks);
  assert.equal(c.total, 4);
  assert.deepEqual(c.byProject, { p1: 3, [NO_PROJECT]: 1 });
  assert.equal(Object.values(c.byProject).reduce((n, v) => n + v, 0), asks.length);
  // sorting and capping never change the count
  assert.equal(countAsks(sortAsks(asks)).total, c.total);
});

test('sort: consequence level descending, then oldest first', () => {
  const mk = (id: string, level: 0 | 1 | 2 | 3, min: number): Ask => ({ id, kind: 'approval', agentId: 'a', projectId: null, at: iso(min), consequence: { level, tags: [], chip: '', certain: true } });
  const sorted = sortAsks([mk('low-old', 1, 1), mk('hi-new', 3, 9), mk('hi-old', 3, 2), mk('mid', 2, 0)]);
  assert.deepEqual(sorted.map((a) => a.id), ['hi-old', 'hi-new', 'mid', 'low-old']);
});

test('an unknown consequence sorts first', () => {
  const asks = deriveAsks({ approvals: [apr('safe', 'Read', { file_path: 'a' }, 1), apr('odd', 'mcp__x__y', {}, 5)] });
  assert.equal(sortAsks(asks)[0]!.id, 'odd');
});

test('top 3 at full size, the rest counted exactly', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const r = capAsks(ids);
  assert.deepEqual(r.shown, ['a', 'b', 'c']);
  assert.equal(r.more, 2);
  assert.deepEqual(capAsks(['a']), { shown: ['a'], more: 0 });
  assert.equal(capAsks([], 3).more, 0);
});

test('merge: repeated reads in one folder by one agent become one group; other asks stay rows', () => {
  const reads = [
    apr('r1', 'Read', { file_path: 'D:/p/src/a.ts' }, 1),
    apr('r2', 'Read', { file_path: 'D:/p/src/b.ts' }, 2),
    apr('r3', 'Read', { file_path: 'D:/p/lib/c.ts' }, 3),
    apr('r4', 'Read', { file_path: 'D:\\p\\src\\d.ts' }, 4),
    apr('x1', 'Bash', { command: 'rm -rf x' }, 5),
  ];
  const { groups, singles } = mergeReads(reads);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.ids.sort(), ['r1', 'r2', 'r4']);
  assert.equal(groups[0]!.at, iso(1));
  assert.deepEqual(singles.map((s) => s.id).sort(), ['r3', 'x1']);
});

test('merge: reads by two agents are not merged; a command is never merged', () => {
  const { groups } = mergeReads([
    apr('r1', 'Read', { file_path: 'D:/p/a' }, 1, { agentId: 'one' }),
    apr('r2', 'Read', { file_path: 'D:/p/b' }, 2, { agentId: 'two' }),
    apr('b1', 'Bash', { command: 'ls' }, 3), apr('b2', 'Bash', { command: 'ls' }, 4),
  ]);
  assert.equal(groups.length, 0);
});

const task = (id: string, status: 'done' | 'error' | 'running', min: number, error?: string) => ({ id, status, updatedAt: iso(min), ...(error ? { error } : {}) });

test('digest events: failed, stopped, finished since the window opened', () => {
  const ev = digestEvents({
    sinceMs: Date.parse(iso(10)),
    tasks: [
      task('old', 'done', 5), task('ok', 'done', 11), task('bad', 'error', 12, 'the build exited'),
      task('lim', 'error', 13, 'Paused at the turn limit (200)'), task('park', 'error', 14, 'Parked, waiting for your answer'), task('live', 'running', 15),
    ],
    boardInReview: [{ updatedAt: iso(12) }, { updatedAt: iso(1) }],
    spendUsd: 6.1,
  });
  assert.deepEqual(ev.finished.map((t) => t.id), ['ok']);
  assert.deepEqual(ev.failed.map((t) => t.id), ['bad']);
  assert.deepEqual(ev.stopped.map((t) => t.id), ['lim']);
  assert.equal(ev.inReview.length, 1);
  assert.equal(ev.spendUsd, 6.1);
});

test('quiet state still lists every open ask, riskiest first', () => {
  const asks = deriveAsks({ approvals: [apr('a1', 'Read', { file_path: 'a' }, 1), apr('a2', 'mcp__x__y', {}, 2)] });
  const ev = digestEvents({ sinceMs: Date.parse(iso(30)), tasks: [] });
  const st = digestState(asks, ev, Date.parse(iso(30)));
  assert.equal(st.quiet, true);
  assert.equal(st.needYou, 2);
  assert.deepEqual(st.open.map((a) => a.id), ['a2', 'a1']);
});

test('a new ask or a new event means not quiet', () => {
  const asks = deriveAsks({ approvals: [apr('a1', 'Bash', { command: 'ls' }, 40)] });
  assert.equal(digestState(asks, digestEvents({ sinceMs: Date.parse(iso(30)), tasks: [] }), Date.parse(iso(30))).quiet, false);
  const ev = digestEvents({ sinceMs: Date.parse(iso(30)), tasks: [task('t', 'done', 35)] });
  assert.equal(digestState([], ev, Date.parse(iso(30))).quiet, false);
});
