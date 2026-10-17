// Task 15c: relay hosts never "always", and an address inside an address is judged too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webVerdict, type WebCtx } from '../src/shared/web-verdict.js';
import { loadDocsHosts } from '../src/shared/docs-hosts.js';
const ctx = (o: Partial<WebCtx> = {}): WebCtx => ({ trusted: (h) => h === 'docs.stripe.com' || h === 'trusted.com', pathsSeen: () => 0, builtIn: () => false, secretRead: false, ...o });
const f = (url: string, o: Partial<WebCtx> = {}) => webVerdict({ tool: 'WebFetch', input: { url } }, ctx(o));
const docs = loadDocsHosts();
const builtInCtx = (o: Partial<WebCtx> = {}): Partial<WebCtx> => ({ trusted: (h) => docs.has(h), builtIn: (h) => docs.has(h), ...o });
const kind = (v: unknown) => (v as { kind: string }).kind;
const why = (v: unknown) => (v as { why: string }).why;
const can = (v: unknown) => (v as { canAlways: boolean }).canAlways;
const hostOf = (v: unknown) => (v as { host: string }).host;
const RELAYS = ['treg.to', 'markdown.new', 'r.jina.ai', 's.jina.ai', 'web.archive.org', 'archive.org', 'archive.ph', 'archive.today', 'archive.is', 'webcache.googleusercontent.com', 'translate.google.com', 'docs-python-org.translate.goog', '12ft.io', 'scrape.do', 'api.scraperapi.com', 'corsproxy.io', 'api.allorigins.win', 'cors-anywhere.herokuapp.com', 'proxy.cors.sh'];

test('a relay host asks and never offers Always allow', () => {
  for (const h of RELAYS) {
    const v = f(`https://${h}/x`);
    assert.equal(kind(v), 'ask', h);
    assert.equal(can(v), false, h);
  }
});

test('a relay host in the trusted list still asks, even with a clean path', () => {
  for (const h of RELAYS) {
    const v = f(`https://${h}/x`, { trusted: () => true });
    assert.equal(kind(v), 'ask', h);
    assert.equal(why(v), 'new-host', h);
    assert.equal(can(v), false, h);
  }
});

test('a relay carrying an address: the embedded host is judged too', () => {
  const v = f('https://treg.to/call/https://evil.com/x', builtInCtx());
  assert.equal(kind(v), 'ask');
  assert.equal(why(v), 'new-host');
  assert.equal(can(v), false, 'the relay side is stricter');
  const w = f('https://docs.python.org/3/?u=https%3A%2F%2Fevil.com', builtInCtx());
  assert.equal(kind(w), 'ask');
});

test('an embedded address on a host that is not trusted asks new-host for it (any ask wins)', () => {
  // the outer host is trusted and its path is clean; only the embedded target is new
  const v = f('https://trusted.com/redirect/https://evil.com/x');
  assert.equal(kind(v), 'ask');
  assert.equal(hostOf(v), 'evil.com');
  assert.equal(why(v), 'new-host');
  assert.equal(can(v), true);
  assert.equal(hostOf(f('https://trusted.com/r/HTTPS%3A%2F%2Fevil.com/x')), 'evil.com');
  assert.equal(hostOf(f('https://trusted.com/r/http%3a%2f%2fevil.com')), 'evil.com');
  assert.equal(hostOf(f('https://trusted.com/a?u=https://evil.com')), 'trusted.com', 'the outer query asks first');
});

test('an embedded address on a trusted host adds nothing; canAlways is false if either side is false', () => {
  assert.equal(kind(f('https://trusted.com/r/https://docs.stripe.com/a')), 'allow');
  const v = f('https://trusted.com/r/https://93.184.216.34/');
  assert.equal(kind(v), 'ask');
  assert.equal(can(v), false);
});

test('a built-in docs host inside a relay still asks because the relay asks', () => {
  const v = f('https://web.archive.org/web/2020/https://docs.python.org/3/', builtInCtx());
  assert.equal(kind(v), 'ask');
  assert.equal(hostOf(v), 'web.archive.org');
  assert.equal(can(v), false);
});

test('only one level is followed', () => {
  assert.equal(kind(f('https://trusted.com/r/https://docs.stripe.com/x/https://evil.com/')), 'allow');
});

test('browser_open is judged the same way', () => {
  const v = webVerdict({ tool: 'browser_open', input: { url: 'https://trusted.com/r/https://evil.com/' } }, ctx());
  assert.equal(hostOf(v), 'evil.com');
});

test('a secret read in the run asks every time: no Always allow', () => {
  for (const u of ['https://example.com/', 'https://docs.stripe.com/a', 'https://trusted.com/a']) {
    const v = f(u, { secretRead: true });
    assert.equal(why(v), 'secret-read', u);
    assert.equal(can(v), false, u);
  }
});
