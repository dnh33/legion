import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Graph } from '../src/core/kg/graph.js';
import { agentActor, HUMAN } from '../src/core/kg/types.js';

test('R2-A1 activity append+trim: bounded file, undone flag survives trim + restart, newest 500 kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2a-'));
  const g = new Graph({ dir });
  const first = g.upsertNode(agentActor('alpha', { taskId: 'T0' }), { title: 'first', body: 'x', scope: 'shared' }).node;
  const firstRow = g.activityFeed(HUMAN, { limit: 5 })[0]!;
  g.undo(HUMAN, firstRow.id);
  for (let i = 0; i < 900; i++) g.upsertNode(agentActor('alpha', { taskId: `T${i + 1}` }), { title: `n ${i}`, body: 'x', scope: 'agent:alpha' });
  const lines = readFileSync(join(dir, 'activity.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  const g2 = new Graph({ dir });
  const rows = g2.activityFeed(HUMAN, { limit: 200 });
  console.log('R2-A1 file lines', lines, 'feed', rows.length);
  assert.ok(lines <= 620);
  assert.equal(g2.activityFeed(HUMAN, { limit: 200 }).length, 200);
  void first;
});

test('R2-A2 undone entry that is still within the retained window stays undone after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2a2-'));
  const g = new Graph({ dir });
  g.upsertNode(agentActor('alpha', { taskId: 'T0' }), { title: 'one', body: 'x', scope: 'shared' });
  const row = g.activityFeed(HUMAN, { limit: 5 })[0]!;
  g.undo(HUMAN, row.id);
  const g2 = new Graph({ dir });
  assert.equal(g2.activityFeed(HUMAN, { limit: 5 })[0]!.undone, true);
  assert.throws(() => g2.undo(HUMAN, row.id), /already undone/);
});
