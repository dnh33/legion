import test from 'node:test';
import assert from 'node:assert/strict';
import { AttentionTracker } from '../src/core/away/index.js';

const bus = () => ({ on: () => () => {}, emit: () => {} }) as never;
const deps = (inbox: Array<{ id: string; projectId: string; createdAt: string; createdBy: { kind: 'agent'; id: string } }>) => ({
  bus: bus(), approvals: { pending: () => [] }, store: { getTask: () => undefined }, working: () => 0, inbox: () => inbox,
});

test('the attention view names the oldest waiting proposal (ids only), so "open what needs you" can open it', () => {
  const t = new AttentionTracker(deps([
    { id: 'wi-new', projectId: 'p1', createdAt: '2026-10-14T12:00:00Z', createdBy: { kind: 'agent', id: 'forge' } },
    { id: 'wi-old', projectId: 'p2', createdAt: '2026-10-14T09:00:00Z', createdBy: { kind: 'agent', id: 'forge' } },
  ]));
  assert.deepEqual(t.get().nextProposal, { projectId: 'p2', itemId: 'wi-old' });
  assert.equal(t.get().total, 2);
});
test('no proposal waiting: no nextProposal key', () => {
  assert.equal('nextProposal' in new AttentionTracker(deps([])).get(), false);
});
