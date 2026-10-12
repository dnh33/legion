/** The Marshal's routing catalog: full-length role prose, the deny table, and the eligibility guards (marshal/catalog.ts). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.js';
import type { AgentProfile } from '../src/shared/types.js';
import { tempDir } from './tmp-cleanup.js';
import { catalogOf, catalogOfAll, eligible, irreversibleVerbsIn, neverVerbsIn, verbFit } from '../src/core/marshal/catalog.js';
import type { BotCatalogEntry, CandidateCtx } from '../src/core/marshal/catalog.js';

/** The real seeded roster: the three frozen defaults plus the muster, exactly as the app ships them. */
const seeded = new Store(tempDir('legion-marshal-catalog-'));
seeded.seedDefaults(seeded.dir);
const ALL = seeded.listAgents();
const byId = (id: string): AgentProfile => {
  const a = ALL.find((x) => x.id === id);
  assert.ok(a, `roster has ${id}`);
  return a;
};
const entry = (id: string): BotCatalogEntry => catalogOf(byId(id));
const ctx = (over: Partial<CandidateCtx> = {}): CandidateCtx => ({
  members: ['zealot', 'builder', 'scout', 'inquisitor', 'scribe', 'archivist', 'sentinel', 'forgemaster', 'exorcist', 'preceptor', 'herald', 'assayer', 'sculptor', 'quartermaster'],
  visible: () => true, busy: () => false, reuse: () => ({ ok: true }), ...over,
});

test('the catalog carries the WHOLE role prose: a prohibition tail past 80 characters survives', () => {
  const herald = entry('herald');
  assert.ok(herald.role.length > 200, `the full prose, not a roster line (got ${herald.role.length} chars)`);
  assert.match(herald.role, /never send, post, schedule or publish/i, 'the safety tail the 80-char roster line cuts is here');
  assert.equal(herald.model, byId('herald').model, 'the catalog carries the chosen model');
  assert.equal(herald.approval, 'ask', 'the catalog carries the access tier');
});

test('the deny table: a bot whose role forbids a verb is marked for it, with the line that says so', () => {
  const herald = entry('herald');
  const send = herald.never.find((n) => n.verb === 'send');
  assert.ok(send, 'Herald never sends');
  assert.match(send!.evidence, /never send/i);
  assert.equal(send!.source, 'table');
  assert.ok(entry('assayer').never.some((n) => n.verb === 'sign'), 'the Assayer never signs');
  assert.ok(entry('quartermaster').never.some((n) => n.verb === 'upgrade'), 'the Quartermaster never upgrades');
  assert.ok(entry('archivist').never.some((n) => n.verb === 'delete'), 'the Archivist never deletes');
});

test('a gated permission is not a ban: the Forgemaster may deploy, delete and rotate — its tier gates, its role does not forbid', () => {
  const forge = entry('forgemaster');
  for (const verb of ['deploy', 'delete', 'rotate'] as const) {
    assert.ok(!forge.never.some((n) => n.verb === verb), `the Forgemaster is not banned from ${verb}: "without the user\\'s approval" is a gate, not a ban`);
  }
  const fit = verbFit(forge, ['deploy']);
  assert.ok(fit.ok, 'it is entitled');
  assert.equal(fit.ok && fit.gated, true, 'and its ask tier gates the run — honoured, not flattened');
});

test('sentence-scoped prose is read conservatively: the Builder "never delete a test to make it pass" is not a delete ban', () => {
  assert.ok(!entry('builder').never.some((n) => n.verb === 'delete'), 'the Builder ships no delete ban');
  // but prose that plainly forbids a verb still binds a bot the table does not know
  const claims = neverVerbsIn('You are a drafts bot. You never send or post anything; the user does that.');
  assert.deepEqual(claims.map((c) => c.verb), ['send'], 'one plain prohibition, read from the prose itself');
  assert.equal(claims[0]!.source, 'prose');
  assert.match(claims[0]!.evidence, /never send or post/i);
});

test('a custom bot that forbids a verb is routed away from it even though the table does not know it', () => {
  const custom: AgentProfile = { ...byId('scribe'), id: 'custombot', name: 'Custom', description: 'Answers questions.', systemPrompt: 'You read and answer. You never deploy or merge anything.' };
  const c = catalogOf(custom);
  assert.ok(c.never.some((n) => n.verb === 'deploy'), 'the deploy ban is read out of its own prose');
  assert.ok(c.never.some((n) => n.verb === 'merge'), 'the merge ban is read out of its own prose');
  assert.ok(!verbFit(c, ['merge']).ok, 'and a merge task will not route to it');
});

test('verbFit: never routed to a role-forbidden bot, and the reason names the line', () => {
  const fit = verbFit(entry('herald'), ['send']);
  assert.ok(!fit.ok);
  assert.match(fit.ok ? '' : fit.why, /never send/i, 'the refusal carries the evidence');
  assert.ok(verbFit(entry('herald'), ['delete']).ok, 'a delete task may still route to it');
  assert.ok(verbFit(entry('builder'), []).ok, 'a reversible task fits anyone not forbidden');
  const plain = verbFit(entry('builder'), ['delete']);
  assert.ok(plain.ok && !plain.gated, 'a reversible-safe verb on an ask bot is not gated: gating is for irreversible verbs');
});

test('irreversibleVerbsIn reads the verbs an owner wrote, one per verb, without double counting', () => {
  assert.deepEqual(irreversibleVerbsIn('Send the newsletter and sign the release, then deploy it.'), ['send', 'sign', 'deploy']);
  assert.deepEqual(irreversibleVerbsIn('Send it twice, please send again'), ['send']);
  assert.deepEqual(irreversibleVerbsIn('write the README'), [], 'reversible work names no verb');
  assert.deepEqual(irreversibleVerbsIn(''), []);
});

test('eligible: membership, feature switch, load and the attempt ledger are code guards, one line each', () => {
  const catalog = [entry('builder'), entry('scout'), entry('herald'), entry('assayer')];
  const { candidates, excluded } = eligible(catalog, ctx({
    members: ['builder', 'scout', 'herald'], visible: (id) => id !== 'scout', busy: (id) => id === 'herald',
    reuse: (id) => (id === 'scout' ? { ok: false, why: 'unreachable' } : { ok: true }),
  }));
  assert.deepEqual(candidates.map((b) => b.id), ['builder'], 'only the one bot that passes every guard');
  const why = Object.fromEntries(excluded.map((e) => [e.id, e.why]));
  assert.match(why.assayer!, /not a member/);
  assert.match(why.scout!, /switched off/);
  assert.match(why.herald!, /already working/);
});

test('eligible hands the ledger the last word, quoting its reason', () => {
  const { excluded } = eligible([entry('builder')], ctx({ reuse: () => ({ ok: false, why: 'already tried on this item: reassignment is forward-only' }) }));
  assert.match(excluded[0]!.why, /forward-only/);
});

test('the whole roster catalogs, visibly', () => {
  const all = catalogOfAll(ALL, (a) => a.id !== 'assayer');
  assert.equal(all.length, ALL.length - 1, 'the hidden bot is left out entirely');
  assert.ok(all.every((b) => b.role.length > 100 && b.never !== undefined), 'every entry carries full prose and a never-list');
});
