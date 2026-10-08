/** C8, C9, C10, C20 (staging part): hash before extraction, hostile zips, package content, disk and broken downloads. Loopback server, temp dirs. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseManifest } from '../src/core/updater/manifest.js';
import { stagePackage, stageFullPackage, stagedTree, stagedInfo, StageError, dependencyHash } from '../src/core/updater/package.js';
import { assetNameFor, fullAssetNameFor } from '../src/core/updater/config.js';
import { LOCK, makeKey, makeRelease, makeZip, fullPackageFiles, packageFiles, sha256, startFakeServer, type Release, type ZipFile } from './updater-helpers.js';

const k = makeKey();
const V = '0.2.1';
const free = () => 10 ** 12;

async function run(r: Release, o: { installedDeps?: string | undefined; installedLock?: string | undefined; freeBytes?: () => number; manifestPatch?: Record<string, unknown>; serve?: Buffer } = {}) {
  const s = await startFakeServer(r);
  if (o.serve) { const orig = s.handler; s.handler.custom = (req, res) => { if (req.url?.includes('/releases/download/')) { res.writeHead(200, { 'content-length': o.serve!.length }); res.end(o.serve); return true; } void orig; return false; }; }
  const install = cleanupTemp('upd-pkg-');
  mkdirSync(join(install, 'dist'), { recursive: true }); writeFileSync(join(install, 'dist', 'keep.js'), 'live');
  const m = parseManifest(Buffer.from(JSON.stringify({ ...r.manifestObj, ...(o.manifestPatch ?? {}) })));
  try {
    const out = await stagePackage({ installDir: install, source: s.source, manifest: m, version: V, installedDepsHash: 'installedDeps' in o ? o.installedDeps : dependencyHash(LOCK), freeBytes: o.freeBytes ?? free });
    return { out, err: undefined as unknown, install, s };
  } catch (err) { return { out: undefined, err, install, s }; }
  finally { await s.close(); }
}
const code = (e: unknown): string => (e instanceof StageError ? e.code : `other:${(e as Error)?.message}`);
const liveUntouched = (install: string) => assert.equal(readFileSync(join(install, 'dist', 'keep.js'), 'utf8'), 'live');
const noStaging = (install: string) => assert.equal(existsSync(join(install, '.update', 'staging', V)), false, 'staging removed after a failure');

test('a good package is downloaded, hashed, extracted and checked; stage.json is written last', async () => {
  const r = makeRelease(k, V);
  const { out, err, install } = await run(r);
  assert.equal(err, undefined);
  assert.equal(out!.zipSha256, sha256(r.zip));
  assert.equal(readFileSync(join(out!.treeDir, 'dist/src/bin/legion-core.js'), 'utf8'), '// core');
  assert.equal(stagedTree(install, V), out!.treeDir);
  liveUntouched(install);
});

test('C8: the sha256 is compared BEFORE extraction (a hostile zip with a wrong hash fails as "hash", never reaches the zip reader)', async () => {
  const wrong = makeRelease(k, V);
  const same = Buffer.from(wrong.zip); same[same.length - 30] ^= 0xff; // same size, different bytes
  const res = await run(wrong, { serve: same });
  assert.equal(code(res.err), 'hash');
  noStaging(res.install); liveUntouched(res.install);
  // a signed size that differs from what is served is a size error, before the hash
  const res2 = await run(wrong, { manifestPatch: { asset: { name: assetNameFor(V), size: wrong.zip.length + 5, sha256: sha256(wrong.zip) } } });
  assert.equal(res2.err instanceof Error, true);
  noStaging(res2.install);
});

const hostile: Array<[string, ZipFile[]]> = [
  ['parent traversal', [...packageFiles(V), { name: `legion-${V}/../../evil.txt`, data: 'x' }]],
  ['absolute path', [...packageFiles(V), { name: '/etc/evil', data: 'x' }]],
  ['drive letter', [...packageFiles(V), { name: 'C:/evil.txt', data: 'x' }]],
  ['backslash traversal', [...packageFiles(V), { name: `legion-${V}\\..\\..\\evil.txt`, data: 'x' }]],
  ['alternate data stream', [...packageFiles(V), { name: `legion-${V}/dist/a.js:evil`, data: 'x' }]],
  ['symlink entry', [...packageFiles(V), { name: `legion-${V}/dist/link`, data: '/etc', symlink: true }]],
  ['outside the top folder', [...packageFiles(V), { name: 'other-folder/x.txt', data: 'x' }]],
  ['case-duplicate', [...packageFiles(V), { name: `legion-${V}/DIST/src/bin/LEGION-CORE.JS`, data: 'x' }]],
  ['device name', [...packageFiles(V), { name: `legion-${V}/dist/nul.js`, data: 'x' }]],
  ['trailing dot', [...packageFiles(V), { name: `legion-${V}/dist/evil.`, data: 'x' }]],
];
for (const [name, files] of hostile) {
  test(`C9: ${name} is refused, nothing is installed, nothing is written outside staging`, async () => {
    const { err, install } = await run(makeRelease(k, V, { files }));
    assert.ok(err instanceof StageError, String(err));
    assert.equal((err as StageError).code, 'zip');
    noStaging(install); liveUntouched(install);
    assert.equal(existsSync(join(install, '..', 'evil.txt')), false);
    assert.equal(existsSync(join(install, 'evil.txt')), false);
  });
}
test('C9: names outside the code set (node_modules, .git, src, a dotfile) and overlong paths are refused', async () => {
  for (const extra of [`legion-${V}/node_modules/x/index.js`, `legion-${V}/.git/config`, `legion-${V}/src/a.ts`, `legion-${V}/uninstall.cmd`, `legion-${V}/.update/journal.json`]) {
    const { err, install } = await run(makeRelease(k, V, { files: packageFiles(V, { extra: [{ name: extra, data: 'x' }] }) }));
    assert.equal(code(err), 'content', extra);
    noStaging(install); liveUntouched(install);
  }
  const long = `legion-${V}/dist/${'a'.repeat(120)}/${'b'.repeat(120)}.js`;
  assert.equal(code((await run(makeRelease(k, V, { files: packageFiles(V, { extra: [{ name: long, data: 'x' }] }) }))).err), 'content');
});

test('C10: package.json version, lock hash, missing files and requiresFullInstall', async () => {
  assert.equal(code((await run(makeRelease(k, V, { files: packageFiles(V, { pkgVersion: '9.9.9' }) }))).err), 'content');
  const lockChanged = makeRelease(k, V, { lock: '{"changed":true}' });
  assert.equal(code((await run(lockChanged, { installedDeps: dependencyHash(LOCK) })).err), 'full-install', 'the installed dependencies differ: notify only');
  assert.equal(code((await run(makeRelease(k, V), { installedDeps: undefined })).err), 'full-install', 'unreadable installed lock counts as different');
  assert.equal(code((await run(makeRelease(k, V, { requiresFullInstall: true }))).err), 'full-install');
  assert.equal(code((await run(makeRelease(k, V, { manifest: { depsSha256: 'b'.repeat(64) } }))).err), 'content', 'package lock differs from the signed one');
  assert.equal(code((await run(makeRelease(k, V, { files: packageFiles(V, { drop: ['dist/src/bin/legion-core.js'] }) }))).err), 'content');
});

// The owner's question on 2026-10-03 ("is this a dependency change though?"): bumping the release version rewrites the
// `version` field inside package-lock.json, so the RAW lock hash changes on every single release. Comparing raw hashes made
// every patch require a full install, which is why self-update never worked. Only the dependency CONTENT must decide.
test('C10b: a lock that differs ONLY in its own version still self-applies; a real dependency change does not', async () => {
  // Both locks carry the same packages map; only the version the lock records for ITSELF differs. That is exactly what npm
  // rewrites on every release bump, and it must not read as a dependency change.
  const base = { name: 'legion', lockfileVersion: 3, version: '0.2.1', packages: { '': { name: 'legion', version: '0.2.1' }, 'node_modules/x': { version: '1.2.3' } } };
  const sameVersion = JSON.stringify(base);
  const bumpedOnly = JSON.stringify({ ...base, version: '0.2.2-a', packages: { '': { name: 'legion', version: '0.2.2-a' }, 'node_modules/x': { version: '1.2.3' } } });
  assert.notEqual(sha256(sameVersion), sha256(bumpedOnly), 'raw hashes differ, so the naive check would have failed');
  assert.equal(dependencyHash(sameVersion), dependencyHash(bumpedOnly), 'the DEPENDENCY hash ignores the version the lock carries for itself, so a version bump self-applies');
  const realChange = JSON.stringify({ ...base, packages: { ...base.packages, 'node_modules/new-dep': { version: '1.0.0' } } });
  assert.notEqual(dependencyHash(sameVersion), dependencyHash(realChange), 'a real dependency change is still detected');
  const depVersionChange = JSON.stringify({ ...base, packages: { ...base.packages, 'node_modules/x': { version: '9.9.9' } } });
  assert.notEqual(dependencyHash(sameVersion), dependencyHash(depVersionChange), 'bumping a DEPENDENCY version is still a dependency change');
  // And end to end: the release whose lock matches the installed dependencies, but whose lock version differs, must stage.
  const res = await run(makeRelease(k, V, { lock: bumpedOnly }), { installedDeps: dependencyHash(sameVersion) });
  assert.equal(res.err, undefined, 'a version-only lock difference must NOT force a full install');
});

test('C20: not enough free space is refused before any request; a connection that breaks mid-download leaves nothing', async () => {
  const r = makeRelease(k, V);
  const s = await startFakeServer(r);
  const install = cleanupTemp('upd-pkg-');
  try {
    const m = parseManifest(r.manifest);
    await assert.rejects(stagePackage({ installDir: install, source: s.source, manifest: m, version: V, installedDepsHash: dependencyHash(LOCK), freeBytes: () => 10 }), (e) => e instanceof StageError && e.code === 'disk');
    assert.equal(s.hits.filter((h) => h.includes('/releases/download/')).length, 0, 'no download was started');
    s.handler.custom = (req, res) => { if (req.url?.includes('/releases/download/')) { res.writeHead(200, { 'content-length': r.zip.length }); res.write(r.zip.subarray(0, 100)); setTimeout(() => res.destroy(), 20); return true; } return false; };
    await assert.rejects(stagePackage({ installDir: install, source: s.source, manifest: m, version: V, installedDepsHash: dependencyHash(LOCK), freeBytes: free }), (e) => e instanceof StageError && e.code === 'net');
    assert.equal(existsSync(join(install, '.update', 'staging', V)), false);
    assert.equal(stagedTree(install, V), null);
  } finally { await s.close(); }
});
test('C9: a staging folder that is a link is refused', async () => {
  const r = makeRelease(k, V);
  const s = await startFakeServer(r);
  const install = cleanupTemp('upd-pkg-');
  const elsewhere = cleanupTemp('upd-else-');
  try {
    mkdirSync(join(install, '.update'), { recursive: true });
    try { symlinkSync(elsewhere, join(install, '.update', 'staging'), 'dir'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') return; throw e; }
    await assert.rejects(stagePackage({ installDir: install, source: s.source, manifest: parseManifest(r.manifest), version: V, installedDepsHash: dependencyHash(LOCK), freeBytes: free }), (e) => e instanceof StageError && e.code === 'unsafe');
    assert.deepEqual(readdirSync(elsewhere), []);
  } finally { await s.close(); }
});

// The dependency-change bridge: stageFullPackage downloads and verifies the SIGNED full package (node_modules + runtime)
// instead of the code-only app package. These pin the routing-critical parts: the right asset, its signed hash, and the
// node_modules/runtime that are the whole point of a full update.
async function runFull(r: Release, o: { freeBytes?: () => number; serve?: Buffer } = {}) {
  const s = await startFakeServer(r);
  if (o.serve) { s.handler.custom = (req, res) => { if (req.url?.includes('/releases/download/')) { res.writeHead(200, { 'content-length': o.serve!.length }); res.end(o.serve); return true; } return false; }; }
  const install = cleanupTemp('upd-full-');
  const m = parseManifest(r.manifest);
  try {
    const out = await stageFullPackage({ installDir: install, source: s.source, manifest: m, version: V, freeBytes: o.freeBytes ?? free });
    return { out, err: undefined as unknown, install, s };
  } catch (err) { return { out: undefined, err, install, s }; }
  finally { await s.close(); }
}
const withoutTop = (prefix: string): ZipFile[] => fullPackageFiles(V).filter((f) => !f.name.startsWith(`legion-${V}/${prefix}/`));

test('C25: a good full package is downloaded, hashed, extracted and checked; node_modules and runtime are present; kind is full', async () => {
  const r = makeRelease(k, V, { requiresFullInstall: true, full: {} });
  assert.equal(r.manifestObj.fullAsset && (r.manifestObj.fullAsset as { name: string }).name, fullAssetNameFor(V));
  const { out, err, install } = await runFull(r);
  assert.equal(err, undefined, String(err));
  assert.equal(out!.kind, 'full');
  assert.equal(out!.zipSha256, sha256(r.fullZip!));
  assert.ok(existsSync(join(out!.treeDir, 'node_modules', 'electron', 'index.js')));
  assert.ok(existsSync(join(out!.treeDir, 'runtime', 'electron', 'electron.exe')));
  assert.ok(existsSync(join(out!.treeDir, 'PACKAGE-FILES.json')));
  assert.deepEqual(stagedInfo(install, V), { treeDir: out!.treeDir, kind: 'full' });
  assert.equal(stagedTree(install, V), out!.treeDir);
});

test('C25: the full package is verified against its SIGNED sha256 BEFORE extraction; on mismatch nothing is staged', async () => {
  const r = makeRelease(k, V, { requiresFullInstall: true, full: {} });
  const same = Buffer.from(r.fullZip!); same[same.length - 30] ^= 0xff; // same size, different bytes
  const res = await runFull(r, { serve: same });
  assert.equal(code(res.err), 'hash');
  assert.equal(existsSync(join(res.install, '.update', 'staging', V)), false, 'staging removed');
  assert.equal(stagedInfo(res.install, V), null);
});

test('C25: a full package missing node_modules, runtime or its executable list is refused as content', async () => {
  const missingNodeModules = makeRelease(k, V, { requiresFullInstall: true, full: { files: withoutTop('node_modules') } });
  assert.equal(code((await runFull(missingNodeModules)).err), 'content');
  const missingRuntime = makeRelease(k, V, { requiresFullInstall: true, full: { files: withoutTop('runtime') } });
  assert.equal(code((await runFull(missingRuntime)).err), 'content');
  const badList = makeRelease(k, V, { requiresFullInstall: true, full: { files: fullPackageFiles(V).map((f) => (f.name.endsWith('PACKAGE-FILES.json') ? { ...f, data: JSON.stringify({ schema: 1, files: [{ path: 'dist/x', size: 1, sha256: '0'.repeat(64) }] }) } : f)) } });
  assert.equal(code((await runFull(badList)).err), 'content', 'the file list must name the bundled executables');
});

test('C25: a full package whose own package-lock differs from the signed depsSha256 is refused', async () => {
  // The whole zip is signed over its own bytes, so the download hash matches; the content check refuses the lock mismatch.
  const r = makeRelease(k, V, { requiresFullInstall: true, full: { files: fullPackageFiles(V, { lock: '{"other":1}' }) } });
  assert.equal(code((await runFull(r)).err), 'content');
});
