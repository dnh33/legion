/** Final-gate review fix G3: a purged tombstone of a pack node stays gone through startup repair. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/kg/graph.js';
import { applySeedPack } from '../src/core/kg/seed.js';
import type { SeedPack } from '../src/core/kg/seed.js';
import { HUMAN, mkGraph } from './kg-helpers.js';

const src = (id: string) => [{ ref: `https://docs.test/${id}`, licence: 'CC BY 4.0' }];
const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'lesson', title: `Title ${id}`, body: `body ${id}`, tags: ['bsv'], sources: src(id), confidence: 0.8, ...extra });
const pack: SeedPack = {
  version: 1,
  nodes: [node('bsv-curriculum-index', { type: 'concept' }), node('bsv-a'), node('bsv-b')] as SeedPack['nodes'],
  edges: [
    { from: 'bsv-a', to: 'bsv-curriculum-index', rel: 'part_of' },
    { from: 'bsv-b', to: 'bsv-curriculum-index', rel: 'part_of' },
    { from: 'bsv-a', to: 'bsv-b', rel: 'relates' },
  ],
};

test('G3: a pack node the human archived is not resurrected after the 30 day purge and a restart', () => {
  const clock = { t: Date.now() };
  const m = mkGraph({ now: () => new Date(clock.t) });
  m.bsv.on = true;
  applySeedPack(m.g, pack);
  m.g.setStatus(HUMAN, 'bsv-b', 'archived');
  clock.t += 31 * 86_400_000;
  assert.equal(m.g.purgeTombstones(), 1);
  assert.equal(m.g.getNode(HUMAN, 'bsv-b'), undefined);
  assert.ok(m.g.seedRemoved().nodes.includes('bsv-b'), 'the purge recorded the pack node in the removal ledger');
  // restart, then the startup repair path
  const g2 = new Graph({ dir: m.dir, bsvEnabled: () => true, now: () => new Date(clock.t) });
  const r = applySeedPack(g2, pack);
  assert.equal(g2.getNode(HUMAN, 'bsv-b'), undefined, `repair resurrected the node (status ${r.status})`);
  assert.ok(g2.getNode(HUMAN, 'bsv-a'));
});

test('G3: purging an archived note of the human own (not a pack node) records nothing', () => {
  const clock = { t: Date.now() };
  const m = mkGraph({ now: () => new Date(clock.t) });
  const n = m.g.upsertNode(HUMAN, { title: 'mine' }).node;
  m.g.setStatus(HUMAN, n.id, 'archived');
  clock.t += 31 * 86_400_000;
  assert.equal(m.g.purgeTombstones(), 1);
  assert.deepEqual(m.g.seedRemoved().nodes, []);
});
