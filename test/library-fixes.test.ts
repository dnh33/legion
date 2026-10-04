/** Fix-round additions: seed-phrase false positives, and old logs (no rev, no begin/commit) still load. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findForbiddenSecret, findForbiddenSecretInField } from '../src/core/comms/scrub.js';
import { Graph } from '../src/core/kg/graph.js';
import { agentActor } from '../src/core/kg/types.js';
import { HUMAN, mkGraph } from './kg-helpers.js';

const PROSE = [
  'We decided to keep the queue in memory because the disk adds latency and the team prefers a simple design that can be rebuilt from the log after a crash.',
  'The recovery plan: first stop the worker, then check the log, then restart the service, then watch the dashboard for ten minutes, then write down what happened.',
  'seed data for the staging database lives in the seeds folder and is loaded by the setup script when the container starts for the first time today',
  'Backup: daily snapshots, weekly archives, monthly cold storage, yearly audits, plus a quarterly restore drill that proves the whole thing works end to end.',
  'Shopping list for the weekend: apple banana cherry grape lemon mango melon peach pear plum lime fig date kiwi guava and some bread.',
  'the quick brown fox jumps over the lazy dog while the cat sleeps by the warm fire and the rain falls on the old stone roof outside',
];

test('seed detection: ordinary English paragraphs and word lists are not mistaken for a seed phrase', () => {
  for (const p of PROSE) {
    assert.equal(findForbiddenSecret(p), undefined, `false positive on: ${p}`);
    assert.equal(findForbiddenSecretInField(p), undefined, `false positive (field) on: ${p}`);
  }
});

test('seed detection: Danish prose and Danish ASCII prose are not seed phrases, with or without a label', () => {
  const danish = [
    'Vi besluttede at beholde køen i hukommelsen, fordi disken tilføjer forsinkelse, og holdet foretrækker et enkelt design som kan genopbygges fra loggen efter et nedbrud.',
    'backup: det hele bliver gemt hver nat paa serveren hos den store kunde som vil have det saadan hver eneste dag i aaret',
    'Gendannelsesplan: stop arbejderen, tjek loggen, genstart tjenesten, hold øje med dashboardet i ti minutter og skriv ned hvad der skete.',
    'seed data til staging ligger i mappen seeds og indlæses af opsætningsscriptet første gang containeren starter i dag',
  ];
  for (const p of danish) {
    assert.equal(findForbiddenSecret(p), undefined, p);
    assert.equal(findForbiddenSecretInField(p), undefined, p);
  }
});

test('seed detection: a list of twelve fruits, folders or frameworks is a list, a real phrase in any layout is a phrase', () => {
  assert.equal(findForbiddenSecret('apple banana cherry grape lemon mango melon olive peach pear plum lime'), undefined);
  assert.equal(findForbiddenSecret('react vue angular svelte solid preact alpine htmx astro remix next nuxt'), undefined);
  const phrase = 'army van defense carry jealous true garbage claim echo media make crunch';
  assert.equal(findForbiddenSecret(phrase), 'seed phrase');
  assert.equal(findForbiddenSecret(`Fruit I want to buy: ${phrase}.`), 'seed phrase', 'a label is not needed and prose around it does not hide it');
});

test('seed detection: a normal note with these paragraphs is accepted by the graph (no guard refusal)', () => {
  const { g } = mkGraph();
  for (const [i, p] of PROSE.entries()) assert.doesNotThrow(() => g.upsertNode(HUMAN, { title: `prose ${i}`, body: p }), p);
});

test('seed detection: a labelled and an unlabelled list of twelve seed words are both caught', () => {
  const words = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  assert.equal(findForbiddenSecret(`my seed phrase is: ${words}`), 'seed phrase');
  assert.equal(findForbiddenSecret(`Mnemonic - ${words.split(' ').map((w, i) => `${i + 1}. ${w}`).join(' ')}`), 'seed phrase');
  assert.equal(findForbiddenSecretInField(words), 'seed phrase');
  assert.equal(findForbiddenSecretInField(words.toUpperCase().toLowerCase().split(' ').join(' ')), 'seed phrase', 'non-breaking spaces do not hide it');
});

const rewrite = (file: string, fn: (l: string) => string | undefined): void => {
  const out = readFileSync(file, 'utf8').split('\n').map((l) => (l ? fn(l) : l)).filter((l) => l !== undefined);
  writeFileSync(file, (out as string[]).join('\n'));
};

test('old logs still load: multi-op appends without begin/commit markers replay as before', () => {
  const dir = cleanupTemp('legion-fix-');
  const g = new Graph({ dir });
  const a = agentActor('alpha', { taskId: 'T' });
  const nodes = ['one', 'two', 'keep'].map((t) => g.upsertNode(a, { title: `note ${t}`, body: t }).node);
  g.merge(a, nodes[2]!.id, [nodes[0]!.id, nodes[1]!.id]);
  const expected = JSON.stringify(g.getNode(HUMAN, nodes[0]!.id));
  const raw = readFileSync(join(dir, 'graph.jsonl'), 'utf8');
  assert.ok(raw.includes('"begin"') && raw.includes('"commit"'), 'precondition: the merge was written as a batch');
  rewrite(join(dir, 'graph.jsonl'), (l) => (/"op":"(begin|commit)"/.test(l) ? undefined : l));
  const g2 = new Graph({ dir });
  assert.equal(g2.getNode(HUMAN, nodes[0]!.id)!.status, 'archived');
  assert.equal(JSON.stringify(g2.getNode(HUMAN, nodes[0]!.id)), expected);
  assert.equal(g2.getNode(HUMAN, nodes[2]!.id)!.title, 'note keep');
});

test('old logs still load: nodes and activity stamps written before the revision counter existed', () => {
  const dir = cleanupTemp('legion-fix-');
  const g = new Graph({ dir });
  const a = agentActor('alpha', { taskId: 'T' });
  const n = g.upsertNode(a, { title: 'old note', body: 'v1' }).node;
  g.upsertNode(a, { id: n.id, body: 'v2' });
  const u = g.activityFeed(HUMAN, { limit: 1 })[0]!;
  // strip every rev from the graph log and turn the activity stamps into the old string form (the updatedAt)
  rewrite(join(dir, 'graph.jsonl'), (l) => l.replace(/,"rev":\d+/g, '').replace(/"rev":\d+,/g, ''));
  rewrite(join(dir, 'activity.jsonl'), (l) => {
    const e = JSON.parse(l);
    if (e.stamps) for (const k of Object.keys(e.stamps)) e.stamps[k] = g.getNode(HUMAN, k)?.updatedAt ?? e.stamps[k];
    return JSON.stringify(e);
  });
  const g2 = new Graph({ dir });
  const loaded = g2.getNode(HUMAN, n.id)!;
  assert.equal(loaded.body, 'v2');
  assert.ok((loaded.rev ?? 1) >= 1);
  g2.undo(HUMAN, u.id);
  assert.equal(g2.getNode(HUMAN, n.id)!.body, 'v1', 'undo works with an old string stamp');
  // new writes keep counting
  g2.upsertNode(a, { id: n.id, body: 'v3' });
  assert.equal(g2.getNode(HUMAN, n.id)!.body, 'v3');
});
