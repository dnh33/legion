import test from 'node:test';
import assert from 'node:assert/strict';
import { gateValue, GATES, PRESETS } from '../src/shared/gates-registry.js';
import { decideGate } from '../src/core/gates.js';
import { normalizeGates } from '../src/shared/config.js';
import type { GateRule, GateVerdict, GateWhen } from '../src/shared/types.js';

let n = 0;
const rule = (then: GateVerdict, when: GateWhen): GateRule => ({ id: `gr_w${++n}`, enabled: true, then, label: `${then} rule`, source: 'user', when });
const fetchCall = (url: string) => ({ toolName: 'WebFetch', input: { url } });
const verdict = (url: string, rules: GateRule[], mode: 'ask' | 'auto-edits' | 'full' = 'ask') => decideGate(fetchCall(url), rules, mode, false).verdict;

test('web-reads: on in ask, accept-edits and smart; off in bypass; a permission gate per project', () => {
  const g = GATES.find((x) => x.id === 'web-reads');
  assert.ok(g, 'registered');
  assert.equal(g.family, 'permission');
  assert.equal(g.scope, 'project');
  assert.equal(g.label, 'Check which websites agents read');
  assert.equal(g.protects, 'Stops an agent reading a site you did not approve, or hiding your data in the address it asks for.');
  assert.equal(g.ifOff, 'Agents can read any website without asking, and an address can carry your data out.');
  for (const p of PRESETS) assert.equal(gateValue('web-reads', { app: { preset: p, version: 1 } }), p !== 'bypass', p);
});

test('a hosts deny matches the exact canonical host only', () => {
  const deny = rule('deny', { hosts: ['docs.stripe.com'] });
  assert.equal(verdict('https://docs.stripe.com/a', [deny]), 'deny');
  assert.equal(verdict('https://DOCS.stripe.com./a', [deny]), 'deny', 'case and trailing dot');
  assert.equal(verdict('https://docs.stripe.com./a', [deny]), 'deny', 'trailing dot');
  assert.equal(verdict('https://evil.docs.stripe.com/', [deny]), 'baseline');
  assert.equal(verdict('https://docs.stripe.com.evil.com/', [deny]), 'baseline');
  assert.equal(verdict('https://trusted.com@docs.stripe.com/', [deny]), 'deny', 'judged by the real host');
});

test('a hosts rule needs a url with a host: no url, a bad url, or no match leaves it out', () => {
  const deny = rule('deny', { hosts: ['docs.stripe.com'] });
  assert.equal(decideGate({ toolName: 'WebFetch', input: {} }, [deny], 'ask', false).verdict, 'baseline');
  assert.equal(decideGate({ toolName: 'WebFetch' }, [deny], 'ask', false).verdict, 'baseline');
  assert.equal(verdict('not a url', [deny]), 'baseline');
});

test('a hosts deny beats any allow, also in full', () => {
  const deny = rule('deny', { hosts: ['example.com'] });
  const allow = rule('allow', { tools: ['WebFetch'] });
  for (const mode of ['ask', 'auto-edits', 'full'] as const) assert.equal(verdict('https://example.com/', [allow, deny], mode), 'deny', mode);
});

test('a hosts ask rule makes decideGate ask (inert in full, like every ask rule)', () => {
  const ask = rule('ask', { hosts: ['example.com'] });
  assert.equal(verdict('https://example.com/', [ask]), 'ask');
  assert.equal(verdict('https://other.com/', [ask]), 'baseline');
  assert.equal(verdict('https://example.com/', [ask], 'full'), 'baseline');
});

const strict = (rules: unknown[]) => normalizeGates({ rules }, { strict: true });
const raw = (then: string, hosts: unknown) => ({ id: 'gr_abc', then, when: { hosts } });

test('owner rules: deny and ask rules with hosts are accepted, an allow rule with hosts is refused', () => {
  assert.deepEqual(strict([raw('deny', ['docs.stripe.com'])]).rules[0]?.when.hosts, ['docs.stripe.com']);
  assert.deepEqual(strict([raw('ask', ['a.com', 'b.com'])]).rules[0]?.when.hosts, ['a.com', 'b.com']);
  assert.throws(() => strict([raw('allow', ['docs.stripe.com'])]), /Approved sites go in the site list, not in an allow rule\./);
  // a file read at load drops the allow rule rather than keep a bare-host allow
  assert.equal(normalizeGates({ rules: [raw('allow', ['docs.stripe.com'])] }).rules.length, 0);
});

test('owner rules: more than 200 hosts are refused, and each entry must equal its canonical form', () => {
  assert.throws(() => strict([raw('deny', Array.from({ length: 201 }, (_, i) => `h${i}.example.com`))]), /200/);
  assert.equal(strict([raw('deny', Array.from({ length: 200 }, (_, i) => `h${i}.example.com`))]).rules[0]?.when.hosts?.length, 200);
  for (const bad of ['Docs.Stripe.com', 'docs.stripe.com.', 'https://docs.stripe.com', 'docs.stripe.com/x', '*.stripe.com', 'a b.com', 'bücher.de']) {
    assert.throws(() => strict([raw('deny', [bad])]), /site name/i, JSON.stringify(bad));
  }
  assert.equal(normalizeGates({ rules: [raw('deny', ['a b.com'])] }).rules.length, 0, 'load drops a rule none of whose sites it can read');
});

test('owner rules: hosts must be a list', () => {
  assert.throws(() => strict([raw('deny', 'docs.stripe.com')]), /hosts/);
});

test('a hosts deny or ask also matches an address carried inside the call, in every mode', () => {
  const wrapped = [
    'https://r.jina.ai/https://example.com/',
    'https://trusted.com/r/https://example.com',
    'https://web.archive.org/web/2020/example.com/x',
    'https://a.com/?u=https%3A%2F%2Fexample.com',
  ];
  for (const then of ['deny', 'ask'] as const) {
    const r = rule(then, { hosts: ['example.com'] });
    for (const u of wrapped) assert.equal(verdict(u, [r]), then, `${then} ${u}`);
    assert.equal(verdict('https://example.org/', [r]), 'baseline', then);
    assert.equal(verdict('https://r.jina.ai/https://example.org/', [r]), 'baseline', then);
  }
  const deny = rule('deny', { hosts: ['example.com'] });
  for (const u of wrapped) for (const mode of ['ask', 'auto-edits', 'full'] as const) assert.equal(verdict(u, [deny], mode), 'deny', `${mode} ${u}`);
});

test('a host deny sees through trailing dots', () => {
  const deny = rule('deny', { hosts: ['example.com'] });
  assert.equal(verdict('https://example.com../', [deny]), 'deny');
});

test('owner rules: an empty hosts list is refused, and a bad entry on load keeps the valid ones', () => {
  assert.throws(() => strict([raw('deny', [])]), /hosts/i);
  assert.equal(normalizeGates({ rules: [raw('deny', [])] }).rules.length, 0, 'load drops it, never "every site"');
  const kept = normalizeGates({ rules: [raw('deny', ['Example.com', 'x y', 'b.com'])] }).rules;
  assert.deepEqual(kept[0]?.when.hosts, ['example.com', 'b.com']);
  assert.equal(normalizeGates({ rules: [raw('deny', ['x y'])] }).rules.length, 0);
});

test('C-L5: a hand-edited deny rule dropped on load for sites that cannot be read leaves one log line naming the rule, and drops what it dropped before', () => {
  const lines: string[] = [];
  const rules = normalizeGates({ rules: [raw('deny', ['*.example.com']), { id: 'gr_keep', then: 'deny', when: { hosts: ['docs.stripe.com'] } }] }, { onDropped: (l) => lines.push(l) }).rules;
  assert.deepEqual(rules.map((r) => r.id), ['gr_keep'], 'the same rule is dropped as before and the valid one stays');
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /gr_abc/);
  assert.match(lines[0]!, /deny rule/);
  assert.doesNotMatch(lines[0]!, /example\.com/, 'the sites themselves are not written');
  // no listener: the same drop, silently (a strict PATCH still throws)
  assert.equal(normalizeGates({ rules: [raw('deny', ['*.example.com'])] }).rules.length, 0);
  assert.throws(() => normalizeGates({ rules: [raw('deny', ['*.example.com'])] }, { strict: true, onDropped: (l) => lines.push(l) }));
  assert.equal(lines.length, 1, 'a strict refusal logs nothing');
});
