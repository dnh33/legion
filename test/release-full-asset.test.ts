/** release-verify.mjs and release-preflight.mjs: a manifest that needs the full package must carry exactly the full zip, signed and listed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-cleanup.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const run = (script: string, argv: string[]) => spawnSync(process.execPath, [join(REPO, 'scripts', script), ...argv], { encoding: 'utf8' });
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const V = '0.9.4';

const LOCK = '{"name":"legion","lockfileVersion":3}\n';
function pkgTree(): string {
  const r = tempDir('fa-tree-');
  const put = (p: string, c: string) => { const f = join(r, p); spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(require('path').dirname(${JSON.stringify(f)}),{recursive:true})`]); writeFileSync(f, c); };
  put('package.json', JSON.stringify({ name: 'legion', version: V })); put('package-lock.json', LOCK);
  put('dist/src/electron/main.js', 'm'); put('dist/src/bin/legion-core.js', 'c'); put('dist-ui/index.html', '<html>');
  return r;
}
function trustModule(pubPem: string): string {
  const f = join(tempDir('fa-trust-'), 'trust.mjs');
  writeFileSync(f, `import { verifyManifestSignature as v } from ${JSON.stringify(new URL('../src/core/updater/trust.js', import.meta.url).href)};\nexport const UPDATE_KEYS = [{ id: 'k1', publicKeyPem: ${JSON.stringify(pubPem)} }];\nexport const verifyManifestSignature = (m, s, k) => v(m, s, k);\n`);
  return f;
}

/** A signed release folder. `mode` shapes the manifest: 'full' = fullAsset + requiresFullInstall, 'code' = neither. */
function release(mode: 'full' | 'code'): { dir: string; tm: string; full: string } {
  const out = tempDir('fa-rel-'); const keys = tempDir('fa-keys-');
  assert.equal(run('release-package.mjs', ['--root', pkgTree(), '--out', out, '--published-at', '2026-10-20T10:00:00Z']).status, 0);
  const full = join(out, `legion-${V}-win-x64.zip`); writeFileSync(full, 'the full package bytes');
  const m = ['--zip', join(out, `legion-${V}-app.zip`), '--out', out];
  if (mode === 'full') m.push('--full-zip', full, '--requires-full-install');
  assert.equal(run('release-manifest.mjs', m).status, 0);
  assert.equal(run('release-keygen.mjs', ['--out', keys]).status, 0);
  const tm = trustModule(readFileSync(join(keys, 'legion-update-k1.pub.pem'), 'utf8'));
  const s = run('release-sign.mjs', ['--key', join(keys, 'legion-update-k1.key.pem'), '--manifest', join(out, 'legion-update-manifest.json'), '--trust-module', tm]);
  assert.equal(s.status, 0, s.stderr);
  return { dir: out, tm, full };
}
const verify = (r: { dir: string; tm: string }) => run('release-verify.mjs', ['--dir', r.dir, '--trust-module', r.tm]);

test('verify: a full release with the exact full zip passes; a code-only release passes', () => {
  const f = verify(release('full')); assert.equal(f.status, 0, f.stdout + f.stderr);
  const c = verify(release('code')); assert.equal(c.status, 0, c.stdout + c.stderr);
});

test('verify: requiresFullInstall with the full zip missing from the folder is refused', () => {
  const r = release('full');
  spawnSync(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(r.full)})`]);
  const v = verify(r); assert.notEqual(v.status, 0); assert.match(v.stderr, /full package/i);
});

test('verify: a full zip that differs from the signed size or sha256 is refused', () => {
  const r = release('full');
  writeFileSync(r.full, 'the full package bytes, but changed');
  const v = verify(r); assert.notEqual(v.status, 0); assert.match(v.stderr, /full package/i);
});

test('verify: SHA256SUMS.txt must list the full zip hash', () => {
  const r = release('full');
  const p = join(r.dir, 'SHA256SUMS.txt');
  writeFileSync(p, readFileSync(p, 'utf8').split('\n').filter((l) => !l.endsWith(`legion-${V}-win-x64.zip`)).join('\n'));
  const v = verify(r); assert.notEqual(v.status, 0); assert.match(v.stderr, /SHA256SUMS/);
});

test('preflight: reports the full package checks for a full release', () => {
  const r = release('full');
  const p = run('release-preflight.mjs', ['--version', V, '--pkg', r.dir]);
  assert.match(p.stdout + p.stderr, /full package/i, 'preflight talks about the full package');
  // the folder is right, so no full-package failure line
  assert.doesNotMatch(p.stderr, /FAIL[^\n]*full package/i);
});

test('preflight: a stray fullAsset on a release that does not need it fails', () => {
  const r = release('code');
  const mp = join(r.dir, 'legion-update-manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8')) as Record<string, unknown>;
  m.fullAsset = { name: `legion-${V}-win-x64.zip`, size: 22, sha256: sha(readFileSync(r.full)) };
  writeFileSync(mp, JSON.stringify(m));
  const p = run('release-preflight.mjs', ['--version', V, '--pkg', r.dir]);
  assert.match(p.stderr, /FAIL[^\n]*fullAsset/i);
});

test('preflight: requiresFullInstall without fullAsset fails (it is no longer only a warning)', () => {
  const r = release('code');
  const mp = join(r.dir, 'legion-update-manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8')) as Record<string, unknown>;
  m.requiresFullInstall = true;
  writeFileSync(mp, JSON.stringify(m));
  const p = run('release-preflight.mjs', ['--version', V, '--pkg', r.dir]);
  assert.match(p.stderr, /FAIL[^\n]*fullAsset/i);
});
