/**
 * A hub with many spokes (one note linked from 58 others) made the Lattice blank: every spoke pulled the hub at full spring
 * strength each tick, the explicit integration overshot and grew, and node positions reached ~1e132 (live check 2026-10-15).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim } from '../ui/src/graph/layout.js';
import type { KgEdge, KgNode } from '../src/shared/kg.js';

const node = (id: string): KgNode => ({ id, type: 'concept', title: id, body: '', tags: [], scope: 'shared' } as unknown as KgNode);
const edge = (from: string, to: string): KgEdge => ({ id: `${from}>${to}`, from, to, rel: 'relates_to', createdBy: 'human', createdAt: '2026-10-15T00:00:00Z' } as unknown as KgEdge);

function star(spokes: number, extra = 0): Sim {
  const nodes = [node('hub'), ...Array.from({ length: spokes + extra }, (_, i) => node(`n${i}`))];
  const edges = Array.from({ length: spokes }, (_, i) => edge(`n${i}`, 'hub'));
  const sim = new Sim();
  sim.setData(nodes, edges);
  return sim;
}

const finiteAndNear = (sim: Sim, limit: number): void => {
  for (const n of sim.nodes) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.id} has a finite position`);
    assert.ok(Math.abs(n.x) < limit && Math.abs(n.y) < limit, `${n.id} stays near the centre (${n.x}, ${n.y})`);
  }
};

test('a hub with 58 spokes settles to a finite, bounded layout', () => {
  const sim = star(58, 1);
  sim.settle();
  finiteAndNear(sim, 5000);
});

test('the animated loop stays bounded too: many frames at full heat do not diverge', () => {
  const sim = star(58, 1);
  for (let i = 0; i < 2000; i++) { if (i % 300 === 0) sim.alpha = 1; sim.tick(); }
  finiteAndNear(sim, 5000);
});

test('very large hubs (300 spokes) stay bounded', () => {
  const sim = star(300);
  for (let i = 0; i < 800; i++) sim.tick();
  finiteAndNear(sim, 20000);
});

test('spokes keep a readable distance from the hub (the layout still spreads, it is not collapsed)', () => {
  const sim = star(58, 1);
  sim.settle();
  const hub = sim.byId.get('hub')!;
  const near = sim.nodes.filter((n) => n.id !== 'hub' && Math.hypot(n.x - hub.x, n.y - hub.y) < hub.r).length;
  assert.equal(near, 0, 'no spoke sits on top of the hub');
});
