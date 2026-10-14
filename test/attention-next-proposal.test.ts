import test from 'node:test';
import assert from 'node:assert/strict';
import { AttentionTracker } from '../src/core/away/index.js';

const bus = () => ({ on: () => () => {}, emit: () => {} }) as never;
const wi = (id: string, projectId: string, createdAt: string, agent = 'forge') => ({ id, projectId, createdAt, createdBy: { kind: 'agent' as const, id: agent } });
const deps = (inbox: ReturnType<typeof wi>[], extra: Record<string, unknown> = {}) => ({
  bus: bus(), approvals: { pending: () => [] }, store: { getTask: () => undefined }, working: () => 0, inbox: () => inbox, ...extra,
});

test('the attention view names the oldest waiting proposal with its agent (ids only)', () => {
  const t = new AttentionTracker(deps([wi('wi-new', 'p1', '2026-10-14T12:00:00Z'), wi('wi-old', 'p2', '2026-10-14T09:00:00Z', 'scout')]));
  assert.deepEqual(t.get().nextProposal, { projectId: 'p2', itemId: 'wi-old', agentId: 'scout' });
  assert.equal(t.get().total, 2);
});
test('no proposal waiting: no nextProposal key', () => {
  assert.equal('nextProposal' in new AttentionTracker(deps([])).get(), false);
});
test('a proposal of an agent the caller may not see is never named', () => {
  const t = new AttentionTracker(deps([wi('hidden', 'p1', '2026-10-14T08:00:00Z', 'secret'), wi('ok', 'p1', '2026-10-14T09:00:00Z')], { agentOk: (id: string) => id !== 'secret' }));
  assert.deepEqual(t.get().nextProposal, { projectId: 'p1', itemId: 'ok', agentId: 'forge' });
});
test('a proposal in an archived project is skipped', () => {
  const t = new AttentionTracker(deps([wi('arch', 'pa', '2026-10-14T08:00:00Z'), wi('live', 'p1', '2026-10-14T09:00:00Z')], { projectActive: (id: string) => id !== 'pa' }));
  assert.deepEqual(t.get().nextProposal, { projectId: 'p1', itemId: 'live', agentId: 'forge' });
  const none = new AttentionTracker(deps([wi('arch', 'pa', '2026-10-14T08:00:00Z')], { projectActive: () => false }));
  assert.equal('nextProposal' in none.get(), false);
});
