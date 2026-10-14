/**
 * The Lattice's Lint tab, Stale section: the pure view model (grouping, order, labels). It lives in src/shared/kg-audit.ts so the UI
 * and these tests run the same code.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ageLabel, buildAuditView, confidenceLabel, sourcesLabel } from '../src/shared/kg-audit.js';
import type { KgStaleRow } from '../src/shared/kg.js';

const row = (o: Partial<KgStaleRow> & { id: string }): KgStaleRow => ({ daysOld: 100, title: o.id, type: 'concept', sourceCount: 1, createdBy: 'human', ...o });

describe('ageLabel: plain words', () => {
  it('days, months and years', () => {
    assert.equal(ageLabel(1), '1 day old');
    assert.equal(ageLabel(31), '31 days old');
    assert.equal(ageLabel(59), '59 days old');
    assert.equal(ageLabel(60), '2 months old');
    assert.equal(ageLabel(122), '4 months old');
    assert.equal(ageLabel(364), '12 months old');
    assert.equal(ageLabel(365), '1 year old');
    assert.equal(ageLabel(800), '2 years old');
  });
  it('never says "0 days" or a negative age', () => {
    assert.equal(ageLabel(0), 'Updated today');
    assert.equal(ageLabel(-4), 'Updated today');
    assert.equal(ageLabel(Number.NaN), 'Age unknown');
  });
});

describe('confidenceLabel: a word, never a decimal', () => {
  it('low, medium, high and not set', () => {
    assert.equal(confidenceLabel(0.1), 'Low confidence');
    assert.equal(confidenceLabel(0.39), 'Low confidence');
    assert.equal(confidenceLabel(0.4), 'Medium confidence');
    assert.equal(confidenceLabel(0.69), 'Medium confidence');
    assert.equal(confidenceLabel(0.7), 'High confidence');
    assert.equal(confidenceLabel(1), 'High confidence');
    assert.equal(confidenceLabel(undefined), 'Confidence not set');
  });
});

describe('sourcesLabel', () => {
  it('counts, and says No source when there is none', () => {
    assert.equal(sourcesLabel(0), 'No source');
    assert.equal(sourcesLabel(undefined), 'No source');
    assert.equal(sourcesLabel(1), '1 source');
    assert.equal(sourcesLabel(3), '3 sources');
  });
});

describe('buildAuditView', () => {
  it('sorts the owner group oldest first and keeps jump-to-node ids', () => {
    const v = buildAuditView([row({ id: 'a', daysOld: 100 }), row({ id: 'b', daysOld: 400 }), row({ id: 'c', daysOld: 200 })]);
    assert.deepEqual(v.mine.map((r) => r.id), ['b', 'c', 'a']);
    assert.equal(v.empty, false);
  });
  it('breaks an age tie by title so the order is stable', () => {
    const v = buildAuditView([row({ id: '1', title: 'Zebra', daysOld: 100 }), row({ id: '2', title: 'Apple', daysOld: 100 })]);
    assert.deepEqual(v.mine.map((r) => r.title), ['Apple', 'Zebra']);
  });
  it('puts built-in (system) notes in their own group with no Refresh', () => {
    const v = buildAuditView([row({ id: 'seed', createdBy: 'system', daysOld: 500 }), row({ id: 'mine', createdBy: 'human' }), row({ id: 'bot', createdBy: 'scout' })]);
    assert.deepEqual(v.builtIn.map((r) => r.id), ['seed']);
    assert.deepEqual(v.mine.map((r) => r.id).sort(), ['bot', 'mine']);
    assert.equal(v.builtIn[0]!.canRefresh, false);
    assert.ok(v.mine.every((r) => r.canRefresh));
  });
  it('a note being refreshed cannot be refreshed again and carries its run', () => {
    const v = buildAuditView([row({ id: 'a', refreshTaskId: 'task_9' })]);
    assert.equal(v.mine[0]!.refreshTaskId, 'task_9');
    assert.equal(v.mine[0]!.canRefresh, false);
  });
  it('fills the labels the row shows', () => {
    const v = buildAuditView([row({ id: 'a', title: 'Shopify theme tips', type: 'lesson', daysOld: 122, sourceCount: 0, confidence: 0.2 })]);
    const r = v.mine[0]!;
    assert.equal(r.title, 'Shopify theme tips');
    assert.equal(r.age, '4 months old');
    assert.equal(r.sources, 'No source');
    assert.equal(r.noSource, true);
    assert.equal(r.confidence, 'Low confidence');
    assert.equal(r.type, 'lesson');
  });
  it('falls back to the id when the title is missing', () => {
    const v = buildAuditView([{ id: 'n_1', daysOld: 99 }]);
    assert.equal(v.mine[0]!.title, 'n_1');
    assert.equal(v.mine[0]!.noSource, true);
  });
  it('is empty only when both groups are empty, with the exact empty text', () => {
    const none = buildAuditView([]);
    assert.equal(none.empty, true);
    assert.equal(none.emptyText, 'Nothing is stale.');
    assert.equal(buildAuditView([row({ id: 'seed', createdBy: 'system' })]).empty, false);
  });
});
