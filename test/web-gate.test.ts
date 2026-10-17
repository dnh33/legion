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
  assert.equal(normalizeGates({ rules: [raw('deny', ['Docs.Stripe.com'])] }).rules.length, 0, 'load drops a rule it cannot parse');
});

test('owner rules: hosts must be a list', () => {
  assert.throws(() => strict([raw('deny', 'docs.stripe.com')]), /hosts/);
});
