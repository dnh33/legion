/**
 * The release-build follow-ups (ladder 33, item 33): SHA256SUMS signing and the v* tag ruleset.
 *
 * The signing key never leaves the maintainer's PC, so these run the scripts offline against a throwaway key: they pin
 * that release-sign-sums writes a detached signature over the RAW SHA256SUMS.txt bytes, that it refuses a key inside the
 * repo, a key the app does not trust and a non-Ed25519 key, and that gh-tag-ruleset emits the owner-only tag ruleset and
 * never touches GitHub without --apply (which names gh, so it is not reachable in CI).
 */
import { tempDir } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const run = (script: string, argv: string[], env?: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, [join(REPO, 'scripts', script), ...argv], { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });

/** A trust module file with the test key embedded, standing in for dist trust.js (whose UPDATE_KEYS holds the shipped key). */
function trustModule(pubPem: string): string {
  const f = join(tempDir('leg-sums-trust-'), 'trust.mjs');
  writeFileSync(f, `import { verifyManifestSignature as v } from ${JSON.stringify(new URL('../src/core/updater/trust.js', import.meta.url).href)};\n`
    + `export const UPDATE_KEYS = [{ id: 'k1', publicKeyPem: ${JSON.stringify(pubPem)} }];\n`
    + `export const verifyManifestSignature = (m, s, k) => v(m, s, k);\n`);
  return f;
}
const SUMS = `${'a'.repeat(64)}  legion-0.9.0-app.zip\n${'b'.repeat(64)}  legion-0.9.0-win-x64.zip\n`;

test('release-sign-sums writes a detached sig over the raw SHA256SUMS.txt bytes, verifiable with the k1 public key', () => {
  const keys = tempDir('leg-sums-keys-');
  assert.equal(run('release-keygen.mjs', ['--out', keys]).status, 0);
  const tm = trustModule(readFileSync(join(keys, 'legion-update-k1.pub.pem'), 'utf8'));
  const dir = tempDir('leg-sums-');
  const sums = join(dir, 'SHA256SUMS.txt');
  writeFileSync(sums, SUMS);
  const r = run('release-sign-sums.mjs', ['--key', join(keys, 'legion-update-k1.key.pem'), '--sums', sums, '--trust-module', tm]);
  assert.equal(r.status, 0, r.stderr);
  const sig = JSON.parse(readFileSync(`${sums}.sig`, 'utf8'));
  assert.equal(sig.keyId, 'k1');
  assert.equal(sig.alg, 'ed25519');
  assert.match(sig.sig, /^[0-9a-f]{128}$/, 'a 64-byte Ed25519 signature in hex');
  const pub = createPublicKey(readFileSync(join(keys, 'legion-update-k1.pub.pem'), 'utf8'));
  assert.equal(verify(null, readFileSync(sums), pub, Buffer.from(sig.sig, 'hex')), true, 'the sig verifies over the raw sums bytes');
  // it binds the bytes: one flipped version string breaks it
  assert.equal(verify(null, Buffer.from(SUMS.replace('0.9.0', '0.9.9')), pub, Buffer.from(sig.sig, 'hex')), false, 'a tampered sums file fails');
});

test('release-sign-sums refuses a key in the repo, a key the app does not trust, and a non-Ed25519 key; no sig is written', () => {
  const dir = tempDir('leg-sums-neg-');
  const sums = join(dir, 'SHA256SUMS.txt');
  writeFileSync(sums, `${'a'.repeat(64)}  x\n`);

  // a key inside the repo: refused before anything is read (no trust module needed)
  const inRepo = run('release-sign-sums.mjs', ['--key', join(REPO, 'package.json'), '--sums', sums]);
  assert.notEqual(inRepo.status, 0);
  assert.match(inRepo.stderr, /inside the repo/);
  assert.equal(existsSync(`${sums}.sig`), false);

  // a well-formed Ed25519 key whose public half is not the trusted one
  const a = tempDir('leg-sums-a-');
  const b = tempDir('leg-sums-b-');
  assert.equal(run('release-keygen.mjs', ['--out', a]).status, 0);
  assert.equal(run('release-keygen.mjs', ['--out', b]).status, 0);
  const tm = trustModule(readFileSync(join(a, 'legion-update-k1.pub.pem'), 'utf8'));
  const notTrusted = run('release-sign-sums.mjs', ['--key', join(b, 'legion-update-k1.key.pem'), '--sums', sums, '--trust-module', tm]);
  assert.notEqual(notTrusted.status, 0);
  assert.match(notTrusted.stderr, /not in UPDATE_KEYS/);
  assert.equal(existsSync(`${sums}.sig`), false);

  // a key that is not Ed25519
  const rsa = join(dir, 'rsa.key.pem');
  writeFileSync(rsa, generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey);
  const nonEd = run('release-sign-sums.mjs', ['--key', rsa, '--sums', sums, '--trust-module', tm]);
  assert.notEqual(nonEd.status, 0);
  assert.match(nonEd.stderr, /not an Ed25519 key/);
});

test('gh-tag-ruleset --print emits the owner-only v* tag ruleset and how to apply it, without touching GitHub', () => {
  const r = run('gh-tag-ruleset.mjs', ['--print']);
  assert.equal(r.status, 0, r.stderr);
  const rs = JSON.parse(r.stdout) as { name: string; target: string; enforcement: string; conditions: { ref_name: { include: string[]; exclude: string[] } }; rules: { type: string }[]; bypass_actors: unknown[] };
  assert.equal(rs.name, 'v* release tags: owner only');
  assert.equal(rs.target, 'tag');
  assert.equal(rs.enforcement, 'active');
  assert.deepEqual(rs.conditions.ref_name.include, ['refs/tags/v*']);
  assert.deepEqual(rs.conditions.ref_name.exclude, []);
  assert.deepEqual(rs.rules.map((x) => x.type).sort(), ['creation', 'deletion', 'update'], 'restrict creation, update and deletion');
  assert.deepEqual(rs.bypass_actors, [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }], 'only the admin role (the owner) may bypass');
  assert.match(r.stderr, /repos\/dnh33\/legion\/rulesets/);
  assert.match(r.stderr, /--apply/);
});

test('gh-tag-ruleset takes --repo and refuses an unknown option or a malformed repo', () => {
  const r = run('gh-tag-ruleset.mjs', ['--repo', 'acme/widgets']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /repos\/acme\/widgets\/rulesets/);
  const bad = run('gh-tag-ruleset.mjs', ['--bogus']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown option/);
  const badRepo = run('gh-tag-ruleset.mjs', ['--repo', 'not-a-repo']);
  assert.notEqual(badRepo.status, 0);
  assert.match(badRepo.stderr, /--repo/);
});

test('gh-tag-ruleset --apply fails loudly and creates nothing when gh is unreachable (it never runs in CI)', () => {
  const r = run('gh-tag-ruleset.mjs', ['--apply'], { LEGION_GH: 'legion-no-such-gh-binary' });
  assert.notEqual(r.status, 0, 'a missing gh must not exit 0');
  assert.match(r.stderr, /gh api failed/);
  assert.doesNotMatch(r.stderr, /created ruleset|updated ruleset/, 'nothing claims a ruleset was created');
});

test('release-verify accepts an unsigned SHA256SUMS, then checks a SHA256SUMS.txt.sig when present and fails on a tampered one', () => {
  const keys = tempDir('leg-ver-keys-');
  assert.equal(run('release-keygen.mjs', ['--out', keys]).status, 0);
  const tm = trustModule(readFileSync(join(keys, 'legion-update-k1.pub.pem'), 'utf8'));
  const dir = tempDir('leg-ver-');
  const zipName = 'legion-0.9.0-app.zip';
  const zipBytes = Buffer.from('pretend app zip bytes');
  writeFileSync(join(dir, zipName), zipBytes);
  const sha = createHash('sha256').update(zipBytes).digest('hex');
  const manifest = {
    schema: 1, product: 'legion', channel: 'stable', version: '0.9.0', publishedAt: '2026-10-20T10:00:00Z',
    asset: { name: zipName, size: zipBytes.length, sha256: sha }, depsSha256: 'a'.repeat(64), requiresFullInstall: false, notes: 'x',
  };
  writeFileSync(join(dir, 'legion-update-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  assert.equal(run('release-sign.mjs', ['--key', join(keys, 'legion-update-k1.key.pem'), '--manifest', join(dir, 'legion-update-manifest.json'), '--trust-module', tm]).status, 0);
  writeFileSync(join(dir, 'SHA256SUMS.txt'), `${sha}  ${zipName}\n`);
  // an unsigned sums file is fine (releases signed before the sums signer existed)
  assert.equal(run('release-verify.mjs', ['--dir', dir, '--trust-module', tm]).status, 0);
  // sign the sums: still verifies
  assert.equal(run('release-sign-sums.mjs', ['--key', join(keys, 'legion-update-k1.key.pem'), '--sums', join(dir, 'SHA256SUMS.txt'), '--trust-module', tm]).status, 0);
  assert.equal(run('release-verify.mjs', ['--dir', dir, '--trust-module', tm]).status, 0);
  // flip a character of the signature: the gate must refuse
  const sig = JSON.parse(readFileSync(join(dir, 'SHA256SUMS.txt.sig'), 'utf8')) as { sig: string };
  sig.sig = (sig.sig[0] === 'a' ? 'b' : 'a') + sig.sig.slice(1);
  writeFileSync(join(dir, 'SHA256SUMS.txt.sig'), JSON.stringify(sig));
  const bad = run('release-verify.mjs', ['--dir', dir, '--trust-module', tm]);
  assert.notEqual(bad.status, 0, 'a tampered sums signature must fail the gate');
  assert.match(bad.stderr, /SHA256SUMS\.txt\.sig does not verify/);
});
