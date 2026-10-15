/**
 * Option A (docs/SHIPPING.md, Stepping stones): while a stone-era install can still hold the 0.3.0 lock, a code-only release carries its own
 * full package (fullAsset) so the FROZEN 0.3.0 updater can fall back to it. These tests cover the release side: release-manifest --carry-full,
 * the shared full-asset rule, preflight/verify, the live fullAsset fetch and the gate that parses the manifest with the frozen parser.
 * Offline, throwaway keys.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './tmp-cleanup.js';

process.env.LEGION_REHEARSAL = '1'; // the rehearsal-only skip flags (see release-rehearsal-gate.test.ts)
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const run = (script: string, argv: string[]) => spawnSync(process.execPath, [join(REPO, 'scripts', script), ...argv], { encoding: 'utf8' });
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
type Fn = (o: unknown) => unknown;
const lib = async (n: string) => import(pathToFileURL(join(REPO, 'scripts', 'lib', n)).href) as Promise<Record<string, Fn>>;
const V = '0.9.4';
const lockOf = (dep: string) => JSON.stringify({ name: 'legion', lockfileVersion: 3, packages: { '': { name: 'legion' }, 'node_modules/x': { version: dep } } }) + '\n';
const STONE_LOCK = lockOf('1.0.0');
const NEW_LOCK = lockOf('1.1.0');

function pkgTree(version: string, lock: string): string {
  const r = tempDir('sc-tree-');
  const put = (p: string, c: string) => { const f = join(r, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, c); };
  put('package.json', JSON.stringify({ name: 'legion', version })); put('package-lock.json', lock);
  put('dist/src/electron/main.js', 'm'); put('dist/src/bin/legion-core.js', 'c'); put('dist-ui/index.html', '<html>');
  return r;
}
function trustModule(pubPem: string): string {
  const f = join(tempDir('sc-trust-'), 'trust.mjs');
  writeFileSync(f, `import { verifyManifestSignature as v } from ${JSON.stringify(new URL('../src/core/updater/trust.js', import.meta.url).href)};\nexport const UPDATE_KEYS = [{ id: 'k1', publicKeyPem: ${JSON.stringify(pubPem)} }];\nexport const verifyManifestSignature = (m, s, k) => v(m, s, k);\n`);
  return f;
}

interface Rel { dir: string; tm: string; stoneLock: string; full: string; manifest: string }
/** A signed release folder for version V (not a stone) whose lock is `lock`; `shape`: 'carry' = --carry-full, 'code' = plain code-only. */
function release(lock: string, shape: 'carry' | 'code', stoneLockText = STONE_LOCK): Rel {
  const out = tempDir('sc-rel-'); const keys = tempDir('sc-keys-');
  assert.equal(run('release-package.mjs', ['--root', pkgTree(V, lock), '--out', out, '--published-at', '2026-10-20T10:00:00Z']).status, 0);
  const full = join(out, `legion-${V}-win-x64.zip`); writeFileSync(full, 'the full package bytes');
  assert.equal(run('release-keygen.mjs', ['--out', keys]).status, 0);
  const tm = trustModule(readFileSync(join(keys, 'legion-update-k1.pub.pem'), 'utf8'));
  const key = join(keys, 'legion-update-k1.key.pem');
  const sd = tempDir('sc-stone-');
  assert.equal(run('release-package.mjs', ['--root', pkgTree('0.3.0', STONE_LOCK), '--out', sd, '--published-at', '2026-10-19T10:00:00Z']).status, 0);
  assert.equal(run('release-manifest.mjs', ['--zip', join(sd, 'legion-0.3.0-app.zip'), '--out', sd]).status, 0);
  assert.equal(run('release-sign.mjs', ['--key', key, '--manifest', join(sd, 'legion-update-manifest-2.json'), '--trust-module', tm]).status, 0);
  const m = ['--zip', join(out, `legion-${V}-app.zip`), '--out', out, '--stepping-stone', sd];
  if (shape === 'carry') m.push('--full-zip', full, '--carry-full');
  const mk = run('release-manifest.mjs', m); assert.equal(mk.status, 0, mk.stderr);
  const s = run('release-sign.mjs', ['--key', key, '--manifest', join(out, 'legion-update-manifest-2.json'), '--trust-module', tm]);
  assert.equal(s.status, 0, s.stderr);
  const sl = join(tempDir('sc-stonelock-'), 'package-lock.json'); writeFileSync(sl, stoneLockText);
  return { dir: out, tm, stoneLock: sl, full, manifest: join(out, 'legion-update-manifest-2.json') };
}
const verify = (r: Rel) => run('release-verify.mjs', ['--dir', r.dir, '--trust-module', r.tm, '--no-network', '--stones', '0.3.0', '--stone-lock', r.stoneLock]);
const preflight = (r: Rel) => run('release-preflight.mjs', ['--version', V, '--pkg', r.dir, '--no-network', '--stones', '0.3.0', '--stone-lock', r.stoneLock]);
const readManifest = (r: Rel) => JSON.parse(readFileSync(r.manifest, 'utf8')) as Record<string, unknown>;

// ------------------------------------------------------------ release-manifest --carry-full
test('manifest: --carry-full writes requiresFullInstall:false plus the fullAsset of the zip in the folder, and no minUpdater or steppingStone', () => {
  const r = release(NEW_LOCK, 'carry');
  const m = readManifest(r);
  assert.equal(m.requiresFullInstall, false);
  assert.deepEqual(m.fullAsset, { name: `legion-${V}-win-x64.zip`, size: Buffer.byteLength('the full package bytes'), sha256: sha('the full package bytes') });
  assert.equal(m.minUpdater, undefined); assert.equal(m.steppingStone, undefined);
  assert.match(readFileSync(join(r.dir, 'SHA256SUMS.txt'), 'utf8'), new RegExp(`${sha('the full package bytes')}  legion-${V}-win-x64.zip`));
});

test('manifest: --full-zip without --carry-full and without --requires-full-install still warns (the old rule)', () => {
  const out = tempDir('sc-w-');
  run('release-package.mjs', ['--root', pkgTree(V, NEW_LOCK), '--out', out, '--published-at', '2026-10-20T10:00:00Z']);
  const full = join(out, `legion-${V}-win-x64.zip`); writeFileSync(full, 'x');
  const r = run('release-manifest.mjs', ['--zip', join(out, `legion-${V}-app.zip`), '--out', out, '--full-zip', full, '--stones', V]);
  assert.match(r.stderr, /warning/i);
  const c = run('release-manifest.mjs', ['--zip', join(out, `legion-${V}-app.zip`), '--out', out, '--full-zip', full, '--carry-full', '--stones', V]);
  assert.equal(c.status, 0, c.stderr); assert.doesNotMatch(c.stderr, /warning/i);
});

test('manifest: --carry-full needs --full-zip and contradicts --requires-full-install and --notify-only', () => {
  const out = tempDir('sc-n-');
  run('release-package.mjs', ['--root', pkgTree(V, NEW_LOCK), '--out', out, '--published-at', '2026-10-20T10:00:00Z']);
  const full = join(out, `legion-${V}-win-x64.zip`); writeFileSync(full, 'x');
  const base = ['--zip', join(out, `legion-${V}-app.zip`), '--out', out, '--stones', V];
  assert.notEqual(run('release-manifest.mjs', [...base, '--carry-full']).status, 0);
  assert.notEqual(run('release-manifest.mjs', [...base, '--full-zip', full, '--carry-full', '--requires-full-install']).status, 0);
  assert.notEqual(run('release-manifest.mjs', [...base, '--full-zip', full, '--carry-full', '--notify-only']).status, 0);
});

// ------------------------------------------------------------ verify and preflight
test('verify: a code-only release whose lock differs from the stone lock and carries the exact full zip passes', () => {
  const v = verify(release(NEW_LOCK, 'carry')); assert.equal(v.status, 0, v.stdout + v.stderr);
});

test('verify: a code-only release whose lock equals the stone lock, without fullAsset, passes (the code route serves everyone)', () => {
  const v = verify(release(STONE_LOCK, 'code')); assert.equal(v.status, 0, v.stdout + v.stderr);
});

test('verify: lock differs from the stone but no fullAsset is refused, naming the stranded 0.3.0 installs', () => {
  const v = verify(release(NEW_LOCK, 'code'));
  assert.notEqual(v.status, 0);
  assert.match(v.stderr, /0\.3\.0/); assert.match(v.stderr, /strand/i); assert.match(v.stderr, /fullAsset/);
});

test('verify: a fullAsset on a release whose lock equals the stone lock is refused (stray)', () => {
  const v = verify(release(STONE_LOCK, 'carry')); assert.notEqual(v.status, 0); assert.match(v.stderr, /fullAsset/);
});

test('verify: a carried fullAsset must equal the zip in the folder and be listed in SHA256SUMS.txt', () => {
  const r = release(NEW_LOCK, 'carry'); writeFileSync(r.full, 'changed after the manifest was made');
  const v = verify(r); assert.notEqual(v.status, 0); assert.match(v.stderr, /full package/i);
  const r2 = release(NEW_LOCK, 'carry'); const p = join(r2.dir, 'SHA256SUMS.txt');
  writeFileSync(p, readFileSync(p, 'utf8').split('\n').filter((l) => !l.endsWith('-win-x64.zip')).join('\n'));
  const v2 = verify(r2); assert.notEqual(v2.status, 0); assert.match(v2.stderr, /SHA256SUMS/);
});

test('verify: a stone lock that is not the one the stone manifest was signed over is refused (a wrong lock file cannot decide)', () => {
  const r = release(NEW_LOCK, 'code', lockOf('9.9.9'));
  const v = verify(r); assert.notEqual(v.status, 0); assert.match(v.stderr, /stone/i); assert.match(v.stderr, /lock/i);
});

test('preflight: carry-full passes as a full package; a missing fullAsset is a FAIL naming the stranded installs', () => {
  const good = preflight(release(NEW_LOCK, 'carry'));
  assert.doesNotMatch(good.stderr, /FAIL[^\n]*(fullAsset|strand|stone lock)/i, good.stderr);
  assert.match(good.stdout, /full package/i);
  const bad = preflight(release(NEW_LOCK, 'code'));
  assert.match(bad.stderr, /FAIL[^\n]*fullAsset/i); assert.match(bad.stderr, /0\.3\.0/);
});

// ------------------------------------------------------------ the pure rule
test('lockDiffersFromStone: by dependency content, fail closed on a missing or garbage stone lock', async () => {
  const { lockDiffersFromStone } = await lib('stone-carry.mjs');
  const { dependencyHash } = await import(pathToFileURL(join(REPO, 'dist/src/core/updater/package.js')).href) as { dependencyHash: (s: string) => string };
  const call = (rel: string, st: string | null) => lockDiffersFromStone({ releaseLock: rel, stoneLock: st, dependencyHash }) as boolean;
  assert.equal(call(lockOf('1.0.0'), lockOf('1.0.0')), false);
  assert.equal(call(lockOf('1.1.0'), lockOf('1.0.0')), true);
  assert.equal(call(lockOf('1.0.0'), null), true);
  assert.equal(call(lockOf('1.0.0'), 'not json'), true);
});

// ------------------------------------------------------------ live fullAsset
test('live fullAsset: the URL must return the signed size and sha256; a 404, a wrong size or a wrong hash is a problem; no fullAsset is nothing to check', async () => {
  const { liveFullAssetProblems } = await lib('stone-carry.mjs');
  const fa = { name: `legion-${V}-win-x64.zip`, size: 5, sha256: sha('hello') };
  const call = (manifest: object, fetchAsset: (u: string) => Promise<{ size: number; sha256: string }>) =>
    liveFullAssetProblems({ manifest: { version: V, fullAsset: fa, ...manifest }, base: 'https://example.test/r', fetchAsset }) as Promise<string[]>;
  const seen: string[] = [];
  assert.deepEqual(await call({}, async (u) => { seen.push(u); return { size: 5, sha256: sha('hello') }; }), []);
  assert.deepEqual(seen, [`https://example.test/r/releases/download/v${V}/legion-${V}-win-x64.zip`]);
  assert.match((await call({}, async () => ({ size: 6, sha256: sha('hello') })))[0], /size/i);
  assert.match((await call({}, async () => ({ size: 5, sha256: sha('hellp') })))[0], /sha256/i);
  assert.match((await call({}, async () => { throw new Error('HTTP 404'); }))[0], /404/);
  assert.deepEqual(await call({ fullAsset: undefined }, async () => { throw new Error('must not be called'); }), []);
});

// ------------------------------------------------------------ the frozen parser gate
const manifestOf = (over: Record<string, unknown>) => Buffer.from(JSON.stringify({
  schema: 1, product: 'legion', channel: 'stable', version: V, publishedAt: '2026-10-20T10:00:00Z',
  asset: { name: `legion-${V}-app.zip`, size: 10, sha256: sha('a') }, depsSha256: sha('b'), requiresFullInstall: false, notes: 'n', ...over,
}));
const currentSources = () => Object.fromEntries(['manifest', 'config', 'semver'].map((n) => [`${n}.ts`, readFileSync(join(REPO, 'src/core/updater', `${n}.ts`), 'utf8')]));
const gate = async (o: object) => (await lib('frozen-parser.mjs')).frozenParserProblems({ label: 'v0.3.0', ...o }) as Promise<string[]>;

test('frozen parser gate: a code-only manifest with its own fullAsset is accepted by the frozen and the current parser', async () => {
  const m = manifestOf({ fullAsset: { name: `legion-${V}-win-x64.zip`, size: 100, sha256: sha('c') } });
  assert.deepEqual(await gate({ manifestBytes: m, sources: currentSources() }), []);
});

test('frozen parser gate: Option C (a fullAsset named for another version) is refused, naming the parser', async () => {
  const m = manifestOf({ fullAsset: { name: 'legion-0.3.0-win-x64.zip', size: 100, sha256: sha('c') } });
  const p = await gate({ manifestBytes: m, sources: currentSources() });
  assert.ok(p.length >= 1); assert.match(p.join(' '), /v0\.3\.0/);
});

test('frozen parser gate: sources that are missing fail closed', async () => {
  const p = await gate({ manifestBytes: manifestOf({}), sources: undefined });
  assert.match(p.join(' '), /could not load/i);
});

test('frozen parser gate: the real v0.3.0 tag parses a carry-full manifest (skipped when the tag is not in this checkout)', async (t) => {
  try { execFileSync('git', ['-C', REPO, 'cat-file', '-e', 'v0.3.0:src/core/updater/manifest.ts'], { stdio: 'ignore' }); } catch { t.skip('no v0.3.0 tag here'); return; }
  const { sourcesFromGit } = await lib('frozen-parser.mjs');
  const sources = sourcesFromGit({ tag: 'v0.3.0', repo: REPO });
  const m = manifestOf({ fullAsset: { name: `legion-${V}-win-x64.zip`, size: 100, sha256: sha('c') } });
  assert.deepEqual(await gate({ manifestBytes: m, sources }), []);
  const bad = manifestOf({ fullAsset: { name: 'legion-0.3.0-win-x64.zip', size: 100, sha256: sha('c') } });
  assert.ok((await gate({ manifestBytes: bad, sources })).length >= 1);
});

// ------------------------------------------------------------ wiring that only runs on CI
const yml = (n: string) => readFileSync(join(REPO, '.github', 'workflows', n), 'utf8').replace(/\r\n/g, '\n');
test('release-build.yml passes the stone lock, builds with --carry-full, and gates fullAsset on requires OR carry', () => {
  const y = yml('release-build.yml');
  assert.match(y, /--stone-lock/); assert.match(y, /--carry-full/);
  assert.match(y, /CARRY: \$\{\{ steps\.deps\.outputs\.carry \}\}/);
  assert.match(y, /\$wantFull = \(\$env:REQUIRES -eq 'true'\) -or \(\$env:CARRY -eq 'true'\)/);
  assert.doesNotMatch(y, /dependencies did not change but the manifest carries a fullAsset/, 'the old exactly-when-requires gate is gone');
  assert.match(y, /Code-only release carries its full package/, 'a step-summary line says whether the release carries it');
});

test('full-install-rehearsal.yml runs the stone-stranded scenarios from 0.2.7 and watches the new libs', () => {
  const y = yml('full-install-rehearsal.yml');
  assert.match(y, /stone-stranded, stone-stranded-nofull\]/);
  assert.match(y, /'stone-stranded', 'stone-stranded-nofull'\) \{ \$base = '0\.2\.7' \}/);
  assert.match(y, /scripts\/lib\/stone-carry\.mjs/); assert.match(y, /scripts\/lib\/frozen-parser\.mjs/);
});

// ------------------------------------------------------------ release-verify --published (post-publish flow)
// The documented flow fetches only the small files (manifest, sig, app.zip, SHA256SUMS) into a fresh folder: the 285 MB zip is compared live, not in the folder.
async function verifyPublished(r: Rel, served: Buffer | null): Promise<{ status: number | null; stdout: string; stderr: string; hits: string[] }> {
  const hits: string[] = [];
  const srv = createServer((req, res) => { hits.push(req.url ?? ''); if (served && (req.url ?? '').endsWith(`/legion-${V}-win-x64.zip`)) { res.writeHead(200); res.end(served); } else { res.writeHead(404); res.end('no'); } });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    return await new Promise((ok) => {
      const c = spawn(process.execPath, [join(REPO, 'scripts', 'release-verify.mjs'), '--dir', r.dir, '--trust-module', r.tm, '--no-network', '--stones', '0.3.0', '--stone-lock', r.stoneLock, '--published', '--base', base], { env: process.env });
      let stdout = '', stderr = '';
      c.stdout.on('data', (d: Buffer) => { stdout += d; }); c.stderr.on('data', (d: Buffer) => { stderr += d; });
      c.on('close', (status: number | null) => ok({ status, stdout, stderr, hits }));
    });
  } finally { srv.close(); }
}

test('verify --published: works with only the small files; the live fullAsset size and sha256 are compared with the signed manifest', async () => {
  const r = release(NEW_LOCK, 'carry'); unlinkSync(r.full);
  const ok = await verifyPublished(r, Buffer.from('the full package bytes'));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.deepEqual(ok.hits, [`/releases/download/v${V}/legion-${V}-win-x64.zip`], 'the live zip was fetched exactly once');
  const wrong = await verifyPublished(release(NEW_LOCK, 'carry'), Buffer.from('some other bytes here!'));
  assert.notEqual(wrong.status, 0); assert.match(wrong.stderr, /live full package/i);
  const gone = await verifyPublished(release(NEW_LOCK, 'carry'), null);
  assert.notEqual(gone.status, 0); assert.match(gone.stderr, /live full package/i); assert.match(gone.stderr, /404/);
});

test('verify --published: SHA256SUMS.txt must still list the signed fullAsset hash, and a missing fullAsset on a carry release still fails', async () => {
  const r = release(NEW_LOCK, 'carry'); unlinkSync(r.full);
  const p = join(r.dir, 'SHA256SUMS.txt');
  writeFileSync(p, readFileSync(p, 'utf8').split('\n').filter((l) => !l.endsWith('-win-x64.zip')).join('\n'));
  const v = await verifyPublished(r, Buffer.from('the full package bytes'));
  assert.notEqual(v.status, 0); assert.match(v.stderr, /SHA256SUMS/);
  const none = await verifyPublished(release(NEW_LOCK, 'code'), null);
  assert.notEqual(none.status, 0); assert.match(none.stderr, /strand/i);
});

test('verify without --published still needs the full zip in the folder', () => {
  const r = release(NEW_LOCK, 'carry'); unlinkSync(r.full);
  const v = verify(r); assert.notEqual(v.status, 0); assert.match(v.stderr, /not in the folder/);
});

// ------------------------------------------------------------ release-publish runs the same carry rule
function publishDry(r: Rel) {
  for (const f of ['SHA256SUMS.txt.sig', 'install.ps1', 'install.sh']) writeFileSync(join(r.dir, f), 'x');
  writeFileSync(join(r.dir, 'notes.txt'), 'notes');
  return run('release-publish.mjs', ['--dir', r.dir, '--version', V, '--notes-file', join(r.dir, 'notes.txt'), '--trust-module', r.tm, '--no-network', '--stones', '0.3.0', '--stone-lock', r.stoneLock, '--dry-run']);
}
test('publish: refuses a code-only release whose lock differs from the stone lock and that has no fullAsset (no draft is created)', () => {
  const p = publishDry(release(NEW_LOCK, 'code'));
  assert.notEqual(p.status, 0); assert.match(p.stderr, /strand/i); assert.match(p.stderr, /fullAsset/);
  assert.doesNotMatch(p.stdout, /gh release create/);
});
test('publish: a carry release, and a code-only release on the stone lock, are accepted; a stray fullAsset is refused', () => {
  const a1 = publishDry(release(NEW_LOCK, 'carry')); assert.equal(a1.status, 0, a1.stdout + a1.stderr);
  const a2 = publishDry(release(STONE_LOCK, 'code')); assert.equal(a2.status, 0, a2.stdout + a2.stderr);
  const a3 = publishDry(release(STONE_LOCK, 'carry')); assert.notEqual(a3.status, 0); assert.match(a3.stderr, /fullAsset/);
});
