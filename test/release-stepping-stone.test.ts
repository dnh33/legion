/**
 * The stepping stone, release side (docs/SHIPPING.md, Stepping stones): two manifest names, the old name of a full-install release is a signed
 * stepping stone copied byte for byte, preflight/verify refuse anything else, and the daily check notices a stone whose package vanished.
 * The client side is in updater-module.test.ts. Everything here is offline with throwaway keys.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeZip } from './updater-helpers.js';

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
  assert.equal(sh('release-manifest.mjs', '--zip', join(d, `legion-${version}-app.zip`), '--notes', join(d, 'notes.txt'), '--out', d).code, 0);
  assert.equal(sh('release-sign.mjs', '--key', t.key, '--manifest', join(d, 'legion-update-manifest-2.json'), '--trust-module', t.trust).code, 0);
  return d;
}
const full = (version: string, stoneDir?: string): string => {
  const d = pkg(version, true);
  const r = sh('release-manifest.mjs', '--zip', join(d, `legion-${version}-app.zip`), '--full-zip', join(d, `legion-${version}-win-x64.zip`), '--requires-full-install', '--notes', join(d, 'notes.txt'), '--out', d, ...(stoneDir ? ['--stepping-stone', stoneDir] : []));
  assert.equal(r.code, 0, r.out);
  return d;
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
  const bare = full('0.5.1');
  assert.equal(sh('release-sign.mjs', '--key', t.key, '--manifest', join(bare, 'legion-update-manifest-2.json'), '--trust-module', t.trust).code, 0);
  const bad = sh('release-verify.mjs', '--dir', bare, '--trust-module', t.trust, '--no-network');
  assert.notEqual(bad.code, 0); assert.match(bad.out, /stepping stone/i);
});

test('stone: --stepping-stone is refused for a code-only release and for a stone that is not older', () => {
  const t = trustFixture(); const sd = stone(t, '0.6.0');
  const d = pkg('0.5.0', true);
  const r = sh('release-manifest.mjs', '--zip', join(d, 'legion-0.5.0-app.zip'), '--full-zip', join(d, 'legion-0.5.0-win-x64.zip'), '--requires-full-install', '--out', d, '--stepping-stone', sd);
  assert.notEqual(r.code, 0); assert.match(r.out, /not older/);
  const c = pkg('0.7.0', false);
  const r2 = sh('release-manifest.mjs', '--zip', join(c, 'legion-0.7.0-app.zip'), '--out', c, '--stepping-stone', sd);
  assert.notEqual(r2.code, 0); assert.match(r2.out, /full-install/);
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
  assert.match((await L.stoneProblems({ ...base, stones: ['0.1.0'] })).join(), /not listed/);
  assert.match((await L.stoneProblems({ ...base, oldBytes: p.newB })).join(), /itself a full-install|same manifest/);
});
test('stone rules: the daily check fails loudly when the live old-name manifest or the stone package is gone', async () => {
  const { L, parseManifest, trust } = await lib(); const p = pair();
  const ok = (bytes: Buffer) => ({ status: 200, bytes });
  const files = (over: Record<string, { status: number; bytes: Buffer }> = {}) => async (url: string) => over[url.split('/').pop()!] ?? (url.endsWith('manifest-2.json') ? ok(p.newB) : url.endsWith('.sig') ? ok(Buffer.from('s')) : ok(p.oldB));
  const run = (getBytes: (u: string) => Promise<{ status: number; bytes: Buffer }>, asset: { size: number; sha256: string } | Error) => L.liveProblems({ getBytes, fetchAsset: async () => { if (asset instanceof Error) throw asset; return asset; }, trust, parseManifest });
  assert.deepEqual(await run(files(), p.asset), []);
  assert.match((await run(files({ 'legion-update-manifest.json': { status: 404, bytes: Buffer.alloc(0) } }), p.asset)).join(), /stranded/);
  assert.match((await run(files(), new Error('HTTP 404'))).join(), /not reachable/);
  assert.match((await run(files(), { ...p.asset, sha256: 'b'.repeat(64) })).join(), /returns sha256/);
});
test('stone: SHIPPING.md lists every stepping stone and says they are never deleted', () => {
  const stones = (readJ(join(REPO, 'scripts', 'stepping-stones.json')).stones) as string[];
  const doc = readFileSync(join(REPO, 'docs', 'SHIPPING.md'), 'utf8');
  assert.ok(stones.length > 0);
  for (const v of stones) assert.ok(doc.includes(`v${v}`), `SHIPPING.md must list v${v}`);
  assert.match(doc, /never delete a stepping-stone release, tag or asset/i);
});
