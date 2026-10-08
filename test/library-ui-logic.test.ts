/** Library UI helpers with real logic: diff of an edit proposal, bulk-accept plan, undo reasons. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/kg/graph.js';
import { agentActor, HUMAN } from '../src/core/kg/types.js';
import {
  activityVerb, agentCounts, bulkSummary, collapseDiff, diffChanged, diffStats, editDelta, humanizeIds, idsIn, inboxKindLabel, lineDiff, parseTags, planBulk, previewText, skipNote, undoState,
} from '../src/shared/kg-library.js';
import { mkGraph, note } from './kg-helpers.js';

test('lineDiff: identical, added, removed and replaced lines in order', () => {
  assert.deepEqual(lineDiff('a\nb', 'a\nb').map((l) => l.kind), ['same', 'same']);
  assert.equal(diffChanged(lineDiff('a', 'a')), false);
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nc'), [{ kind: 'same', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'same', text: 'c' }]);
  assert.deepEqual(lineDiff('we chose postgres', 'we chose postgres 16'), [{ kind: 'del', text: 'we chose postgres' }, { kind: 'add', text: 'we chose postgres 16' }]);
  assert.deepEqual(lineDiff('', 'new\ntext'), [{ kind: 'add', text: 'new' }, { kind: 'add', text: 'text' }]);
  assert.deepEqual(lineDiff('old', ''), [{ kind: 'del', text: 'old' }]);
  assert.deepEqual(lineDiff('', ''), []);
  assert.deepEqual(lineDiff('a\r\nb', 'a\nb').map((l) => l.kind), ['same', 'same'], 'CRLF does not show as a change');
  assert.deepEqual(diffStats(lineDiff('a\nb\nc', 'a\nx\ny\nc')), { added: 2, removed: 1 });
});

test('lineDiff: rebuilding both sides from the diff gives back the inputs (random texts)', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  const pool = ['alpha', 'beta', 'gamma', 'delta', '', 'eps'];
  for (let n = 0; n < 60; n++) {
    const mk = () => Array.from({ length: rnd() % 12 }, () => pool[rnd() % pool.length]!).join('\n');
    const a = mk();
    const b = mk();
    const d = lineDiff(a, b);
    const left = d.filter((l) => l.kind !== 'add').map((l) => l.text).join('\n');
    const right = d.filter((l) => l.kind !== 'del').map((l) => l.text).join('\n');
    // an empty string and one empty line both split to zero or one line: compare after the same normalisation
    assert.equal(left, a === '' ? '' : a, `left of ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    assert.equal(right, b === '' ? '' : b, `right of ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
});

test('lineDiff: very long texts fall back to remove-all / add-all instead of an O(n*m) table', () => {
  const big = Array.from({ length: 450 }, (_, i) => `line ${i}`).join('\n');
  const d = lineDiff(big, big + '\nmore');
  assert.equal(diffStats(d).removed, 450);
  assert.equal(diffStats(d).added, 451);
});

test('collapseDiff folds unchanged runs but keeps context around changes', () => {
  const before = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n');
  const after = before.replace('l6', 'CHANGED');
  const c = collapseDiff(lineDiff(before, after), 2);
  assert.equal(c[0]!.kind, 'skip');
  assert.equal((c[0] as { count: number }).count, 4);
  assert.equal(c.at(-1)!.kind, 'skip');
  assert.deepEqual(c.filter((l) => l.kind === 'del' || l.kind === 'add').length, 2);
  assert.deepEqual(collapseDiff([{ kind: 'same', text: 'a' }, { kind: 'same', text: 'b' }], 2), [{ kind: 'skip', count: 2 }]);
});

test('planBulk: untrusted rows are held back unless explicitly included; unselected rows are never touched', () => {
  const rows = [{ id: 'a', untrusted: false }, { id: 'b', untrusted: true }, { id: 'c', untrusted: false }, { id: 'd', untrusted: true }];
  const p = planBulk(rows, ['a', 'b', 'c'], false);
  assert.deepEqual(p.accept, ['a', 'c']);
  assert.deepEqual(p.skip.map((s) => s.id), ['b']);
  assert.match(p.skip[0]!.reason, /untrusted source/);
  assert.equal(p.untrusted, 1);
  const q = planBulk(rows, new Set(['a', 'b']), true);
  assert.deepEqual(q.accept, ['a', 'b']);
  assert.deepEqual(q.skip, []);
  assert.deepEqual(planBulk(rows, [], false), { accept: [], skip: [], untrusted: 0 });
  assert.deepEqual(planBulk(rows, ['ghost'], false), { accept: [], skip: [], untrusted: 0 }, 'ids that are not rows are ignored');
});

test('planBulk agrees with the core: acceptMany skips exactly the rows the plan holds back', () => {
  const { g } = mkGraph();
  const human = note(g, 'Human decision', { type: 'decision', body: 'chose postgres' });
  const human2 = note(g, 'Human pattern', { type: 'pattern', body: 'retry with backoff' });
  const dirty = agentActor('alpha', { taskId: 'tA', taint: () => true });
  const clean = agentActor('beta', { taskId: 'tB' });
  const web = g.upsertNode(dirty, { title: 'From the web', body: 'advice', scope: 'shared' }).node;
  const src = g.upsertNode(clean, { id: human2.id, body: 'retry with jitter', sources: [{ ref: 'https://x.test', untrusted: true }] }).node;
  const edit = g.upsertNode(clean, { id: human.id, body: 'chose postgres 16' }).node;
  const rows = g.inbox(HUMAN);
  assert.equal(rows.length, 3);
  const ids = rows.map((r) => r.id);
  const plan = planBulk(rows, ids, false);
  const res = g.acceptMany(HUMAN, { ids, overrideUntrusted: false });
  assert.deepEqual([...res.accepted].sort(), [...plan.accept].sort());
  assert.deepEqual(res.skipped.map((s) => s.id).sort(), plan.skip.map((s) => s.id).sort());
  assert.deepEqual(res.skipped.map((s) => `${s.id}:${s.code}`).sort(), plan.skip.map((s) => `${s.id}:${s.code}`).sort(), 'same reason on both sides');
  assert.deepEqual(plan.skip.map((s) => s.id).sort(), [src.id, web.id, edit.id].sort());
  assert.deepEqual(plan.accept, [], 'a change to a human note is never taken in bulk, an untrusted row only with the tick');
  assert.match(bulkSummary(res), /Nothing was accepted\. 1 held back for an untrusted source, 2 held back for review one by one \(changing your own notes\)\./);
  assert.match(skipNote(plan.skip), /^3 will be skipped: 1 untrusted source, 2 edit of your note$/);
  // with the explicit tick, the plan and the core both take what the tick covers (the web row), and still not the edits of human notes
  const rest = g.inbox(HUMAN).map((r) => r.id);
  const plan2 = planBulk(g.inbox(HUMAN), rest, true);
  const res2 = g.acceptMany(HUMAN, { ids: rest, overrideUntrusted: true });
  assert.deepEqual([...res2.accepted].sort(), [...plan2.accept].sort());
  assert.deepEqual(res2.accepted, [web.id]);
});

test('bulkSummary reads plainly for none, one, many and mixed skips', () => {
  assert.equal(bulkSummary({ accepted: [], skipped: [] }), 'Nothing was accepted.');
  assert.equal(bulkSummary({ accepted: ['a'], skipped: [] }), 'Accepted 1 note.');
  assert.equal(bulkSummary({ accepted: ['a', 'b'], skipped: [{ id: 'c', reason: 'not waiting for review' }] }), 'Accepted 2 notes. 1 skipped for another reason.');
  assert.equal(bulkSummary({ accepted: [], skipped: [{ id: 'c', reason: 'x', code: 'trigger' }, { id: 'd', reason: 'y', code: 'woken' }] }),
    'Nothing was accepted. 1 held back for review one by one (being trigger notes), 1 held back for review one by one (a bot another bot woke).');
  assert.equal(bulkSummary({ accepted: [], skipped: [{ id: 'c', reason: 'untrusted source: x' }, { id: 'd', reason: 'boom' }] }), 'Nothing was accepted. 1 held back for an untrusted source, 1 skipped for another reason.');
});

test('undoState: ok, undone, changed since, expired, too large, not undoable', () => {
  assert.deepEqual(undoState({ undoable: true, undone: false }), { can: true });
  assert.deepEqual(undoState({ undoable: false, undone: true }), { can: false, reason: 'Already undone.' });
  assert.match((undoState({ undoable: true, undone: false, blocked: 'changed' }) as { reason: string }).reason, /Changed since/);
  assert.match((undoState({ undoable: false, undone: false, blocked: 'expired' }) as { reason: string }).reason, /7 days/);
  assert.match((undoState({ undoable: false, undone: false, blocked: 'too_large' }) as { reason: string }).reason, /Too large/);
  assert.equal(undoState({ undoable: false, undone: false }).can, false);
});

test('undoState follows the real Graph for every case the feed can show', () => {
  let t = Date.parse('2026-10-01T10:00:00Z');
  const g = new Graph({ dir: mkGraph().dir, bsvEnabled: () => false, now: () => new Date(t) });
  const bot = agentActor('alpha', { taskId: 'tA' });
  g.upsertNode(bot, { title: 'First', body: 'a', scope: 'shared' });
  const second = g.upsertNode(bot, { title: 'Second', body: 'b', scope: 'shared' }).node;
  const feed = () => g.activityFeed(HUMAN);
  assert.ok(feed().every((r) => undoState(r).can));
  const start = Date.now(); while (Date.now() - start < 5) { /* node updatedAt uses the real clock */ }
  g.upsertNode(HUMAN, { id: second.id, body: 'b2' });
  const changed = feed().find((r) => r.nodeId === second.id)!;
  assert.equal(undoState(changed).can, false);
  const ok = feed().find((r) => r.nodeId !== second.id)!;
  g.undo(HUMAN, ok.id);
  assert.deepEqual(undoState(feed().find((r) => r.id === ok.id)!), { can: false, reason: 'Already undone.' });
});

test('small label helpers', () => {
  assert.equal(activityVerb('capture'), 'captured');
  assert.equal(activityVerb('sweep'), 'retired a batch');
  assert.equal(activityVerb('something_new'), 'something_new', 'unknown kinds are shown as they are');
  assert.equal(inboxKindLabel('sweep'), 'Retire several notes');
  assert.equal(inboxKindLabel('supersede'), 'Replace a note');
  assert.deepEqual(agentCounts([{ agentId: 'b' }, { agentId: 'a' }, { agentId: 'b' }]), [{ agentId: 'b', count: 2 }, { agentId: 'a', count: 1 }]);
  assert.equal(previewText('  one   two\nthree  '), 'one two three');
  const long = ('word '.repeat(80)).trim();
  const p = previewText(long, 50);
  assert.ok(p.length <= 51 && p.endsWith('…') && !p.includes('wor…'), p);
});

test('editDelta sends only what changed, and nothing for an untouched draft (an untouched "edit" must stay a plain accept)', () => {
  const node = { title: 'Fee table', body: 'sat/kB 0.5', tags: ['bsv', 'fees'] };
  assert.equal(editDelta(node, { title: 'Fee table', body: 'sat/kB 0.5', tags: ['bsv', 'fees'] }), undefined);
  assert.equal(editDelta(node, { title: '  Fee table ', body: 'sat/kB 0.5', tags: ['#bsv', 'fees', 'fees'] }), undefined, 'whitespace, # and duplicates are not changes');
  assert.deepEqual(editDelta(node, { title: 'Fee table', body: 'sat/kB 1', tags: ['bsv', 'fees'] }), { body: 'sat/kB 1' });
  assert.deepEqual(editDelta(node, { title: 'Fees', body: 'sat/kB 0.5', tags: ['bsv'] }), { title: 'Fees', tags: ['bsv'] });
  assert.deepEqual(editDelta(node, { title: 'Fee table', body: 'sat/kB 0.5', tags: [] }), { tags: [] });
  assert.deepEqual(parseTags('a, #b  c,,a'), ['a', 'b', 'c']);
});

test('an untouched edit is a plain accept (trust stays agent for a tainted note); a real edit makes it human', () => {
  const { g } = mkGraph();
  const dirty = agentActor('alpha', { taskId: 'tA', taint: () => true });
  const a = g.upsertNode(dirty, { title: 'Web advice', body: 'use X', scope: 'shared' }).node;
  const b = g.upsertNode(dirty, { title: 'More advice', body: 'use Y', scope: 'shared' }).node;
  const untouched = editDelta(a, { title: a.title, body: a.body, tags: a.tags });
  assert.equal(untouched, undefined);
  assert.equal(g.acceptPending(HUMAN, a.id, untouched ? { edit: untouched } : {}).trust, 'agent');
  const real = editDelta(b, { title: b.title, body: 'use Y, checked by me', tags: b.tags })!;
  const done = g.acceptPending(HUMAN, b.id, { edit: real });
  assert.equal(done.trust, 'human');
  assert.equal(done.origin?.tainted, false);
});

test('humanizeIds swaps known node ids in a title and leaves unknown ones and other text alone', () => {
  const t = 'Proposal: merge n_dc0cd5117f4d into n_ae7ea8513a13 (see n_0badc0de99)';
  assert.deepEqual(idsIn(t), ['n_dc0cd5117f4d', 'n_ae7ea8513a13', 'n_0badc0de99']);
  const names: Record<string, string> = { n_dc0cd5117f4d: 'Release process (older copy)', n_ae7ea8513a13: 'Release process' };
  assert.equal(humanizeIds(t, (id) => names[id]), 'Proposal: merge “Release process (older copy)” into “Release process” (see n_0badc0de99)');
  assert.equal(humanizeIds('no ids here, n_x is too short', () => 'T'), 'no ids here, n_x is too short');
  assert.deepEqual(idsIn('a -relates-> b'), []);
});
