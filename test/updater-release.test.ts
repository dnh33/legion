/** C22, C23: the release scripts (package, manifest, sign, verify, keygen) and their round trip into the app's own verifier and stager. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest } from '../src/core/updater/manifest.js';
import { stagePackage } from '../src/core/updater/package.js';
import { verifyManifestSignature } from '../src/core/updater/trust.js';
import { sha256, startFakeServer } from './updater-helpers.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const run = (script: string, argv: string[]) => spawnSync(process.execPath, [join(REPO, 'scripts', script), ...argv], { encoding: 'utf8' });
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const LOCK = '{"name":"legion","lockfileVersion":3}\n';

function builtTree(version: string): string {
  const r = tmp('upd-tree-');
  const put = (p: string, c: string) => { mkdirSync(join(r, p, '..'), { recursive: true }); writeFileSync(join(r, p), c); };
  put('package.json', JSON.stringify({ name: 'legion', version })); put('package-lock.json', LOCK);
  put('dist/src/electron/main.js', 'm'); put('dist/src/bin/legion-core.js', 'c'); put('dist/test/a.test.js', 'EXCLUDED');
  put('dist-ui/index.html', '<html>'); put('assets/icon.png', 'p'); put('scripts/setup.ps1', 's'); put('NOTICE', 'n');
  put('node_modules/electron/x.js', 'EXCLUDED'); put('src/core/a.ts', 'EXCLUDED'); put('.git/config', 'EXCLUDED'); put('uninstall.cmd', 'EXCLUDED');
  return r;
}
/** A trust module file with the test key embedded, standing in for dist trust.js (the shipped list is empty until the owner adds the key). */
function trustModule(pubPem: string): string {
  const f = join(tmp('upd-trust-'), 'trust.mjs');
  writeFileSync(f, `import { verifyManifestSignature as v } from ${JSON.stringify(new URL('../src/core/updater/trust.js', import.meta.url).href)};\nexport const UPDATE_KEYS = [{ id: 'k1', publicKeyPem: ${JSON.stringify(pubPem)} }];\nexport const verifyManifestSignature = (m, s, k) => v(m, s, k);\n`);
  return f;
}

test('C22/C23: keygen refuses a path inside the repo; elsewhere it writes a 0600 private key and prints only the public key', () => {
  const bad = run('release-keygen.mjs', ['--out', join(REPO, 'tmp-keys')]);
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /inside a git work tree/);
  assert.equal(existsSync(join(REPO, 'tmp-keys')), false);
  const out = tmp('upd-keys-');
  const ok = run('release-keygen.mjs', ['--out', out]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /publicKeyPem/);
  assert.doesNotMatch(ok.stdout + ok.stderr, new RegExp('PRIVATE ' + 'KEY'), 'the private key is never printed');
  const priv = join(out, 'legion-update-k1.key.pem');
  if (process.platform !== 'win32') assert.equal(statSync(priv).mode & 0o777, 0o600);
  assert.equal(run('release-keygen.mjs', ['--out', out]).status !== 0, true, 'never overwrites an existing key');
});

test('C23: package -> manifest -> sign -> verify, and the app accepts exactly what the scripts made (end to end through the real stager)', async () => {
  const tree = builtTree('0.9.0');
  const out = tmp('upd-rel-'); const keys = tmp('upd-keys-');
  const p = run('release-package.mjs', ['--root', tree, '--out', out, '--published-at', '2026-10-20T10:00:00Z']);
  assert.equal(p.status, 0, p.stderr);
  const zipPath = join(out, 'legion-0.9.0-app.zip');
  const again = tmp('upd-rel2-');
  assert.equal(run('release-package.mjs', ['--root', tree, '--out', again, '--published-at', '2026-10-20T10:00:00Z']).status, 0);
  assert.equal(sha256(readFileSync(zipPath)), sha256(readFileSync(join(again, 'legion-0.9.0-app.zip'))), 'deterministic');
  const notes = join(out, 'notes.txt'); writeFileSync(notes, 'Fixes <things>.\n');
  const m = run('release-manifest.mjs', ['--zip', zipPath, '--out', out, '--notes', notes]);
  assert.equal(m.status, 0, m.stderr);
  const kg = run('release-keygen.mjs', ['--out', keys]); assert.equal(kg.status, 0);
  const pub = readFileSync(join(keys, 'legion-update-k1.pub.pem'), 'utf8');
  const tm = trustModule(pub);
  // refuses a key that is not embedded in the built app (the real trust.js list is empty)
  const refused = run('release-sign.mjs', ['--key', join(keys, 'legion-update-k1.key.pem'), '--manifest', join(out, 'legion-update-manifest.json')]);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /not in UPDATE_KEYS/);
  assert.equal(existsSync(join(out, 'legion-update-manifest.json.sig')), false);
  // refuses a key inside the repo
  assert.match(run('release-sign.mjs', ['--key', join(REPO, 'package.json'), '--manifest', join(out, 'legion-update-manifest.json')]).stderr, /inside the repo/);
  const s = run('release-sign.mjs', ['--key', join(keys, 'legion-update-k1.key.pem'), '--manifest', join(out, 'legion-update-manifest.json'), '--trust-module', tm]);
  assert.equal(s.status, 0, s.stderr);
  const v = run('release-verify.mjs', ['--dir', out, '--trust-module', tm]);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  // the app side
  const mBytes = readFileSync(join(out, 'legion-update-manifest.json')); const sig = readFileSync(join(out, 'legion-update-manifest.json.sig'), 'utf8');
  const keyList = [{ id: 'k1', publicKeyPem: pub }];
  assert.equal(verifyManifestSignature(mBytes, sig, keyList).ok, true);
  const man = parseManifest(mBytes);
  assert.equal(man.version, '0.9.0'); assert.equal(man.notes, 'Fixes <things>.'); assert.equal(man.publishedAt, '2026-10-20T10:00:00Z');
  const srv = await startFakeServer(null);
  srv.handler.custom = (req, res) => { if (req.url?.includes('/releases/download/')) { const z = readFileSync(zipPath); res.writeHead(200, { 'content-length': z.length }); res.end(z); return true; } return false; };
  try {
    const install = tmp('upd-inst-');
    const st = await stagePackage({ installDir: install, source: srv.source, manifest: man, version: '0.9.0', installedLockSha256: sha256(LOCK), freeBytes: () => 10 ** 12 });
    const names = readdirSync(st.treeDir).sort();
    assert.deepEqual(names, ['NOTICE', 'assets', 'build-info.json', 'dist', 'dist-ui', 'package-lock.json', 'package.json', 'scripts']);
    assert.equal(existsSync(join(st.treeDir, 'dist', 'test')), false, 'compiled tests are not shipped');
  } finally { await srv.close(); }
  // a tampered manifest fails the verifier script
  writeFileSync(join(out, 'legion-update-manifest.json'), mBytes.toString().replace('0.9.0', '0.9.9'));
  assert.notEqual(run('release-verify.mjs', ['--dir', out, '--trust-module', tm]).status, 0);
});

test('C23: the scripts refuse bad input (an unbuilt tree, a non-greater version, over-long notes, a bad name)', () => {
  const unbuilt = tmp('upd-unb-'); writeFileSync(join(unbuilt, 'package.json'), '{"version":"1.0.0"}');
  assert.match(run('release-package.mjs', ['--root', unbuilt, '--out', tmp('o-')]).stderr, /not a built tree/);
  const tree = builtTree('1.0.0'); const out = tmp('upd-rel-');
  assert.equal(run('release-package.mjs', ['--root', tree, '--out', out]).status, 0);
  const zip = join(out, 'legion-1.0.0-app.zip');
  const prev = join(out, 'prev.json'); writeFileSync(prev, JSON.stringify({ version: '1.0.0', publishedAt: '2020-01-01T00:00:00Z' }));
  assert.match(run('release-manifest.mjs', ['--zip', zip, '--out', out, '--previous', prev]).stderr, /not greater/);
  const long = join(out, 'long.txt'); writeFileSync(long, 'x'.repeat(2001));
  assert.match(run('release-manifest.mjs', ['--zip', zip, '--out', out, '--notes', long]).stderr, /limit is 2000/);
  const renamed = join(out, 'other.zip'); writeFileSync(renamed, readFileSync(zip));
  assert.match(run('release-manifest.mjs', ['--zip', renamed, '--out', out]).stderr, /must be named/);
});

test('C22: no private key material is committed anywhere in the repo (a repo-wide scan; test keys exist only at test time)', () => {
  const header = new RegExp('-----BEGIN [A-Z ]*PRIVATE ' + 'KEY-----');
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      if (['node_modules', 'dist', '.git', 'dist-ui'].includes(n) || (d === REPO && n === 'test')) continue; // test/ holds other suites' fake-secret fixtures; the updater tests are checked below
      const p = join(d, n); const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.size < 2_000_000 && !/\.(png|ico|woff2?|jpg|jpeg|gif|zip|mp4|webp)$/i.test(n) && header.test(readFileSync(p, 'utf8'))) hits.push(p.slice(REPO.length));
    }
  };
  walk(REPO);
  assert.deepEqual(hits, []);
  for (const f of readdirSync(join(REPO, 'test')).filter((n) => n.startsWith('updater-'))) assert.equal(header.test(readFileSync(join(REPO, 'test', f), 'utf8')), false, f);
  const trust = readFileSync(join(REPO, 'src/core/updater/trust.ts'), 'utf8');
  assert.doesNotMatch(trust, new RegExp('PRIVATE ' + 'KEY'));
});
