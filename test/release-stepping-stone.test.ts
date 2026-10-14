/**
 * The stepping stone, release side (docs/SHIPPING.md, Stepping stones): two manifest names, the old name of a full-install release is a signed
 * stepping stone copied byte for byte, preflight/verify refuse anything else, and the daily check notices a stone whose package vanished.
 * The client side is in updater-module.test.ts. Everything here is offline with throwaway keys.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeZip } from './updater-helpers.js';

process.env.LEGION_REHEARSAL = '1'; // these tests use the rehearsal-only skip flags (see release-rehearsal-gate.test.ts)
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const S = (n: string): string => join(REPO, 'scripts', n);
const tmp = (): string => realpathSync.native(mkdtempSync(join(tmpdir(), 'legion-stone-')));
const sh = (script: string, ...argv: string[]): { code: number; out: string } => {
  try { return { code: 0, out: execFileSync(process.execPath, [S(script), ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { const x = e as { status?: number; stdout?: string; stderr?: string }; return { code: x.status ?? 1, out: `${x.stdout ?? ''}${x.stderr ?? ''}` }; }
};
const NOW = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/** A throwaway key plus a trust module that holds only it: what release-sign and release-verify are told to trust. */
function trustFixture(): { key: string; trust: string } {
  const dir = tmp();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = join(dir, 'k.key.pem'); writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const trust = join(dir, 'trust.mjs');
  writeFileSync(trust, `import { verifyManifestSignature as v } from ${JSON.stringify(pathToFileURL(join(REPO, 'dist/src/core/updater/trust.js')).href)};\nexport const UPDATE_KEYS = [{ id: 'k1', publicKeyPem: ${JSON.stringify(publicKey.export({ type: 'spki', format: 'pem' }).toString())} }];\nexport const verifyManifestSignature = (m, s, k) => v(m, s, k);\n`);
  return { key, trust };
}
/** legion-<v>-app.zip (and with `full` a legion-<v>-win-x64.zip) in a fresh folder. */
function pkg(version: string, full: boolean, lock = '{"lockfileVersion":3}\n'): string {
  const dir = tmp(); const top = `legion-${version}/`;
  writeFileSync(join(dir, `legion-${version}-app.zip`), makeZip([
    { name: `${top}package.json`, data: JSON.stringify({ name: 'legion', version }) }, { name: `${top}package-lock.json`, data: lock },
    { name: `${top}build-info.json`, data: JSON.stringify({ version, publishedAt: NOW }) },
  ]));
  if (full) writeFileSync(join(dir, `legion-${version}-win-x64.zip`), Buffer.from(`full package bytes of ${version}`));
  writeFileSync(join(dir, 'notes.txt'), 'notes\n');
  return dir;
}
/** The signed stone: a published code-only release folder holding its manifest and .sig under the old name. */
function stone(t: { key: string; trust: string }, version = '0.3.0'): string {
  const d = pkg(version, false);
  assert.equal(sh('release-manifest.mjs', '--zip', join(d, `legion-${version}-app.zip`), '--notes', join(d, 'notes.txt'), '--out', d, '--stones', version).code, 0);
  assert.equal(sh('release-sign.mjs', '--key', t.key, '--manifest', join(d, 'legion-update-manifest-2.json'), '--trust-module', t.trust).code, 0);
  return d;
}
const full = (version: string, stoneDir?: string): string => {
  const d = pkg(version, true);
  const r = sh('release-manifest.mjs', '--zip', join(d, `legion-${version}-app.zip`), '--full-zip', join(d, `legion-${version}-win-x64.zip`), '--requires-full-install', '--notes', join(d, 'notes.txt'), '--out', d, ...(stoneDir ? ['--stepping-stone', stoneDir] : []));
  assert.equal(r.code, 0, r.out);
  return d;
};
/** A code-only release AFTER the stone: its own manifest under the second name, the stone's bytes under the old name. */
const later = (version: string, stoneDir?: string): { code: number; out: string; dir: string } => {
  const d = pkg(version, false);
  const r = sh('release-manifest.mjs', '--zip', join(d, `legion-${version}-app.zip`), '--notes', join(d, 'notes.txt'), '--out', d, ...(stoneDir ? ['--stepping-stone', stoneDir] : []));
  return { ...r, dir: d };
};
const readJ = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;

test('stone: a code-only release publishes the same bytes under both names, and one signature serves both', () => {
  const t = trustFixture(); const d = stone(t);
  assert.deepEqual(readFileSync(join(d, 'legion-update-manifest.json')), readFileSync(join(d, 'legion-update-manifest-2.json')));
  assert.equal(readFileSync(join(d, 'legion-update-manifest.json.sig'), 'utf8'), readFileSync(join(d, 'legion-update-manifest-2.json.sig'), 'utf8'));
  assert.equal(readJ(join(d, 'legion-update-manifest.json')).minUpdater, undefined, 'a code-only release applies on any updater');
});

test('stone: a full-install release keeps the stone byte for byte under the old name and names it, signed, in the second manifest', () => {
  const t = trustFixture(); const sd = stone(t); const d = full('0.5.0', sd);
  assert.deepEqual(readFileSync(join(d, 'legion-update-manifest.json')), readFileSync(join(sd, 'legion-update-manifest.json')));
  assert.equal(readFileSync(join(d, 'legion-update-manifest.json.sig'), 'utf8'), readFileSync(join(sd, 'legion-update-manifest.json.sig'), 'utf8'), 'the stone is never re-signed');
  const own = readJ(join(d, 'legion-update-manifest-2.json'));
  const st = readJ(join(sd, 'legion-update-manifest.json'));
  assert.equal(own.version, '0.5.0'); assert.equal(own.minUpdater, 2);
  assert.deepEqual(own.steppingStone, { version: st.version, publishedAt: st.publishedAt, depsSha256: st.depsSha256, asset: st.asset });
  assert.match(readFileSync(join(d, 'SHA256SUMS.txt'), 'utf8'), /  legion-update-manifest-2\.json$/m);
});

test('stone: release-verify accepts a full release with its stone and refuses one whose old name is the full release itself', () => {
  const t = trustFixture(); const sd = stone(t);
  const ok = full('0.5.0', sd);
  assert.equal(sh('release-sign.mjs', '--key', t.key, '--manifest', join(ok, 'legion-update-manifest-2.json'), '--trust-module', t.trust).code, 0);
  const good = sh('release-verify.mjs', '--dir', ok, '--trust-module', t.trust, '--no-network');
  assert.equal(good.code, 0, good.out);
  const refused = sh('release-manifest.mjs', '--zip', join(ok, 'legion-0.5.0-app.zip'), '--full-zip', join(ok, 'legion-0.5.0-win-x64.zip'), '--requires-full-install', '--out', mkdtempSync(join(tmpdir(), 'legion-stone-')));
  assert.notEqual(refused.code, 0); assert.match(refused.out, /stepping-stone/, 'the manifest script will not build a full release that is its own old name');
  copyFileSync(join(ok, 'legion-update-manifest-2.json'), join(ok, 'legion-update-manifest.json'));
  copyFileSync(join(ok, 'legion-update-manifest-2.json.sig'), join(ok, 'legion-update-manifest.json.sig'));
  const bad = sh('release-verify.mjs', '--dir', ok, '--trust-module', t.trust, '--no-network');
  assert.notEqual(bad.code, 0); assert.match(bad.out, /stepping stone/i);
});

test('stone: --stepping-stone is refused for a code-only release and for a stone that is not older', () => {
  const t = trustFixture(); const sd = stone(t, '0.6.0');
  const d = pkg('0.5.0', true);
  const r = sh('release-manifest.mjs', '--zip', join(d, 'legion-0.5.0-app.zip'), '--full-zip', join(d, 'legion-0.5.0-win-x64.zip'), '--requires-full-install', '--out', d, '--stepping-stone', sd, '--stones', '0.6.0');
  assert.notEqual(r.code, 0); assert.match(r.out, /not older/);
});

test('stone: EVERY release after the stone, code-only or full, parks the stone itself under the old name (never itself)', () => {
  const t = trustFixture(); const sd = stone(t);
  const a = later('0.3.2', sd);
  assert.equal(a.code, 0, a.out);
  assert.deepEqual(readFileSync(join(a.dir, 'legion-update-manifest.json')), readFileSync(join(sd, 'legion-update-manifest.json')), 'a code-only release after the stone leaves the stone under the old name');
  assert.equal(readFileSync(join(a.dir, 'legion-update-manifest.json.sig'), 'utf8'), readFileSync(join(sd, 'legion-update-manifest.json.sig'), 'utf8'));
  assert.equal(readJ(join(a.dir, 'legion-update-manifest-2.json')).version, '0.3.2');
  const bare = later('0.3.3');
  assert.notEqual(bare.code, 0, 'a code-only release after the stone without --stepping-stone would put itself under the old name');
  assert.match(bare.out, /stepping-stone/);
  const older = later('0.2.9', sd);
  assert.notEqual(older.code, 0); assert.match(older.out, /not older/);
});

test('stone: a code-only release after a full one verifies with the stone under the old name and is refused with itself there', () => {
  const t = trustFixture(); const sd = stone(t);
  const ok = later('0.3.2', sd);
  assert.equal(sh('release-sign.mjs', '--key', t.key, '--manifest', join(ok.dir, 'legion-update-manifest-2.json'), '--trust-module', t.trust).code, 0);
  // the fixture stone and the later release share one lock, so no full package is needed; release-verify is told which lock is the stone's
  const stoneLock = join(tmp(), 'package-lock.json'); writeFileSync(stoneLock, '{"lockfileVersion":3}\n');
  const good = sh('release-verify.mjs', '--dir', ok.dir, '--trust-module', t.trust, '--no-network', '--stone-lock', stoneLock);
  assert.equal(good.code, 0, good.out);
  // the failure the stone design must prevent: the later code-only release replaces the stone under the old name
  copyFileSync(join(ok.dir, 'legion-update-manifest-2.json'), join(ok.dir, 'legion-update-manifest.json'));
  copyFileSync(join(ok.dir, 'legion-update-manifest-2.json.sig'), join(ok.dir, 'legion-update-manifest.json.sig'));
  const bad = sh('release-verify.mjs', '--dir', ok.dir, '--trust-module', t.trust, '--no-network', '--stone-lock', stoneLock);
  assert.notEqual(bad.code, 0); assert.match(bad.out, /stepping stone/i);
});

// ---- the shared rules, offline: a fake trust that accepts everything, the app's own parser
interface Lib { stoneProblems(o: Record<string, unknown>): Promise<string[]>; liveProblems(o: Record<string, unknown>): Promise<string[]> }
async function lib(): Promise<{ L: Lib; parseManifest: (b: Buffer) => unknown; trust: unknown }> {
  const L = (await import(pathToFileURL(S('lib/stepping-stone.mjs')).href)) as Lib;
  const { parseManifest } = (await import(pathToFileURL(join(REPO, 'dist/src/core/updater/manifest.js')).href)) as { parseManifest: (b: Buffer) => unknown };
  return { L, parseManifest, trust: { UPDATE_KEYS: [], verifyManifestSignature: () => ({ ok: true }) } };
}
function pair(): { oldB: Buffer; newB: Buffer; asset: { size: number; sha256: string } } {
  const t = trustFixture(); const sd = stone(t); const d = full('0.5.0', sd);
  const oldB = readFileSync(join(d, 'legion-update-manifest.json'));
  return { oldB, newB: readFileSync(join(d, 'legion-update-manifest-2.json')), asset: (readJ(join(sd, 'legion-update-manifest.json')).asset) as { size: number; sha256: string } };
}
test('stone rules: a good pair passes; the signed size and hash of the stone package must come back exactly', async () => {
  const { L, parseManifest, trust } = await lib(); const p = pair();
  const base = { oldBytes: p.oldB, oldSig: 'x', newBytes: p.newB, trust, parseManifest, stones: ['0.3.0'] };
  assert.deepEqual(await L.stoneProblems({ ...base, fetchAsset: async () => p.asset }), []);
  assert.match((await L.stoneProblems({ ...base, fetchAsset: async () => ({ ...p.asset, size: p.asset.size + 1 }) })).join(), /returns \d+ bytes/);
  assert.match((await L.stoneProblems({ ...base, fetchAsset: async () => ({ ...p.asset, sha256: 'a'.repeat(64) }) })).join(), /returns sha256/);
  assert.match((await L.stoneProblems({ ...base, fetchAsset: async () => { throw new Error('HTTP 404'); } })).join(), /not reachable/);
  assert.match((await L.stoneProblems({ ...base, stones: ['0.1.0'] })).join(), /permanent stepping stone/);
  assert.match((await L.stoneProblems({ ...base, oldBytes: p.newB })).join(), /itself a full-install|same manifest/);
});
test('stone rules: a later code-only release may not carry itself under the old name; the stone release itself must', async () => {
  const { L, parseManifest, trust } = await lib(); const t = trustFixture();
  const sd = stone(t); const stoneB = readFileSync(join(sd, 'legion-update-manifest.json'));
  const l = later('0.3.2', sd); const ownB = readFileSync(join(l.dir, 'legion-update-manifest-2.json'));
  const base = { oldSig: 'x', trust, parseManifest, stones: ['0.3.0'] };
  assert.deepEqual(await L.stoneProblems({ ...base, oldBytes: stoneB, newBytes: ownB }), [], 'stone under the old name, own manifest under the new one');
  assert.match((await L.stoneProblems({ ...base, oldBytes: ownB, newBytes: ownB })).join(), /stepping stone/, 'a later release under both names strands 0.2.7');
  assert.deepEqual(await L.stoneProblems({ ...base, oldBytes: stoneB, newBytes: stoneB }), [], 'the stone release itself publishes one manifest under both names');
});
test('stone rules: the daily check fails loudly when the live old-name manifest or the stone package is gone', async () => {
  const { L, parseManifest, trust } = await lib(); const p = pair();
  const ok = (bytes: Buffer) => ({ status: 200, bytes });
  const files = (over: Record<string, { status: number; bytes: Buffer }> = {}) => async (url: string) => over[url.split('/').pop()!] ?? (url.endsWith('manifest-2.json') ? ok(p.newB) : url.endsWith('.sig') ? ok(Buffer.from('s')) : ok(p.oldB));
  const run = (getBytes: (u: string) => Promise<{ status: number; bytes: Buffer }>, asset: { size: number; sha256: string } | Error) => L.liveProblems({ getBytes, latestTag: async () => 'v0.5.0', fetchAsset: async () => { if (asset instanceof Error) throw asset; return asset; }, trust, parseManifest });
  assert.deepEqual(await run(files(), p.asset), []);
  assert.match((await run(files({ 'legion-update-manifest.json': { status: 404, bytes: Buffer.alloc(0) } }), p.asset)).join(), /stranded/);
  assert.match((await run(files(), new Error('HTTP 404'))).join(), /not reachable/);
  assert.match((await run(files(), { ...p.asset, sha256: 'b'.repeat(64) })).join(), /returns sha256/);
});
test('stone rules: the daily check FAILS when the latest release has no second-name manifest or its version is not the latest tag', async () => {
  const { L, parseManifest, trust } = await lib(); const p = pair();
  const ok = (bytes: Buffer) => ({ status: 200, bytes });
  const gone = async (url: string) => url.includes('manifest-2.json') ? { status: 404, bytes: Buffer.alloc(0) } : url.endsWith('.sig') ? ok(Buffer.from('s')) : ok(p.oldB);
  const run = (getBytes: (u: string) => Promise<{ status: number; bytes: Buffer }>, latestTag: () => Promise<string>) => L.liveProblems({ getBytes, latestTag, fetchAsset: async () => p.asset, trust, parseManifest });
  const out404 = (await run(gone, async () => 'v0.5.0')).join();
  assert.match(out404, /second-name/); assert.match(out404, /every 0\.3\.0/);
  const fine = async (url: string) => url.endsWith('manifest-2.json') ? ok(p.newB) : url.endsWith('.sig') ? ok(Buffer.from('s')) : ok(p.oldB);
  assert.match((await run(fine, async () => 'v0.5.1')).join(), /latest release is v0\.5\.1/);
  assert.match((await run(fine, async () => { throw new Error('no redirect'); })).join(), /latest release/);
});
test('stone rules: the old name of the live release must be the stone as published at its own tag', async () => {
  const { L, parseManifest, trust } = await lib(); const p = pair();
  const ok = (bytes: Buffer) => ({ status: 200, bytes });
  const tampered = Buffer.from(p.oldB.toString('utf8') + ' ');
  const getBytes = async (url: string) => url.includes('/releases/download/v0.3.0/') && !url.endsWith('.sig') ? ok(tampered) : url.endsWith('manifest-2.json') ? ok(p.newB) : url.endsWith('.sig') ? ok(Buffer.from('s')) : ok(p.oldB);
  const r = (await L.liveProblems({ getBytes, latestTag: async () => 'v0.5.0', fetchAsset: async () => p.asset, trust, parseManifest })).join();
  assert.match(r, /differs from the stone/);
});
test('stone rules: when the latest release IS the stone, its package is still hashed against the signed size and sha256', async () => {
  const { L, parseManifest, trust } = await lib(); const t = trustFixture(); const sd = stone(t);
  const b = readFileSync(join(sd, 'legion-update-manifest.json')); const asset = readJ(join(sd, 'legion-update-manifest.json')).asset as { size: number; sha256: string };
  const base = { oldBytes: b, oldSig: 'x', newBytes: b, trust, parseManifest };
  assert.deepEqual(await L.stoneProblems({ ...base, fetchAsset: async () => asset }), []);
  assert.match((await L.stoneProblems({ ...base, fetchAsset: async () => ({ ...asset, sha256: 'c'.repeat(64) }) })).join(), /returns sha256/);
  assert.match((await L.stoneProblems({ ...base, fetchAsset: async () => { throw new Error('HTTP 404'); } })).join(), /not reachable/);
  assert.deepEqual(await L.stoneProblems({ ...base, publishing: true, fetchAsset: async () => { throw new Error('not uploaded yet'); } }), [], 'the stone release itself, before it is published, has no package to fetch');
});
test('stone rules: the old name must equal the PUBLISHED stone file and signature byte for byte; a network failure is a failure', async () => {
  const { L, parseManifest, trust } = await lib(); const t = trustFixture(); const sd = stone(t);
  const stoneB = readFileSync(join(sd, 'legion-update-manifest.json')); const stoneSig = readFileSync(join(sd, 'legion-update-manifest.json.sig'));
  const l = later('0.3.2', sd); const ownB = readFileSync(join(l.dir, 'legion-update-manifest-2.json'));
  const base = { oldBytes: stoneB, oldSig: stoneSig.toString('utf8'), newBytes: ownB, trust, parseManifest };
  const served = (m: Buffer, sig: Buffer) => async (url: string) => ({ status: 200, bytes: url.includes('/releases/download/v0.3.0/') ? (url.endsWith('.sig') ? sig : m) : Buffer.alloc(0) });
  assert.deepEqual(await L.stoneProblems({ ...base, getBytes: served(stoneB, stoneSig) }), []);
  assert.match((await L.stoneProblems({ ...base, getBytes: served(Buffer.from(stoneB.toString('utf8') + ' '), stoneSig) })).join(), /published v0\.3\.0/, 're-signed manifest bytes');
  assert.match((await L.stoneProblems({ ...base, getBytes: served(stoneB, Buffer.from('another signature')) })).join(), /published v0\.3\.0/, 'a different signature');
  assert.match((await L.stoneProblems({ ...base, getBytes: async () => ({ status: 404, bytes: Buffer.alloc(0) }) })).join(), /published stone v0\.3\.0/);
  assert.match((await L.stoneProblems({ ...base, getBytes: async () => { throw new Error('offline'); } })).join(), /offline/);
});
test('stone rules: exactly one permanent stone (0.3.0) is pinned in code; the file may not list another', async () => {
  const L = (await import(pathToFileURL(S('lib/stepping-stone.mjs')).href)) as { PERMANENT_STONE: string; readStones(p?: string): string[] };
  assert.equal(L.PERMANENT_STONE, '0.3.0');
  assert.deepEqual(L.readStones(), ['0.3.0']);
  const d = tmp(); const f = join(d, 's.json');
  writeFileSync(f, JSON.stringify({ stones: ['0.3.0', '0.4.0'] })); assert.throws(() => L.readStones(f), /permanent/i);
  writeFileSync(f, JSON.stringify({ stones: ['0.4.0'] })); assert.throws(() => L.readStones(f), /permanent/i);
});
test('stone rules: the old name must be THE permanent stone, not any other release', async () => {
  const { L, parseManifest, trust } = await lib(); const t = trustFixture();
  const sd = stone(t, '0.4.0'); // a code-only release built under a throwaway stone list
  const d2 = pkg('0.4.1', false);
  assert.equal(sh('release-manifest.mjs', '--zip', join(d2, 'legion-0.4.1-app.zip'), '--out', d2, '--stones', '0.4.0', '--stepping-stone', sd).code, 0);
  const o = readFileSync(join(sd, 'legion-update-manifest.json')), n = readFileSync(join(d2, 'legion-update-manifest-2.json'));
  assert.match((await L.stoneProblems({ oldBytes: o, oldSig: 'x', newBytes: n, trust, parseManifest })).join(), /permanent stepping stone/);
});

test('stone rules: fetchBytes gives up on a server that never answers', async () => {
  const { createServer } = await import('node:http');
  const srv = createServer(() => { /* never answers */ }); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { fetchBytes } = (await import(pathToFileURL(S('lib/stepping-stone.mjs')).href)) as { fetchBytes(u: string, ms: number): Promise<unknown> };
    const port = (srv.address() as { port: number }).port;
    await assert.rejects(fetchBytes(`http://127.0.0.1:${port}/x`, 200), /timed out|abort|timeout/i);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('publish: assets go up to a DRAFT, both manifest names with their signatures included, and only then does it become latest', () => {
  const t = trustFixture(); const sd = stone(t); const l = later('0.3.2', sd);
  const run = (dir: string) => sh('release-publish.mjs', '--dir', dir, '--version', '0.3.2', '--notes-file', join(dir, 'notes.txt'), '--trust-module', t.trust, '--no-network', '--dry-run');
  assert.equal(sh('release-sign.mjs', '--key', t.key, '--manifest', join(l.dir, 'legion-update-manifest-2.json'), '--trust-module', t.trust).code, 0);
  for (const f of ['SHA256SUMS.txt.sig', 'install.ps1', 'install.sh', 'legion-0.3.2-win-x64.zip']) writeFileSync(join(l.dir, f), 'x');
  const r = run(l.dir); assert.equal(r.code, 0, r.out);
  const lines = r.out.split('\n').filter((x) => x.startsWith('gh '));
  assert.match(lines[0], /release create v0\.3\.2 .*--draft/);
  assert.match(lines[lines.length - 1], /release edit v0\.3\.2 .*--draft=false --latest/);
  const up = lines.filter((x) => x.includes('release upload')).join(' ');
  for (const n of ['legion-update-manifest.json', 'legion-update-manifest.json.sig', 'legion-update-manifest-2.json', 'legion-update-manifest-2.json.sig', 'legion-0.3.2-app.zip', 'SHA256SUMS.txt']) assert.ok(up.includes(n), n);
  assert.ok(lines.findIndex((x) => x.includes('release upload')) < lines.length - 1, 'every upload comes before the release becomes latest');
  rmSync(join(l.dir, 'legion-update-manifest-2.json.sig'));
  const bad = run(l.dir); assert.notEqual(bad.code, 0); assert.match(bad.out, /legion-update-manifest-2\.json\.sig/);
});
test('publish: refuses to create the draft when the old name is not the signed stone (same checks as preflight)', () => {
  const t = trustFixture(); const sd = stone(t); const l = later('0.3.2', sd);
  assert.equal(sh('release-sign.mjs', '--key', t.key, '--manifest', join(l.dir, 'legion-update-manifest-2.json'), '--trust-module', t.trust).code, 0);
  for (const f of ['SHA256SUMS.txt.sig', 'install.ps1', 'install.sh', 'legion-0.3.2-win-x64.zip']) writeFileSync(join(l.dir, f), 'x');
  copyFileSync(join(l.dir, 'legion-update-manifest-2.json'), join(l.dir, 'legion-update-manifest.json'));
  copyFileSync(join(l.dir, 'legion-update-manifest-2.json.sig'), join(l.dir, 'legion-update-manifest.json.sig'));
  const r = sh('release-publish.mjs', '--dir', l.dir, '--version', '0.3.2', '--notes-file', join(l.dir, 'notes.txt'), '--trust-module', t.trust, '--no-network', '--dry-run');
  assert.notEqual(r.code, 0); assert.match(r.out, /stepping stone/i); assert.ok(!/gh release create/.test(r.out), 'no draft is created');
});
test('stone: SHIPPING.md lists every stepping stone and says they are never deleted', () => {
  const stones = (readJ(join(REPO, 'scripts', 'stepping-stones.json')).stones) as string[];
  const doc = readFileSync(join(REPO, 'docs', 'SHIPPING.md'), 'utf8');
  assert.ok(stones.length > 0);
  for (const v of stones) assert.ok(doc.includes(`v${v}`), `SHIPPING.md must list v${v}`);
  assert.match(doc, /never delete a stepping-stone release, tag or asset/i);
});
