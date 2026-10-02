/** C1, C2, C3, C4, C20 (network part): policy, redirects, caps, offline and rate limits. Only loopback servers; no real host is contacted. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED_HOSTS, assetUrl, manifestUrl, PRODUCTION_SOURCE, sigUrl } from '../src/core/updater/config.js';
import { downloadFile, fetchSmall, NetError, validateUrl, type FetchLike } from '../src/core/updater/net.js';
import { makeKey, makeRelease, sha256, startFakeServer } from './updater-helpers.js';

const P = PRODUCTION_SOURCE.policy;
const k = makeKey();
const kindOf = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof NetError ? e.kind : `other:${(e as Error).message}`; } };

test('C1: the production policy is https, port 443, exactly three GitHub hosts, no credentials', () => {
  assert.deepEqual([...ALLOWED_HOSTS], ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
  assert.equal(P.allowLoopbackHttp, false);
  assert.ok(Object.isFrozen(PRODUCTION_SOURCE) && Object.isFrozen(P) && Object.isFrozen(P.hosts));
  for (const ok of ['https://github.com/dnh33/legion/releases/latest/download/x', 'https://objects.githubusercontent.com/a?b=c', 'https://release-assets.githubusercontent.com/z', 'https://github.com:443/x']) validateUrl(ok, P);
  for (const bad of ['http://github.com/x', 'https://evil.example/x', 'https://github.com.evil.example/x', 'https://user:pw@github.com/x', 'https://github.com:8443/x', 'https://127.0.0.1/x', 'http://127.0.0.1:1/x', 'https://api.github.com/x', 'ftp://github.com/x', 'file:///etc/passwd', 'not a url', 'https://githubusercontent.com/x', 'https://[::1]/x']) {
    assert.throws(() => validateUrl(bad, P), NetError, bad);
  }
});
test('C3: urls are built from constants and the validated version', () => {
  assert.equal(manifestUrl(PRODUCTION_SOURCE), 'https://github.com/dnh33/legion/releases/latest/download/legion-update-manifest.json');
  assert.equal(sigUrl(PRODUCTION_SOURCE), 'https://github.com/dnh33/legion/releases/latest/download/legion-update-manifest.json.sig');
  assert.equal(assetUrl(PRODUCTION_SOURCE, '0.2.1'), 'https://github.com/dnh33/legion/releases/download/v0.2.1/legion-0.2.1-app.zip');
  for (const u of [manifestUrl(PRODUCTION_SOURCE), assetUrl(PRODUCTION_SOURCE, '1.0.0')]) validateUrl(u, P);
});

test('C2: redirects are followed by hand, every hop is validated, at most 3', async () => {
  const hops: string[] = [];
  const mk = (map: Record<string, string>): FetchLike => async (u) => {
    hops.push(u);
    const next = map[u];
    if (next) return new Response(null, { status: 302, headers: { location: next } });
    return new Response('hello', { status: 200 });
  };
  const A = 'https://github.com/a';
  hops.length = 0;
  assert.equal((await fetchSmall(A, P, { maxBytes: 100, version: '0', fetchImpl: mk({ [A]: 'https://objects.githubusercontent.com/b' }) })).toString(), 'hello');
  assert.deepEqual(hops, [A, 'https://objects.githubusercontent.com/b']);
  assert.equal(await kindOf(fetchSmall(A, P, { maxBytes: 100, version: '0', fetchImpl: mk({ [A]: 'https://evil.example/b' }) })), 'policy');
  assert.equal(await kindOf(fetchSmall(A, P, { maxBytes: 100, version: '0', fetchImpl: mk({ [A]: 'http://github.com/b' }) })), 'policy');
  assert.equal(await kindOf(fetchSmall(A, P, { maxBytes: 100, version: '0', fetchImpl: mk({ [A]: '//evil.example/b' }) })), 'policy');
  const chain: Record<string, string> = { [A]: 'https://github.com/1', 'https://github.com/1': 'https://github.com/2', 'https://github.com/2': 'https://github.com/3', 'https://github.com/3': 'https://github.com/4' };
  assert.equal(await kindOf(fetchSmall(A, P, { maxBytes: 100, version: '0', fetchImpl: mk(chain) })), 'policy');
  delete chain['https://github.com/3'];
  assert.equal(await kindOf(fetchSmall(A, P, { maxBytes: 100, version: '0', fetchImpl: mk(chain) })), 'ok');
  assert.equal(await kindOf(fetchSmall('https://evil.example/x', P, { maxBytes: 100, version: '0', fetchImpl: mk({}) })), 'policy');
});
test('C2: the request carries no credentials or cookies and a fixed user agent', async () => {
  let seen: Record<string, string> = {};
  const f: FetchLike = async (_u, init) => { seen = init.headers; return new Response('x'); };
  await fetchSmall('https://github.com/a', P, { maxBytes: 10, version: '9.9.9', fetchImpl: f });
  assert.deepEqual(Object.keys(seen).sort(), ['accept', 'user-agent']);
  assert.equal(seen['user-agent'], 'Legion-Updater/9.9.9');
});

test('C4: size caps apply to the declared length and to the stream', async () => {
  const s = await startFakeServer(null);
  try {
    s.handler.custom = (req, res) => {
      if (req.url === '/big') { res.writeHead(200, { 'content-length': '5000' }); res.end(Buffer.alloc(5000)); return true; }
      if (req.url === '/chunked') { res.writeHead(200); res.write(Buffer.alloc(3000)); res.end(Buffer.alloc(3000)); return true; }
      return false;
    };
    assert.equal(await kindOf(fetchSmall(`${s.url}/big`, s.source.policy, { maxBytes: 1000, version: '0' })), 'size');
    assert.equal(await kindOf(fetchSmall(`${s.url}/chunked`, s.source.policy, { maxBytes: 1000, version: '0' })), 'size');
    const dir = mkdtempSync(join(tmpdir(), 'upd-net-'));
    // package: signed size 100, server sends 5000 declared -> refused before any byte is written; chunked 6000 -> aborted, no file left
    assert.equal(await kindOf(downloadFile(`${s.url}/big`, s.source.policy, join(dir, 'a.part'), { exactSize: 100, version: '0' })), 'size');
    assert.equal(await kindOf(downloadFile(`${s.url}/chunked`, s.source.policy, join(dir, 'b.part'), { exactSize: 100, version: '0' })), 'size');
    assert.equal(await kindOf(downloadFile(`${s.url}/chunked`, s.source.policy, join(dir, 'c.part'), { exactSize: 9000, version: '0' })), 'size', 'shorter than signed');
    assert.deepEqual(readdirSync(dir), [], 'no partial file is left behind');
  } finally { await s.close(); }
});
test('C4: a download that matches the signed size is hashed while streaming', async () => {
  const r = makeRelease(k, '0.2.1');
  const s = await startFakeServer(r);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'upd-net-'));
    const out = await downloadFile(assetUrl(s.source, '0.2.1'), s.source.policy, join(dir, 'p.zip.part'), { exactSize: r.zip.length, version: '0' });
    assert.equal(out.sha256, sha256(r.zip));
    assert.ok(existsSync(join(dir, 'p.zip.part')));
  } finally { await s.close(); }
});

test('C20: offline, timeout, 5xx, 403/429 (Retry-After), 404 are typed errors and never throw anything else', async () => {
  const f = (status: number, headers: Record<string, string> = {}): FetchLike => async () => new Response('x', { status, headers });
  assert.equal(await kindOf(fetchSmall('https://github.com/a', P, { maxBytes: 9, version: '0', fetchImpl: async () => { throw new TypeError('fetch failed'); } })), 'offline');
  assert.equal(await kindOf(fetchSmall('https://github.com/a', P, { maxBytes: 9, version: '0', fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; } })), 'timeout');
  assert.equal(await kindOf(fetchSmall('https://github.com/a', P, { maxBytes: 9, version: '0', fetchImpl: f(503) })), 'offline');
  assert.equal(await kindOf(fetchSmall('https://github.com/a', P, { maxBytes: 9, version: '0', fetchImpl: f(404) })), 'http');
  try { await fetchSmall('https://github.com/a', P, { maxBytes: 9, version: '0', fetchImpl: f(429, { 'retry-after': '120' }) }); assert.fail('should throw'); }
  catch (e) { assert.equal((e as NetError).kind, 'rate-limit'); assert.equal((e as NetError).retryAfterMs, 120_000); }
  try { await fetchSmall('https://github.com/a', P, { maxBytes: 9, version: '0', fetchImpl: f(403, { 'retry-after': '99999999' }) }); assert.fail('should throw'); }
  catch (e) { assert.equal((e as NetError).retryAfterMs, 24 * 3600_000, 'capped at a day'); }
  try { await fetchSmall('https://github.com/a', P, { maxBytes: 9, version: '0', fetchImpl: f(403) }); assert.fail('should throw'); }
  catch (e) { assert.equal((e as NetError).retryAfterMs, 3600_000, 'default backoff one hour'); }
});
