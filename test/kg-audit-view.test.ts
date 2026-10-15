/**
 * The Lattice's Lint tab, Stale section: the pure view model (grouping, order, labels). It lives in src/shared/kg-audit.ts so the UI
 * and these tests run the same code.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ageLabel, buildAuditView, confidenceLabel, isFailedRun, refreshAvailability, refreshButtonFor, refreshFailureText, shouldReloadOnTaskEnd, sourcesLabel } from '../src/shared/kg-audit.js';
import { readFileSync } from 'node:fs';
import type { KgStaleRow } from '../src/shared/kg.js';

const row = (o: Partial<KgStaleRow> & { id: string }): KgStaleRow => ({ daysOld: 100, title: o.id, type: 'concept', sourceCount: 1, createdBy: 'human', ...o });

describe('ageLabel: plain words', () => {
  it('days, months and years', () => {
    assert.equal(ageLabel(1), '1 day old');
    assert.equal(ageLabel(31), '31 days old');
    assert.equal(ageLabel(59), '59 days old');
    assert.equal(ageLabel(60), '2 months old');
    assert.equal(ageLabel(122), '4 months old');
    assert.equal(ageLabel(335), '11 months old');
    assert.equal(ageLabel(364), '11 months old');
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
  it('a blocked row has no Refresh and says why in a few words', () => {
    const v = buildAuditView([
      row({ id: 'p', refreshBlock: 'proposal' }), row({ id: 'u', refreshBlock: 'untrusted' }),
      row({ id: 'x', refreshBlock: 'unreadable' }), row({ id: 'w', refreshBlock: 'pending' }),
    ]);
    const by = Object.fromEntries(v.mine.map((r) => [r.id, r]));
    assert.ok(v.mine.every((r) => !r.canRefresh));
    assert.equal(by.p!.note, 'Proposal in your Inbox');
    assert.equal(by.u!.note, 'Review it before refreshing');
    assert.equal(by.x!.note, 'Private to another agent');
    assert.equal(by.w!.note, 'Waiting in your Inbox');
  });
  it('Still current is offered on owner rows the core will accept, never on built-in or pending rows', () => {
    const v = buildAuditView([row({ id: 'a' }), row({ id: 'b', refreshBlock: 'untrusted' }), row({ id: 'w', refreshBlock: 'pending' }), row({ id: 'seed', createdBy: 'system' })]);
    const by = Object.fromEntries(v.mine.map((r) => [r.id, r]));
    assert.equal(by.a!.canMarkCurrent, true);
    assert.equal(by.b!.canMarkCurrent, true);
    assert.equal(by.w!.canMarkCurrent, false, 'touch refuses a pending note');
    assert.equal(v.builtIn[0]!.canMarkCurrent, false);
  });
});

describe('shouldReloadOnTaskEnd: a row must not stay on "Refreshing"', () => {
  const rows = [{ id: 'a', daysOld: 100, refreshTaskId: 'task_1' }];
  it('reloads when any run has ended while a click is waiting for its answer, whatever the task', () => {
    assert.equal(shouldReloadOnTaskEnd('done', [], ['n_1']), true);
    assert.equal(shouldReloadOnTaskEnd('error', [], ['n_1']), true);
    assert.equal(shouldReloadOnTaskEnd('cancelled', [], ['n_1']), true);
  });
  it('reloads when any run has ended while a row shows a live run', () => assert.equal(shouldReloadOnTaskEnd('done', rows, []), true));
  it('does not reload for a run that is still going', () => {
    assert.equal(shouldReloadOnTaskEnd('running', rows, ['n_1']), false);
    assert.equal(shouldReloadOnTaskEnd('queued', rows, ['n_1']), false);
  });
  it('does not reload when no refresh is pending at all', () => assert.equal(shouldReloadOnTaskEnd('done', [{ id: 'a', daysOld: 100 }], []), false));
});

describe('the Stale header counts what the list shows', () => {
  it('count is the owner rows only; built-in notes have their own count', () => {
    const v = buildAuditView([row({ id: 'a' }), row({ id: 'b' }), row({ id: 's1', createdBy: 'system' }), row({ id: 's2', createdBy: 'system' })]);
    assert.equal(v.count, 2);
    assert.equal(v.builtIn.length, 2);
  });
});

describe('no Archivist on the roster', () => {
  it('hides Refresh and says why, on rows that could otherwise be refreshed', () => {
    const v = buildAuditView([row({ id: 'a' }), row({ id: 'b', refreshBlock: 'proposal' })], { archivist: false });
    const by = Object.fromEntries(v.mine.map((r) => [r.id, r]));
    assert.equal(by.a!.canRefresh, false);
    assert.equal(by.a!.note, 'No Archivist');
    assert.equal(by.b!.note, 'Proposal in your Inbox', 'a real block keeps its own reason');
  });
  it('is on by default', () => assert.equal(buildAuditView([row({ id: 'a' })]).mine[0]!.canRefresh, true));
  it('refreshAvailability is the one rule for the list and the detail panel', () => {
    assert.deepEqual(refreshAvailability(row({ id: 'a' }), true), { canRefresh: true, canMarkCurrent: true, note: undefined });
    assert.deepEqual(refreshAvailability(row({ id: 'a' }), false), { canRefresh: false, canMarkCurrent: true, note: 'No Archivist' });
    assert.equal(refreshAvailability(row({ id: 'a', refreshBlock: 'pending' }), true).canMarkCurrent, false);
    assert.equal(refreshAvailability(row({ id: 's', createdBy: 'system' }), true).canRefresh, false);
  });
});

describe('a failed refresh stays visible', () => {
  it('the toast text names the note by title', () => {
    assert.equal(refreshFailureText('Shopify theme tips'), 'Refresh of Shopify theme tips failed.');
    assert.ok(refreshFailureText('x'.repeat(200)).length < 100);
  });
  it('error and cancelled are failures; done and live are not', () => {
    assert.equal(isFailedRun('error'), true);
    assert.equal(isFailedRun('cancelled'), true);
    assert.equal(isFailedRun('done'), false);
    assert.equal(isFailedRun('running'), false);
  });
  it('the row carries the failed run until the next refresh clears it', () => {
    const v = buildAuditView([row({ id: 'a' }), row({ id: 'b' })], { failed: { a: 'task_7' } });
    const by = Object.fromEntries(v.mine.map((r) => [r.id, r]));
    assert.equal(by.a!.failedTaskId, 'task_7');
    assert.equal(by.b!.failedTaskId, undefined);
  });
});

describe('one button for Refresh and Refreshing, so keyboard focus stays on it', () => {
  it('is the same button with another label while the run is live', () => {
    const idle = buildAuditView([row({ id: 'a' })]).mine[0]!;
    assert.deepEqual(refreshButtonFor(idle, false), { label: 'Refresh', inert: false });
    assert.deepEqual(refreshButtonFor(idle, true), { label: 'Refreshing', inert: true });
    const live = buildAuditView([row({ id: 'a', refreshTaskId: 't' })]).mine[0]!;
    assert.deepEqual(refreshButtonFor(live, false), { label: 'Refreshing', inert: true });
  });
  it('is absent for blocked and built-in rows', () => {
    const v = buildAuditView([row({ id: 'p', refreshBlock: 'proposal' }), row({ id: 's', createdBy: 'system' })]);
    assert.equal(refreshButtonFor(v.mine[0]!, false), null);
    assert.equal(refreshButtonFor(v.builtIn[0]!, false), null);
  });
  it('LeftColumn does not swap two separate elements (a remount drops focus to the body)', () => {
    const src = readFileSync('ui/src/graph/LeftColumn.tsx', 'utf8');
    assert.doesNotMatch(src, />Refreshing<\/button>/);
    assert.match(src, /refreshButtonFor\(/);
  });
});
