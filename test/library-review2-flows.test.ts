import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Graph } from '../src/core/kg/graph.js';
import { agentActor, HUMAN } from '../src/core/kg/types.js';

const mk = () => new Graph({ dir: mkdtempSync(join(tmpdir(), 'r2f-')) });

test('R2-L1 legit flows: bot own-note update, human edit, human accept of tainted pending, edit-accept, bulk accept of archivist rows', () => {
  const g = mk();
  const bot = (t: string, taint = false) => agentActor('alpha', { taskId: t, taint: () => taint });
  const n = g.upsertNode(bot('T1'), { title: 'Own note', body: 'v1', scope: 'shared' }).node;
  assert.equal(n.status, undefined);
  const up = g.upsertNode(bot('T1'), { id: n.id, body: 'v2' });
  assert.equal(up.node.body, 'v2'); assert.equal(up.node.status, undefined);
  const h = g.upsertNode(HUMAN, { id: n.id, title: 'Own note (edited by human)' });
  assert.equal(h.node.title, 'Own note (edited by human)');
  const t = g.upsertNode(bot('T2', true), { title: 'From the web', body: 'w', scope: 'shared', sources: [{ ref: 'https://x.test', untrusted: true }] as never }).node;
  assert.equal(t.status, 'pending');
  g.acceptPending(HUMAN, t.id);
  assert.equal(g.getNode(HUMAN, t.id)!.status, undefined);
  const arch = agentActor('archivist', { taskId: 'A1' });
  const a1 = g.upsertNode(arch, { title: 'Archivist flag 1', body: 'x', scope: 'shared' }).node;
  const a2 = g.upsertNode(arch, { title: 'Archivist flag 2', body: 'y', scope: 'shared' }).node;
  const r = g.acceptMany(HUMAN, {});
  console.log('R2-L1 bulk', JSON.stringify(r));
  assert.deepEqual(r.accepted.sort(), [a1.id, a2.id].sort());
});

test('R2-L2 clean note then taint then rewrite of the SAME note: rejecting the held rewrite must not destroy the earlier clean note', () => {
  const g = mk();
  let tainted = false;
  const bot = agentActor('alpha', { taskId: 'T1', taint: () => tainted });
  const n = g.upsertNode(bot, { title: 'Deploy checklist', body: 'clean knowledge worth keeping', scope: 'shared' }).node;
  tainted = true;
  const r = g.upsertNode(bot, { id: n.id, body: 'now with web text' });
  const inbox = g.inbox(HUMAN);
  console.log('R2-L2 after rewrite status', r.node.status, 'inbox kinds', JSON.stringify(inbox.map((x) => x.kind)));
  g.rejectPending(HUMAN, n.id);
  const live = g.allNodes(agentActor('beta', { taskId: 'B' })).find((x) => x.title === 'Deploy checklist');
  assert.ok(live && live.body === 'clean knowledge worth keeping', 'the clean note vanished for every other bot after the human rejected the tainted rewrite');
});

test('R2-L3 a held rewrite made while the note was live: other bots meanwhile lose the note entirely (it is pending in place, not a proposal copy)', () => {
  const g = mk();
  let tainted = false;
  const bot = agentActor('alpha', { taskId: 'T1', taint: () => tainted });
  const n = g.upsertNode(bot, { title: 'Port map', body: 'api 4747', scope: 'shared' }).node;
  tainted = true;
  g.upsertNode(bot, { id: n.id, body: 'api 4747 plus web junk' });
  const seen = g.search(agentActor('beta', { taskId: 'B' }), 'port map', { limit: 5 });
  assert.ok(seen.length > 0, 'a live clean note disappeared from recall because the author later touched the web');
});

test('R2-L4 human edit of a bot note keeps working after restart; rev strictly increases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2f4-'));
  const g = new Graph({ dir });
  const bot = agentActor('alpha', { taskId: 'T1' });
  const n = g.upsertNode(bot, { title: 'rev note', body: 'a', scope: 'shared' }).node;
  g.upsertNode(HUMAN, { id: n.id, body: 'b' });
  g.upsertNode(bot, { id: n.id, body: 'c' });
  const g2 = new Graph({ dir });
  assert.equal(g2.getNode(HUMAN, n.id)!.rev, g.getNode(HUMAN, n.id)!.rev);
  const row = g2.activityFeed(HUMAN, { limit: 5 }).find((r) => r.kind === 'update')!;
  assert.doesNotThrow(() => g2.undo(HUMAN, row.id));
  assert.equal(g2.getNode(HUMAN, n.id)!.body, 'b');
});

test('R2-L5 a tainted run may not plant trigger tags, in any spelling the tag normaliser folds to trigger:', () => {
  const g = mk();
  const tainted = agentActor('alpha', { taskId: 'T1', taint: () => true });
  const stored: string[] = [];
  for (const tag of ['trigger:always', '#trigger:always', 'TRIGGER:always', 'Trigger:Always', ' trigger:always', '##trigger:always', 'trigger: always']) {
    try {
      const r = g.upsertNode(tainted, { title: `t ${tag}`, body: 'x', tags: [tag], scope: 'shared' });
      if (r.node.tags.some((x) => x.startsWith('trigger:'))) stored.push(`${JSON.stringify(tag)} -> ${JSON.stringify(r.node.tags)} status ${r.node.status}`);
    } catch { /* refused */ }
  }
  console.log('R2-L5 stored trigger tags from tainted run:', JSON.stringify(stored));
  assert.deepEqual(stored, []);
});
