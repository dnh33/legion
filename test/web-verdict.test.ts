import test from 'node:test';
import assert from 'node:assert/strict';
import { webVerdict, canonicalHost, type WebCtx } from '../src/shared/web-verdict.js';
import { loadDocsHosts } from '../src/shared/docs-hosts.js';
const ctx = (o: Partial<WebCtx> = {}): WebCtx => ({ trusted: (h) => h === 'docs.stripe.com' || h === 'trusted.com', pathsSeen: () => 0, builtIn: () => false, secretRead: false, ...o });
const f = (url: string, o: Partial<WebCtx> = {}) => webVerdict({ tool: 'WebFetch', input: { url } }, ctx(o));
const why = (v: unknown) => (v as { why: string }).why;
const docs = loadDocsHosts();
const builtInCtx = (o: Partial<WebCtx> = {}): WebCtx => ctx({ trusted: (h) => docs.has(h), builtIn: (h) => docs.has(h), ...o });

test('canonicalHost: punycode, case, trailing dot', () => {
  assert.equal(canonicalHost('https://Docs.Stripe.com./x'), 'docs.stripe.com');
  assert.equal(canonicalHost('https://bücher.de/'), 'xn--bcher-kva.de');
  assert.equal(canonicalHost('not a url'), undefined);
});
test('trusted https host, no query, short path: allow', () => assert.deepEqual(f('https://docs.stripe.com/api/charges'), { kind: 'allow', host: 'docs.stripe.com' }));
test('new host asks and may be always-allowed', () => assert.deepEqual(f('https://example.com/a'), { kind: 'ask', host: 'example.com', why: 'new-host', canAlways: true }));
test('query string asks even on a trusted host', () => assert.equal(why(f('https://docs.stripe.com/a?q=1')), 'query'));
test('B-L4: a fragment longer than 16 characters is judged like a query; a built-in docs host keeps its long plain anchors', () => {
  const built = (u: string) => webVerdict({ tool: 'WebFetch', input: { url: u } }, builtInCtx());
  assert.equal(f('https://docs.stripe.com/a#install').kind, 'allow', 'a short anchor');
  assert.equal(f('https://docs.stripe.com/a#' + 'x'.repeat(16)).kind, 'allow', 'exactly 16');
  assert.equal(why(f('https://docs.stripe.com/a#' + 'x'.repeat(17))), 'query', 'on any other approved host 17 asks, like a query');
  assert.equal(why(f('https://docs.stripe.com/a#data=c2VjcmV0LWtleS12YWx1ZQ')), 'query', 'a fragment that carries data');
  assert.equal(built('https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback').kind, 'allow', 'a real long anchor on a built-in docs host');
  assert.equal(why(built('https://react.dev/reference/react#data=c2VjcmV0LWtleS12YWx1ZQ')), 'query', 'built-in host, not a plain slug');
  assert.equal(why(built('https://react.dev/reference/react#' + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0')), 'query', 'built-in host, hex data');
  assert.equal(why(built('https://react.dev/reference/react#dGhpc0lzQVNlY3JldFRva2VuMTIzNDU2Nzg5MA')), 'query', 'built-in host, base64 data');
  assert.equal(why(built('https://react.dev/reference/react#a%20b%20c%20d%20e%20f%20g%20h')), 'query', 'built-in host, escaped text');
});

test('userinfo asks; trusted@evil and evil/trusted are judged by the real host', () => {
  assert.equal(why(f('https://trusted.com@evil.com/')), 'userinfo');
  assert.equal((f('https://evil.com/trusted.com') as { host: string }).host, 'evil.com');
});
test('http, a non-default port and an IP ask; IPs, loopback, private and metadata never offer Always allow', () => {
  assert.equal(why(f('http://docs.stripe.com/')), 'http');
  assert.equal(why(f('https://docs.stripe.com:8443/')), 'port');
  assert.equal(why(f('https://93.184.216.34/')), 'ip');
  for (const u of ['https://93.184.216.34/', 'https://localhost/', 'https://127.0.0.1/', 'https://169.254.169.254/', 'https://[::1]/', 'https://10.0.0.5/']) assert.equal((f(u) as { canAlways: boolean }).canAlways, false, u);
});
test('no subdomain matching; trailing dot matches the entry', () => {
  assert.equal(why(f('https://evil.docs.stripe.com/')), 'new-host');
  assert.equal(why(f('https://docs.stripe.com.evil.com/')), 'new-host');
  assert.equal(f('https://docs.stripe.com./a').kind, 'allow');
});
test('long or encoded-looking path asks', () => {
  assert.equal(why(f('https://docs.stripe.com/' + 'a'.repeat(201))), 'odd-path');
  assert.equal(why(f('https://docs.stripe.com/' + 'QWxhZGRpbjpvcGVuIHNlc2FtZQ01'.repeat(3))), 'odd-path');
  // base64 of plain text ("user:password") often has no digits: the even case mix still marks it
  assert.equal(why(f('https://docs.stripe.com/' + 'QWxhZGRpbjpvcGVuIHNlc2FtZQ')), 'odd-path');
  assert.equal(why(f('https://docs.stripe.com/x/' + 'a3f9'.repeat(10))), 'odd-path', '40 hex characters');
});
test('real doc pages on built-in hosts stay allow', () => {
  for (const u of [
    'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch',
    'https://docs.python.org/3/library/getting_started_with_asyncio_streams.html',
    'https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback',
    'https://react.dev/reference/react-dom/client/createRoot',
    'https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file-and-path-names',
    'https://learn.microsoft.com/en-us/dotnet/api/System.Collections.Generic.IEnumerableExtensions',
    'https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/getContextAttributes',
  ]) assert.equal(webVerdict({ tool: 'WebFetch', input: { url: u } }, builtInCtx()).kind, 'allow', u);
});
test('a base64 token path or a 40-character hex segment on a built-in host asks', () => {
  assert.equal(why(webVerdict({ tool: 'WebFetch', input: { url: 'https://react.dev/x/dGhpc0lzQVNlY3JldFRva2VuMTIzNDU2Nzg5MA' } }, builtInCtx())), 'odd-path');
  assert.equal(why(webVerdict({ tool: 'WebFetch', input: { url: 'https://react.dev/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0' } }, builtInCtx())), 'odd-path');
});
test('path budget: more than 10 distinct paths on a non-built-in host asks; built-in is exempt', () => {
  assert.equal(why(f('https://trusted.com/a', { pathsSeen: () => 11 })), 'budget');
  assert.equal(f('https://trusted.com/a', { pathsSeen: () => 11, builtIn: () => true }).kind, 'allow');
});
test('after a run read a secret path every web call asks', () => {
  assert.equal(why(f('https://docs.stripe.com/a', { secretRead: true })), 'secret-read');
  assert.equal(why(webVerdict({ tool: 'WebSearch', input: { query: 'x' } }, ctx({ secretRead: true }))), 'secret-read');
});
test('a secret value in an address is NOT matched: only the shape and the host decide', () => {
  assert.equal(f('https://docs.stripe.com/api/charges').kind, 'allow');
  assert.equal(webVerdict({ tool: 'WebSearch', input: { query: 'sk-live-abcDEF123456 charge' } }, ctx()).kind, 'allow');
});
test('the context has no secret values and the verdict has no refuse', () => {
  const c = ctx();
  assert.deepEqual(Object.keys(c).sort(), ['builtIn', 'pathsSeen', 'secretRead', 'trusted']);
  for (const u of ['https://trusted.com/a', 'https://evil.com/a', 'http://docs.stripe.com/', '::::']) assert.notEqual(f(u).kind, 'refuse' as never, u);
});
test('WebSearch runs; over the cap asks', () => {
  assert.equal(webVerdict({ tool: 'WebSearch', input: { query: 'react hooks' } }, ctx()).kind, 'allow');
  assert.equal(why(webVerdict({ tool: 'WebSearch', input: { query: 'a'.repeat(301) } }, ctx())), 'long-search');
});
test('browser_open uses the same check', () => {
  assert.equal(webVerdict({ tool: 'browser_open', input: { url: 'https://docs.stripe.com/' } }, ctx()).kind, 'allow');
  assert.equal(webVerdict({ tool: 'browser_open', input: { url: 'https://example.com/' } }, ctx()).kind, 'ask');
});
test('an unparsable URL asks (fails closed)', () => assert.equal(f('::::').kind, 'ask'));
test('loadDocsHosts: built-in list has the doc hosts, and a test can pass its own list', () => {
  assert.equal(docs.has('react.dev'), true);
  assert.equal(docs.has('example.com'), false);
  assert.deepEqual([...loadDocsHosts(['Example.com.'])], ['example.com']);
});

// Fix round for Task 15 review (I1, I2, I3, M2, M3).
const SECRET = 'sk-live-abcDEF123456';
test('I3: hosts that start with a digit are not IPs; real IP literals are', () => {
  for (const u of ['https://1password.com/x', 'https://3m.com/x']) assert.notEqual(why(f(u, { trusted: () => true })), 'ip', u);
  assert.equal(f('https://1password.com/x', { trusted: () => true }).kind, 'allow');
  assert.equal((f('https://3m.com/x') as { canAlways: boolean }).canAlways, true);
  for (const u of ['https://127.0.0.1/', 'https://[::1]/', 'https://2130706433/', 'https://0x7f000001/']) {
    const v = f(u) as { why: string; canAlways: boolean };
    assert.equal(v.why, 'ip', u); assert.equal(v.canAlways, false, u);
  }
});
test('I2: dashed or dotted hex segments ask; real doc slugs still allow', () => {
  const hex = Buffer.from(SECRET).toString('hex');
  assert.equal(why(webVerdict({ tool: 'WebFetch', input: { url: 'https://react.dev/' + hex.match(/.{1,8}/g)!.join('-') } }, builtInCtx())), 'odd-path');
  assert.equal(why(webVerdict({ tool: 'WebFetch', input: { url: 'https://react.dev/' + hex.match(/.{1,8}/g)!.join('.') } }, builtInCtx())), 'odd-path');
  assert.equal(webVerdict({ tool: 'WebFetch', input: { url: 'https://docs.python.org/3/library/getting_started_with_asyncio_streams.html' } }, builtInCtx()).kind, 'allow');
});
test('M2: non-web schemes ask and never offer Always allow', () => {
  for (const u of ['file:///C:/Users/x/.env', 'data:text/plain,hi', 'javascript:alert(1)', 'ftp://docs.stripe.com/']) {
    const v = f(u, { trusted: () => true }) as { kind: string; canAlways: boolean };
    assert.equal(v.kind, 'ask', u); assert.equal(v.canAlways, false, u);
  }
});
test('M3: user-content hosting suffixes never offer Always allow', () => {
  for (const s of ['workers.dev', 'web.app', 'firebaseapp.com', 'appspot.com', 'blogspot.com', 'gitlab.io', 'glitch.me', 'repl.co', 'onrender.com', 'fly.dev', 'surge.sh', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com', 'azurewebsites.net', 'github.io', 'vercel.app', 'pages.dev', 'netlify.app', 's3.amazonaws.com', 'cloudfront.net'])
    assert.equal((f(`https://x.${s}/`) as { canAlways: boolean }).canAlways, false, s);
});
