import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPickerLayout, resolveHighlight, type PickerInput } from '../src/shared/model-picker-rows.js';

const base = (over: Partial<PickerInput> = {}): PickerInput => ({
  query: '', selected: 'opus', autoDescription: 'Legion picks Sonnet or Opus per task',
  current: [
    { value: 'opus', displayName: 'Opus 5.5', description: 'Deepest reasoning.' },
    { value: 'sonnet', displayName: 'Sonnet 5.5', description: 'Fast.' },
    { value: 'haiku', displayName: 'Haiku 5.5', description: 'Cheapest.' },
  ],
  older: [
    { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: '' },
    { value: 'claude-sonnet-4', displayName: 'Sonnet 4', description: '' },
    { value: 'claude-opus-4-1', displayName: 'Opus 4.1', description: '' },
  ],
  groups: [], configured: [], olderOpen: false, groupOpen: {},
  ...over,
});

test('a query puts the highlight on the first real match, so Enter picks what was typed (Auto is not a match)', () => {
  const L = buildPickerLayout(base({ query: 'haiku' }));
  assert.equal(L.nav.some((n) => n.kind === 'item' && n.id === 'auto'), false, 'Auto is filtered by the query');
  const row = L.nav[resolveHighlight(L.nav, undefined, 'haiku', 'opus')];
  assert.ok(row && row.kind === 'item' && row.displayName === 'Haiku 5.5', `highlight on ${row?.id}`);
});

test('with no query the highlight starts on the selected model, and falls back to Auto when it is not listed', () => {
  const L = buildPickerLayout(base());
  assert.equal(L.nav[resolveHighlight(L.nav, undefined, '', 'sonnet')]!.id, 'sonnet');
  assert.equal(L.nav[resolveHighlight(L.nav, undefined, '', 'gone')]!.id, 'auto');
  assert.equal(L.nav[resolveHighlight(L.nav, 'no-such-row', '', 'gone')]!.id, 'auto', 'a stale highlight id falls back');
});

test('a query that matches only an older model leads with that model, and the Older head opens to show it', () => {
  const L = buildPickerLayout(base({ query: 'opus 4' }));
  const row = L.nav[resolveHighlight(L.nav, undefined, 'opus 4', 'opus')];
  assert.ok(row && row.kind === 'item' && row.value === 'claude-opus-4-1');
  assert.equal(L.older?.head.open, true);
});

test('the Older head is pinned outside the list, and under a query its count is the number of matches', () => {
  const L = buildPickerLayout(base({ query: 'haiku' }));
  assert.equal(L.older?.head.count, 1, 'one older model matches');
  assert.deepEqual(L.older?.rows.map((r) => r.displayName), ['Haiku 4.5']);
  assert.equal(L.rows.some((r) => r.kind === 'head' && r.id === 'older'), false, 'the head is not a row of the scrolling list');
});

test('collapsed, the Older head counts every older model and its rows are not reachable with the arrow keys', () => {
  const L = buildPickerLayout(base());
  assert.equal(L.older?.head.count, 3);
  assert.equal(L.older?.head.open, false);
  assert.deepEqual(L.older?.rows, []);
  assert.ok(L.nav.some((n) => n.kind === 'head' && n.id === 'older'), 'the head is reachable');
  assert.equal(L.nav.some((n) => n.kind === 'item' && n.value === 'claude-sonnet-4'), false);
});

test('expanded, the older models follow the head in keyboard order', () => {
  const L = buildPickerLayout(base({ olderOpen: true }));
  assert.deepEqual(L.nav.map((n) => n.id).slice(-4), ['older', 'claude-haiku-4-5', 'claude-sonnet-4', 'claude-opus-4-1']);
});

test('no label says "Older": the head is the only Older heading (no doubled label), in every state', () => {
  for (const over of [{}, { olderOpen: true }, { query: 'haiku' }, { query: 'sonnet', olderOpen: true }]) {
    const L = buildPickerLayout(base(over));
    const labels = [...L.rows, ...(L.older?.rows ?? [])].filter((r) => r.kind === 'label').map((r) => (r as { text: string }).text);
    assert.equal(labels.some((t) => /older/i.test(t)), false, JSON.stringify(over));
  }
});

test('Auto is the first row with no query, and any query that it does not match removes it', () => {
  const L = buildPickerLayout(base());
  assert.ok(L.rows[0]!.kind === 'item' && L.rows[0]!.id === 'auto');
  assert.equal(buildPickerLayout(base({ query: 'auto' })).nav[0]!.id, 'auto');
  assert.equal(buildPickerLayout(base({ query: 'haiku' })).rows.some((r) => r.kind === 'item' && r.id === 'auto'), false);
});

test('a query with no match leaves an empty nav and no Older head', () => {
  const L = buildPickerLayout(base({ query: 'zzz' }));
  assert.equal(L.nav.length, 0);
  assert.equal(L.older, undefined);
  assert.equal(resolveHighlight(L.nav, undefined, 'zzz', 'opus'), -1);
});

const groups = [{ id: 'openrouter/deepseek', label: 'DeepSeek (OpenRouter)', providerId: 'openrouter', models: ['deepseek/r1', 'deepseek/v3', 'deepseek/v3-lite'] }];

test('a creator group head shows every model, closed by default; under a query it opens and counts the matches', () => {
  const closed = buildPickerLayout(base({ groups })).rows.find((r) => r.kind === 'head' && r.id === 'group-openrouter/deepseek');
  assert.ok(closed && closed.kind === 'head');
  assert.equal(closed.count, 3);
  assert.equal(closed.open, false);
  assert.equal(buildPickerLayout(base({ groups })).nav.some((n) => n.kind === 'item' && n.value === 'openrouter:deepseek/v3'), false);

  const L = buildPickerLayout(base({ groups, query: 'r1' }));
  const head = L.rows.find((r) => r.kind === 'head' && r.id === 'group-openrouter/deepseek');
  assert.ok(head && head.kind === 'head');
  assert.equal(head.count, 1, 'the count is the number of matches, not the group size');
  assert.equal(head.open, true);
  assert.deepEqual(L.nav.filter((n) => n.kind === 'item').map((n) => n.id), ['openrouter:deepseek/r1']);
});

test('a group opens by default when it holds the selected or a configured model', () => {
  const sel = buildPickerLayout(base({ groups, selected: 'openrouter:deepseek/v3' }));
  assert.ok(sel.nav.some((n) => n.kind === 'item' && n.value === 'openrouter:deepseek/v3'));
  const cfg = buildPickerLayout(base({ groups, configured: ['openrouter:deepseek/r1'] }));
  assert.ok(cfg.nav.some((n) => n.kind === 'item' && n.value === 'openrouter:deepseek/r1'));
});

test('provider rows carry no per-row boilerplate: the group head names the provider', () => {
  const L = buildPickerLayout(base({ groups, groupOpen: { 'group-openrouter/deepseek': true } }));
  const items = L.rows.filter((r) => r.kind === 'item' && r.value.startsWith('openrouter:'));
  assert.equal(items.length, 3);
  for (const r of items) assert.equal(r.kind === 'item' && r.description, undefined);
});

test('the Current models label appears once, above the first current model', () => {
  const L = buildPickerLayout(base());
  const labelAt = L.rows.findIndex((r) => r.kind === 'label');
  const firstCurrent = L.rows.findIndex((r) => r.kind === 'item' && r.id === 'opus');
  assert.ok(labelAt >= 0 && labelAt < firstCurrent);
  assert.equal(L.rows.filter((r) => r.kind === 'label').length, 1);
});
