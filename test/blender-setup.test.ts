/** Managed setup with a fake BlenderIo: no network, no real Blender, no real files. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { defaultBlenderConfig } from '../src/shared/blender.js';
import type { BlenderInstall } from '../src/shared/blender.js';
import { addonInstallPy, checkHash, launchBlender, moduleNameFor, pyExprForFile, setupLive, testConnection } from '../src/core/blender/setup.js';
import type { BlenderIo } from '../src/core/blender/setup.js';
import { isPublicHttpsUrl } from '../src/core/blender/system.js';
import { FakeBackend } from './blender-helpers.js';

const install = (v = '5.1.0'): BlenderInstall => ({ path: '/opt/blender/blender', version: v, source: 'linux' });

/** The sha256 the default configuration pins for the official archive. */
const PINNED = defaultBlenderConfig().advanced.official.sha256;

/** The fake file system speaks forward slashes; path.join gives backslashes on Windows. */
const fwd = (p: string): string => p.replace(/\\/g, '/');

function fakeIo(over: Partial<{ downloadSha: string; blenderOut: string; launcherMissing: boolean; layout: string[]; throwDownload: boolean; hasLock: boolean; lockFails: boolean; launcher: string }> = {}) {
  const log = { downloads: [] as Array<{ url: string; dest: string; maxBytes: number }>, runs: [] as Array<{ file: string; args: string[] }>, writes: new Map<string, string>(), spawned: [] as Array<{ file: string; args: string[] }>, removed: [] as string[], locked: false };
  const layout = over.layout ?? ['blender_mcp'];
  const io: BlenderIo = {
    detect: { platform: 'linux', env: {}, home: '/home/u', exists: () => false, readDir: () => [], run: async () => null },
    run: async (file, args) => {
      log.runs.push({ file, args });
      if (file === install().path) return { code: 0, stdout: over.blenderOut ?? 'LEGION_ADDON_OK name /x\n', stderr: '' };
      if (over.launcherMissing) return null;
      if (args[0] === 'lock') { if (over.lockFails) return { code: 1, stdout: '', stderr: 'no index' }; log.locked = true; return { code: 0, stdout: '', stderr: '' }; }
      return { code: 0, stdout: 'uv 0.5', stderr: '' };
    },
    download: async (url, dest, opts) => { if (over.throwDownload) throw new Error('offline'); log.downloads.push({ url, dest, maxBytes: opts.maxBytes }); return { sha256: over.downloadSha ?? PINNED, bytes: 1234 }; },
    extract: async () => undefined,
    mkdirp: () => undefined,
    writeText: (p, t) => { log.writes.set(p, t); },
    readText: (p) => log.writes.get(p),
    copyFile: () => undefined,
    exists: (q) => { const p = fwd(q); return p.endsWith('/addon') || p.endsWith('/addon/blender_mcp_addon') || p.endsWith('legion_blender') || (p.endsWith('uv.lock') && (over.hasLock === true || log.locked)); },
    isDir: (p) => layout.some((n) => fwd(p).endsWith(`/server/${n}`)),
    listDir: (p) => (fwd(p).endsWith('/server') ? layout : ['addon', 'pyproject.toml']),
    removeDir: (p) => { log.removed.push(p); },
    spawnDetached: (file, args) => { log.spawned.push({ file, args }); },
    now: () => new Date('2026-10-02T00:00:00Z'),
  };
  return { io, log };
}

test('official setup: download (https, size capped), unpack, headless add-on install, launch command recorded, licence shown', async () => {
  const { io, log } = fakeIo();
  const cfg = defaultBlenderConfig();
  const r = await setupLive(io, cfg, '/data', install(), 'official');
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.deepEqual(r.steps.map((s) => s.step), ['blender', 'license', 'download', 'unpack', 'addon', 'launcher', 'lock', 'config']);
  assert.match(r.steps[1]!.detail, /GPL-3\.0-or-later/);
  assert.equal(log.downloads.length, 1);
  assert.equal(log.downloads[0]!.url, cfg.advanced.official.sourceUrl);
  assert.ok(log.downloads[0]!.maxBytes <= 200 * 1024 * 1024);
  assert.equal(log.downloads[0]!.dest, join('/data', 'blender', 'official', 'server-archive.zip'));
  assert.deepEqual(log.runs[0]!.args.slice(0, 3), ['-b', '--factory-startup', '--python-expr']);
  assert.equal(r.entry!.serverDir, join('/data', 'blender', 'official', 'server', 'blender_mcp'));
  assert.ok(r.entry!.args.every((a) => !a.includes('{')), 'placeholders are replaced');
  assert.equal(r.entry!.env.BLENDER_MCP_PORT, String(cfg.port), 'the port reaches the server through its environment');
  assert.ok(Object.values(r.entry!.env).every((v) => !v.includes('{')));
  assert.equal(r.info!.license, 'GPL-3.0-or-later');
  assert.match(r.steps.find((s) => s.step === 'download')!.detail, /matches the pinned/);
  assert.ok(r.entry!.args.includes('--frozen'), 'dependencies are locked after setup');
});

test('official setup is refused for Blender older than 5.1 and nothing is downloaded', async () => {
  const { io, log } = fakeIo();
  const r = await setupLive(io, defaultBlenderConfig(), '/data', install('4.2.0'), 'official');
  assert.equal(r.ok, false);
  assert.equal(log.downloads.length, 0);
  assert.match(r.steps.at(-1)!.detail, /5\.1/);
});

test('no Blender found: setup says what to do and downloads nothing', async () => {
  const { io, log } = fakeIo();
  const r = await setupLive(io, defaultBlenderConfig(), '/data', undefined, 'community');
  assert.equal(r.ok, false);
  assert.equal(log.downloads.length, 0);
  assert.match(r.steps[0]!.detail, /not found/i);
});

test('a pinned sha256 that does not match refuses the file and removes it', async () => {
  const { io, log } = fakeIo({ downloadSha: 'b'.repeat(64) });
  const cfg = defaultBlenderConfig();
  cfg.advanced.official.sha256 = 'a'.repeat(64);
  const r = await setupLive(io, cfg, '/data', install(), 'official');
  assert.equal(r.ok, false);
  assert.match(r.steps.at(-1)!.detail, /does not match/);
  assert.equal(log.runs.length, 0, 'Blender is never started with an unverified file');
  assert.ok(log.removed.length > 0);
});

test('a matching pin passes and says so', async () => {
  const { io } = fakeIo({ downloadSha: 'a'.repeat(64) });
  const cfg = defaultBlenderConfig();
  cfg.advanced.official.sha256 = 'A'.repeat(64);
  const r = await setupLive(io, cfg, '/data', install(), 'official');
  assert.equal(r.ok, true);
  assert.match(r.steps.find((s) => s.step === 'download')!.detail, /matches the pinned/);
});

test('S5: the default official source is pinned (tag URL and sha256), not a branch', () => {
  const o = defaultBlenderConfig().advanced.official;
  assert.match(o.sourceUrl, /v1\.0\.3|1\.0\.3/);
  assert.match(o.sha256, /^[0-9a-f]{64}$/);
});

test('S5: with no pin, the first download is trusted and recorded; the same file again passes', async () => {
  const cfg = defaultBlenderConfig();
  cfg.advanced.official.sha256 = '';
  const first = fakeIo({ downloadSha: 'c'.repeat(64) });
  const r1 = await setupLive(first.io, cfg, '/data', install(), 'official');
  assert.equal(r1.ok, true);
  assert.match(r1.steps.find((s) => s.step === 'download')!.detail, /first use/);
  const prior = r1.info!;
  assert.equal(prior.sha256, 'c'.repeat(64));
  const again = fakeIo({ downloadSha: 'c'.repeat(64) });
  const r2 = await setupLive(again.io, cfg, '/data', install(), 'official', { prior });
  assert.equal(r2.ok, true);
  assert.match(r2.steps.find((s) => s.step === 'download')!.detail, /same file you trusted/);
});

test('S5: a changed hash from the same URL is REFUSED without an explicit re-trust, and nothing is installed', async () => {
  const cfg = defaultBlenderConfig();
  cfg.advanced.official.sha256 = '';
  const prior = { url: cfg.advanced.official.sourceUrl, sha256: 'c'.repeat(64), at: '2026-10-01T00:00:00Z', license: 'GPL-3.0-or-later' };
  const { io, log } = fakeIo({ downloadSha: 'd'.repeat(64) });
  const r = await setupLive(io, cfg, '/data', install(), 'official', { prior });
  assert.equal(r.ok, false);
  assert.equal(r.retrustRequired, true);
  assert.match(r.steps.at(-1)!.detail, /CHANGED/);
  assert.equal(log.runs.length, 0, 'Blender is never started with the changed file');
  assert.ok(log.removed.length > 0, 'the changed download is removed');
  // an explicit re-trust accepts it
  const ok = fakeIo({ downloadSha: 'd'.repeat(64) });
  const r2 = await setupLive(ok.io, cfg, '/data', install(), 'official', { prior, retrust: true });
  assert.equal(r2.ok, true, JSON.stringify(r2.steps));
  assert.equal(r2.info!.sha256, 'd'.repeat(64));
  // a different URL is a new source, not a change
  const other = { ...prior, url: 'https://example.org/other.zip' };
  const o = fakeIo({ downloadSha: 'd'.repeat(64) });
  assert.equal((await setupLive(o.io, cfg, '/data', install(), 'official', { prior: other })).ok, true);
});

test('S5: checkHash covers pinned, first use, same, changed and re-trusted', () => {
  const prior = { url: 'u', sha256: '1'.repeat(64), at: '2026-01-01T00:00:00Z', license: 'MIT' };
  assert.equal(checkHash('', '1'.repeat(64), 'u', prior, false).ok, true);
  const bad = checkHash('', '2'.repeat(64), 'u', prior, false);
  assert.equal(bad.ok, false);
  assert.equal(bad.changed, true);
  assert.equal(checkHash('', '2'.repeat(64), 'u', prior, true).ok, true);
  assert.equal(checkHash('', '2'.repeat(64), 'v', prior, false).ok, true);
  assert.equal(checkHash('', '2'.repeat(64), 'u', null, false).ok, true);
  assert.equal(checkHash('3'.repeat(64), '2'.repeat(64), 'u', prior, true).ok, false, 'a wrong pin is never overridden by re-trust');
});

test('S5: uv dependencies are locked: an existing uv.lock gets --frozen; a missing one is created; a failed lock is reported as NOT PINNED', async () => {
  const have = fakeIo({ hasLock: true });
  const a = await setupLive(have.io, defaultBlenderConfig(), '/data', install(), 'official');
  assert.equal(a.ok, true);
  assert.equal(a.entry!.args[a.entry!.args.indexOf('run') + 1], '--frozen');
  assert.ok(!have.log.runs.some((x) => x.args[0] === 'lock'));
  const make = fakeIo();
  const b = await setupLive(make.io, defaultBlenderConfig(), '/data', install(), 'official');
  assert.equal(b.ok, true);
  assert.ok(make.log.runs.some((x) => x.args[0] === 'lock'));
  assert.ok(b.entry!.args.includes('--frozen'));
  const bad = fakeIo({ lockFails: true });
  const c = await setupLive(bad.io, defaultBlenderConfig(), '/data', install(), 'official');
  assert.equal(c.ok, true);
  assert.match(c.steps.find((s) => s.step === 'lock')!.detail, /NOT PINNED/);
  assert.ok(!c.entry!.args.includes('--frozen'));
});

test('community setup: add-on only, no MCP entry, direct socket explained', async () => {
  const { io, log } = fakeIo();
  const cfg = defaultBlenderConfig();
  const r = await setupLive(io, cfg, '/data', install('4.2.1'), 'community');
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.equal(r.entry, undefined);
  assert.equal(r.info!.license, 'MIT');
  assert.equal(log.downloads[0]!.url, cfg.advanced.community.addonUrl);
  assert.match(r.steps.at(-1)!.detail, /socket/);
});

test('add-on that does not enable: failed step with the tail of Blender output and a manual route', async () => {
  const { io } = fakeIo({ blenderOut: 'Traceback ... ImportError: nope' });
  const r = await setupLive(io, defaultBlenderConfig(), '/data', install('4.2.1'), 'community');
  assert.equal(r.ok, false);
  const a = r.steps.at(-1)!;
  assert.equal(a.step, 'addon');
  assert.match(a.detail, /Install from disk/);
});

test('missing launcher (uv) is a readable failed step', async () => {
  const { io } = fakeIo({ launcherMissing: true });
  const r = await setupLive(io, defaultBlenderConfig(), '/data', install(), 'official');
  assert.equal(r.ok, false);
  assert.equal(r.steps.at(-1)!.step, 'launcher');
  assert.match(r.steps.at(-1)!.detail, /uv/);
});

test('add-on missing inside the archive lists what is there and names the config key', async () => {
  const { io } = fakeIo();
  io.exists = () => false;
  const r = await setupLive(io, defaultBlenderConfig(), '/data', install(), 'official');
  assert.equal(r.ok, false);
  assert.match(r.steps.at(-1)!.detail, /advanced\.official\.addonPath/);
});

test('a failing download is a failed step, not a throw', async () => {
  const { io } = fakeIo({ throwDownload: true });
  const r = await setupLive(io, defaultBlenderConfig(), '/data', install(), 'official');
  assert.equal(r.ok, false);
  assert.match(r.steps.at(-1)!.detail, /offline/);
});

test('the add-on install script is Legion-written, quotes paths safely and is passed through a file, not a shell', () => {
  const py = addonInstallPy('C:\\Users\\Dan "x"\\addon', 'my_addon');
  assert.match(py, /src = "C:\\\\Users\\\\Dan \\"x\\"\\\\addon"/);
  assert.match(py, /addon_utils\.enable/);
  assert.match(pyExprForFile('C:\\d\\install_addon.py'), /^exec\(compile\(open\("C:\\\\d\\\\install_addon\.py"/);
  assert.equal(moduleNameFor('blender-mcp.py'), 'blender_mcp');
  assert.equal(moduleNameFor('9lives'), '_9lives');
});

test('connection test: closed socket stops early; open socket connects and inspects', async () => {
  const cfg = defaultBlenderConfig();
  const b = new FakeBackend();
  const closed = await testConnection(async () => false, cfg, async () => b);
  assert.equal(closed.ok, false);
  assert.deepEqual(closed.steps.map((s) => s.step), ['socket']);
  const open = await testConnection(async () => true, cfg, async () => b);
  assert.equal(open.ok, true);
  assert.deepEqual(open.steps.map((s) => s.step), ['socket', 'connect', 'inspect']);
  const broken = await testConnection(async () => true, cfg, async () => { throw new Error('add-on says no'); });
  assert.equal(broken.ok, false);
  assert.match(broken.steps.at(-1)!.detail, /add-on says no/);
});

test('launch: community starts Blender with the fixed expression; official starts it plain; nothing without Blender', () => {
  const { io, log } = fakeIo();
  const cfg = defaultBlenderConfig();
  assert.equal(launchBlender(io, cfg, install(), 'community').ok, true);
  assert.deepEqual(log.spawned[0], { file: '/opt/blender/blender', args: ['--python-expr', cfg.advanced.community.startExpr] });
  assert.equal(launchBlender(io, cfg, install(), 'official').ok, true);
  assert.deepEqual(log.spawned[1]!.args, []);
  assert.equal(launchBlender(io, cfg, undefined, 'official').ok, false);
  assert.equal(log.spawned.length, 2);
});

test('download address rules: https and public only', () => {
  for (const ok of ['https://projects.blender.org/x.zip', 'https://raw.githubusercontent.com/a/b/main/addon.py']) assert.equal(isPublicHttpsUrl(ok), true, ok);
  for (const bad of ['http://example.org/a', 'https://localhost/a', 'https://127.0.0.1/a', 'https://10.0.0.5/a', 'https://192.168.1.2/a', 'https://172.20.0.1/a', 'https://169.254.169.254/latest', 'https://user:pw@example.org/a', 'https://[::1]/a', 'https://printer.local/a', 'ftp://example.org/a', 'not a url', 'file:///etc/passwd'])
    assert.equal(isPublicHttpsUrl(bad), false, bad);
});

// ---- the real download function, with the global fetch replaced (no network)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRealIo } from '../src/core/blender/system.js';
import { tmp } from './blender-helpers.js';

async function withFetch<T>(impl: (url: string) => Response | Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => impl(String(u))) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

test('real download: streams to disk, returns sha256 and size, leaves no .part file', async () => {
  const dir = tmp();
  const body = Buffer.from('hello blender');
  const r = await withFetch(() => new Response(body, { status: 200 }), () => createRealIo().download('https://example.org/a.zip', join(dir, 'a.zip'), { maxBytes: 1000 }));
  assert.equal(r.bytes, body.length);
  assert.equal(r.sha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(readFileSync(join(dir, 'a.zip'), 'utf8'), 'hello blender');
  assert.ok(!existsSync(join(dir, 'a.zip.part')));
});

test('real download: over the size limit is refused (declared or streamed) and nothing is kept', async () => {
  const dir = tmp();
  await assert.rejects(withFetch(() => new Response('x', { status: 200, headers: { 'content-length': '5000' } }), () => createRealIo().download('https://example.org/a', join(dir, 'a'), { maxBytes: 100 })), /limit/);
  await assert.rejects(withFetch(() => new Response(Buffer.alloc(500), { status: 200 }), () => createRealIo().download('https://example.org/a', join(dir, 'b'), { maxBytes: 100 })), /larger/);
  assert.ok(!existsSync(join(dir, 'a')) && !existsSync(join(dir, 'b')) && !existsSync(join(dir, 'b.part')));
});

test('real download: redirects are followed only to public https hosts', async () => {
  const dir = tmp();
  const seen: string[] = [];
  const redirectTo = (loc: string) => new Response(null, { status: 302, headers: { location: loc } });
  const ok = await withFetch((u) => { seen.push(u); return u.endsWith('/final') ? new Response('ok') : redirectTo('/final'); }, () => createRealIo().download('https://example.org/start', join(dir, 'ok'), { maxBytes: 100 }));
  assert.equal(ok.bytes, 2);
  assert.deepEqual(seen, ['https://example.org/start', 'https://example.org/final']);
  for (const bad of ['http://example.org/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest']) {
    await assert.rejects(withFetch(() => redirectTo(bad), () => createRealIo().download('https://example.org/start', join(dir, 'bad'), { maxBytes: 100 })), /https and public/, bad);
  }
  await assert.rejects(withFetch(() => redirectTo('/again'), () => createRealIo().download('https://example.org/loop', join(dir, 'loop'), { maxBytes: 100 })), /redirects/);
});

test('real download: an HTTP error is a readable failure', async () => {
  await assert.rejects(withFetch(() => new Response('no', { status: 404 }), () => createRealIo().download('https://example.org/a', join(tmp(), 'a'), { maxBytes: 100 })), /HTTP 404/);
});
