import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLIES_LINE, keyPlaceholder, noticeParagraphs, parseCap, pickedNotReady, selectOptions } from '../ui/src/providers/webSearchModel.js';
import { WEB_PROVIDERS } from '../src/shared/web-search-config.js';

const view = (over: Record<string, unknown> = {}) => ({
  search: 'builtin', read: 'builtin', tregMaxCostUsd: 0.01, acknowledged: {},
  providers: WEB_PROVIDERS.map((p) => ({ ...p, ready: false })),
  keys: { 'web:treg': { set: false }, 'web:exa': { set: true, hint: '…2345' }, 'web:tavily': { set: false }, 'web:brave': { set: false } },
  capLimits: { min: 0.001, max: 1 }, nativeAvailable: true, ...over,
}) as any;

test('Built-in comes first and is always offered; Brave and SearXNG are in the search list only', () => {
  const s = selectOptions(view(), 'search'); const r = selectOptions(view(), 'read');
  assert.deepEqual(s.map((o) => o.value), ['builtin', 'treg', 'exa', 'tavily', 'brave', 'searxng']);
  assert.deepEqual(r.map((o) => o.value), ['builtin', 'treg', 'exa', 'tavily']);
  assert.equal(s[0]!.label, 'Built-in'); assert.equal(s[4]!.label, 'Brave Search');
});

test('the cap field: 0.001 to 1.00, plain words on a bad value', () => {
  const lim = { min: 0.001, max: 1 };
  assert.deepEqual(parseCap('0.05', lim), { ok: true, value: 0.05 });
  assert.deepEqual(parseCap(' 0,02 ', lim), { ok: true, value: 0.02 });
  for (const t of ['', 'abc', '0', '-1', '2', '1.5', '0.0001']) {
    const r = parseCap(t, lim); assert.equal(r.ok, false, t);
    assert.match((r as { error: string }).error, /between \$0\.001 and \$1\.00/);
  }
});

test('key field text: after save only the hint shows, never a key', () => {
  assert.match(keyPlaceholder(view(), 'exa'), /…2345/);
  assert.equal(keyPlaceholder(view(), 'tavily'), 'Paste your key');
});

test('a picked provider with no key or address is called out', () => {
  assert.equal(pickedNotReady(view({ search: 'exa', providers: view().providers.map((p: any) => (p.id === 'exa' ? { ...p, ready: false } : p)) }), 'search'), 'Exa');
  assert.equal(pickedNotReady(view(), 'search'), undefined);
  assert.equal(pickedNotReady(view({ search: 'exa', providers: view().providers.map((p: any) => ({ ...p, ready: true })) }), 'search'), undefined);
});

test('notice paragraphs split on blank lines; the apply line is the briefed one', () => {
  assert.deepEqual(noticeParagraphs('One.\n\nTwo.'), ['One.', 'Two.']);
  assert.equal(APPLIES_LINE, 'Applies to runs started after you save.');
});
