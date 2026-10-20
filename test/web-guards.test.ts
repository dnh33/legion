// test/web-guards.test.ts : guards for the web tools (0.3.5 task 21). The CSP stays closed to remote images, Ask and Accept edits stay exactly as in 0.3.0,
// and the web provider transport keeps its timers and its request cap.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { needsApproval, webChecksApply } from '../src/core/approvals.js';
import { WEB_LIMITS, webRequestJson } from '../src/core/web-search/transport.js';
import { WebProviderError } from '../src/core/web-search/types.js';
import { ERR_REFUSED, ERR_TOO_BIG } from '../src/shared/web-search-copy.js';
import { walk } from './guard-scan.js';

const ROOT = process.cwd();
const read = (f: string): string => readFileSync(`${ROOT}/${f}`, 'utf8');

// ---- the content security policy ----

/** The content of every Content-Security-Policy meta tag in a page. */
const cspsOf = (html: string): string[] => [...html.matchAll(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/gi)].map((m) => m[1] ?? '');
const imgSrcOf = (csp: string): string => /(?:^|;)\s*img-src\s+([^;]*)/.exec(csp)?.[1] ?? '';

test('the main window CSP names img-src and allows no remote image', () => {
  const csps = cspsOf(read('ui/index.html'));
  assert.equal(csps.length, 1, 'ui/index.html carries exactly one CSP meta tag; it is the only CSP of the app window');
  const img = imgSrcOf(csps[0]!);
  assert.ok(img.length > 0, 'img-src must be named; without it default-src decides');
  assert.doesNotMatch(img, /https?:|\*|\/\//, `A remote image would let a page address (or a pasted web result) phone home. Keep img-src to 'self' data: blob:. Found: ${img}`);
});
test('the splash, update and confirm windows allow no remote image either', () => {
  for (const f of ['assets/splash.html', 'assets/update-window.html', 'assets/confirm-window.html']) {
    const csps = cspsOf(read(f));
    assert.equal(csps.length, 1, f);
    assert.doesNotMatch(imgSrcOf(csps[0]!), /https?:|\*/, `${f}: img-src must stay local (file: data:)`);
    assert.match(csps[0]!, /default-src 'none'/, `${f}: default-src stays 'none'`);
  }
});
test('the CSP check reads a planted remote image as a failure', () => {
  const planted = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' https://x.example; script-src 'self'" />`;
  assert.match(imgSrcOf(cspsOf(planted)[0]!), /https?:/);
  assert.equal(imgSrcOf(cspsOf(`<meta http-equiv="Content-Security-Policy" content="img-src 'self' data: blob:" />`)[0]!), "'self' data: blob:");
});
test('the Electron side sets no CSP header of its own (if it ever does, this test and a header test must be added)', () => {
  for (const f of walk(ROOT, 'src/electron', /\.ts$/)) {
    assert.doesNotMatch(read(f), /onHeadersReceived|Content-Security-Policy/i, `${f} sets or touches a response header CSP. Add a test that its img-src allows no remote image, then update this guard.`);
  }
});

// ---- Ask and Accept edits behave as in 0.3.0 ----

const PARITY_SHA = 'bcd4c1ef888bb89919c47adb01790669ac173f189d9a3a33e7efc6c79a1f80b8'; // sha256 of test/fixtures/gate-parity-0.3.0.json at commit e078f671

test('the 0.3.0 parity fixture is byte for byte what it was when it was pinned', () => {
  const now = createHash('sha256').update(readFileSync(`${ROOT}/test/fixtures/gate-parity-0.3.0.json`)).digest('hex');
  assert.equal(now, PARITY_SHA,
    'test/fixtures/gate-parity-0.3.0.json changed.\n'
    + 'Why it matters: Ask and Accept edits must behave exactly like 0.3.0. The fixture is the record of that behaviour; editing it hides a change instead of showing it.\n'
    + 'How to fix: restore it (git show e078f671:test/fixtures/gate-parity-0.3.0.json). If the change in behaviour is deliberate and the owner agreed, say so in the commit and pin the new hash here.');
});
test('the pinned hash is the one of the file at the commit that created it (when history is present)', () => {
  let blob: Buffer;
  try { blob = execFileSync('git', ['show', 'e078f671:test/fixtures/gate-parity-0.3.0.json'], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return; } // shallow checkout: the commit is not there
  assert.equal(createHash('sha256').update(blob).digest('hex'), PARITY_SHA, 'PARITY_SHA does not match the file at e078f671');
});
test('WebFetch, WebSearch and the provider web tools never card through needsApproval in Ask or Accept edits (the web check raises its own card)', () => {
  for (const m of ['ask', 'auto-edits'] as const) {
    for (const t of ['WebFetch', 'WebSearch', 'mcp__legion__web_read', 'mcp__legion__web_search']) {
      assert.equal(needsApproval(m, t), false, `${m} ${t}: needsApproval must stay false as in 0.3.0; the engine's web check decides on a new site`);
    }
    assert.equal(webChecksApply(m, 'WebFetch'), true, `${m}: the web check applies`);
  }
  assert.equal(webChecksApply('full', 'WebFetch'), false, 'Bypass skips the web check');
  assert.equal(needsApproval('ask', 'Bash'), true, 'sanity: a shell call still cards in Ask');
});

// ---- the web provider transport: its timers and its request cap ----

const quickJson = (): Response => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
const REQ = { url: 'https://api.example.com/search', method: 'POST' as const, headers: { 'content-type': 'application/json' } };

test('the limits are 30 s to the first byte, 60 s in all, 64 KB of request and 2 MB of answer', () => {
  assert.deepEqual(WEB_LIMITS, { headerMs: 30_000, totalMs: 60_000, maxBodyBytes: 2 * 1024 * 1024, maxRequestBytes: 64 * 1024 });
});
test('a provider that sends no first byte is cut off at 30 s, not before', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let aborted = false;
    const fetchImpl = ((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      init.signal!.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); });
    })) as typeof fetch;
    const p = webRequestJson(REQ, { fetchImpl, label: 'Exa' });
    const settled = p.then(() => 'ok', (e: unknown) => e);
    mock.timers.tick(29_999); await Promise.resolve();
    assert.equal(aborted, false, 'still waiting at 29.999 s');
    mock.timers.tick(1);
    assert.equal(aborted, true, 'the request is aborted at 30 s');
    const e = await settled;
    assert.ok(e instanceof WebProviderError);
    assert.equal(e.code, 'network');
    assert.equal(e.message, 'Exa did not answer in time.');
    assert.equal(aborted, true);
  } finally { mock.timers.reset(); }
});
test('an answer that starts at once but never ends is cut off at 60 s in all', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const fetchImpl = ((_u: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode('{"ok"')); init.signal!.addEventListener('abort', () => c.error(new Error('aborted'))); },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;
    const settled = webRequestJson(REQ, { fetchImpl, label: 'Exa' }).then(() => 'ok', (e: unknown) => e);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    mock.timers.tick(30_000); // the first-byte timer is already cleared: nothing happens here
    for (let i = 0; i < 5; i++) await Promise.resolve();
    let early = false; void settled.then(() => { early = true; });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(early, false, 'the call outlives the first-byte limit once bytes are coming');
    mock.timers.tick(29_999);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(early, false, 'and is still open at 59.999 s');
    mock.timers.tick(1);
    const e = await settled;
    assert.ok(e instanceof WebProviderError);
    assert.equal(e.message, 'Exa did not answer in time.');
  } finally { mock.timers.reset(); }
});
test('a request of exactly 64 KB is sent; one byte more is refused before any network call', async () => {
  const sizeOf = (n: number): { body: { q: string }; bytes: number } => { const body = { q: 'a'.repeat(n) }; return { body, bytes: Buffer.byteLength(JSON.stringify(body)) }; };
  const base = Buffer.byteLength(JSON.stringify({ q: '' }));
  let calls = 0;
  const fetchImpl = ((_u: string, _i: RequestInit) => { calls++; return Promise.resolve(quickJson()); }) as typeof fetch;
  const fit = sizeOf(64 * 1024 - base); assert.equal(fit.bytes, 64 * 1024);
  const r = await webRequestJson({ ...REQ, body: fit.body }, { fetchImpl });
  assert.equal(r.status, 200); assert.equal(calls, 1);
  const over = sizeOf(64 * 1024 - base + 1); assert.equal(over.bytes, 64 * 1024 + 1);
  await assert.rejects(() => webRequestJson({ ...REQ, body: over.body }, { fetchImpl }), (e: unknown) => e instanceof WebProviderError && e.code === 'refused' && e.message === ERR_TOO_BIG);
  assert.equal(calls, 1, 'nothing left the machine for the oversize request');
});
test('a multi-byte request is counted in bytes, not characters', async () => {
  const body = { q: 'æ'.repeat(33_000) }; // 33,000 characters, 66,000 bytes
  let calls = 0;
  await assert.rejects(() => webRequestJson({ ...REQ, body }, { fetchImpl: (() => { calls++; return Promise.resolve(quickJson()); }) as typeof fetch }), (e: unknown) => e instanceof WebProviderError && e.message === ERR_TOO_BIG);
  assert.equal(calls, 0);
});
test('plain http, a redirect and an address with a login are refused (the same transport rules)', async () => {
  const f = (() => Promise.resolve(quickJson())) as typeof fetch;
  for (const url of ['http://api.example.com/x', 'https://user:pw@api.example.com/x', 'not a url']) {
    await assert.rejects(() => webRequestJson({ ...REQ, url }, { fetchImpl: f }), (e: unknown) => e instanceof WebProviderError && e.message === ERR_REFUSED, url);
  }
  const redirect = (() => Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.example' } }))) as typeof fetch;
  await assert.rejects(() => webRequestJson(REQ, { fetchImpl: redirect }), (e: unknown) => e instanceof WebProviderError && e.message === ERR_REFUSED);
});
