/** C5, C6, C7: signature, strict manifest, downgrade/replay policy. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { UPDATE_KEYS, verifyManifestSignature } from '../src/core/updater/trust.js';
import { checkPolicy, ManifestError, parseManifest } from '../src/core/updater/manifest.js';
import { compareSemver, isPlainSemver } from '../src/core/updater/semver.js';
import { makeKey, makeRelease } from './updater-helpers.js';

const k = makeKey('k1');
const rel = (v = '0.2.1', o = {}) => makeRelease(k, v, o);

test('C5: a good signature verifies; the key id comes back', () => {
  const r = rel();
  assert.deepEqual(verifyManifestSignature(r.manifest, r.sig, [k.key]), { ok: true, keyId: 'k1' });
});
test('C5: an empty key list fails closed (the shipped list is empty until the owner adds the public key)', () => {
  const r = rel();
  assert.equal(verifyManifestSignature(r.manifest, r.sig, []).ok, false);
  assert.equal(verifyManifestSignature(r.manifest, r.sig, UPDATE_KEYS).ok, false, 'a test-time key is never in the shipped list');
});
test('C5: a changed manifest byte, a wrong key, an unknown key id, a malformed signature all fail', () => {
  const r = rel();
  const tampered = Buffer.from(r.manifest); tampered[tampered.length - 3] ^= 1;
  assert.equal(verifyManifestSignature(tampered, r.sig, [k.key]).ok, false);
  const other = makeKey('k1');
  assert.equal(verifyManifestSignature(r.manifest, r.sig, [other.key]).ok, false);
  assert.equal(verifyManifestSignature(r.manifest, r.sig, [{ ...k.key, id: 'other' }]).ok, false);
  const bad = (s: unknown) => verifyManifestSignature(r.manifest, typeof s === 'string' ? s : JSON.stringify(s), [k.key]).ok;
  assert.equal(bad('not json'), false);
  assert.equal(bad({ keyId: 'k1', alg: 'rsa', sig: 'a'.repeat(128) }), false);
  assert.equal(bad({ keyId: 'k1', alg: 'ed25519', sig: 'zz' }), false);
  assert.equal(bad({ keyId: 'k1', alg: 'ed25519', sig: '0'.repeat(128) }), false);
  assert.equal(bad({ alg: 'ed25519', sig: 'a'.repeat(128) }), false);
});
test('C5: signing the PARSED/reformatted JSON is not the same as signing the raw bytes', () => {
  const r = rel();
  const reformatted = Buffer.from(JSON.stringify(JSON.parse(r.manifest.toString())));
  assert.equal(verifyManifestSignature(reformatted, r.sig, [k.key]).ok, false);
});
test('C5: a non-Ed25519 embedded key is refused', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const r = rel();
  assert.equal(verifyManifestSignature(r.manifest, r.sig, [{ id: 'k1', publicKeyPem: rsa }]).ok, false);
});

test('C6: the strict schema accepts a good manifest and rejects each bad field', () => {
  const m = parseManifest(rel('0.3.0').manifest);
  assert.equal(m.version, '0.3.0');
  const bad = (patch: Record<string, unknown>) => assert.throws(() => parseManifest(Buffer.from(JSON.stringify({ ...rel('0.3.0').manifestObj, ...patch }))), ManifestError, JSON.stringify(patch).slice(0, 60));
  bad({ channel: 'beta' }); bad({ product: 'other' }); bad({ schema: 2 }); bad({ version: '0.3.0-rc1' }); bad({ version: '1.2' }); bad({ version: '01.2.3' });
  bad({ asset: { name: 'evil.zip', size: 5, sha256: 'a'.repeat(64) } });
  bad({ asset: { name: 'legion-0.3.0-app.zip', size: -1, sha256: 'a'.repeat(64) } });
  bad({ asset: { name: 'legion-0.3.0-app.zip', size: 5, sha256: 'A'.repeat(64) } });
  bad({ asset: { name: 'legion-0.3.0-app.zip', size: 999_999_999_999, sha256: 'a'.repeat(64) } });
  bad({ depsSha256: 'x' }); bad({ requiresFullInstall: 'no' }); bad({ publishedAt: 'yesterday' }); bad({ notes: 'x'.repeat(2001) }); bad({ notes: 5 });
  assert.throws(() => parseManifest(Buffer.from('[]')), ManifestError);
  assert.throws(() => parseManifest(Buffer.alloc(70_000, 32)), ManifestError);
});

test('C7: policy table (downgrade, equal, older build, future, failed before)', () => {
  const m = (v: string, at: string) => parseManifest(rel(v, { publishedAt: at }).manifest);
  const now = Date.parse('2026-10-20T00:00:00Z');
  const ctx = (v: string, builtAt?: string, failed: string[] = []) => ({ running: { version: v, ...(builtAt ? { publishedAt: builtAt } : {}) }, nowMs: now, failedVersions: failed });
  assert.equal(checkPolicy(m('0.2.1', '2026-10-19T00:00:00Z'), ctx('0.2.0')).ok, true);
  assert.deepEqual(checkPolicy(m('0.2.0', '2026-10-19T00:00:00Z'), ctx('0.2.0')), { ok: false, code: 'up-to-date', reason: 'already on this version' });
  assert.equal((checkPolicy(m('0.1.9', '2026-10-19T00:00:00Z'), ctx('0.2.0')) as { code: string }).code, 'downgrade');
  assert.equal((checkPolicy(m('0.10.0', '2026-10-19T00:00:00Z'), ctx('0.9.0')) as { ok: boolean }).ok, true, 'numeric, not string, compare');
  assert.equal((checkPolicy(m('0.2.1', '2026-09-01T00:00:00Z'), ctx('0.2.0', '2026-10-01T00:00:00Z')) as { code: string }).code, 'older-build');
  assert.equal((checkPolicy(m('0.2.1', '2026-12-01T00:00:00Z'), ctx('0.2.0')) as { code: string }).code, 'future-dated');
  assert.equal((checkPolicy(m('0.2.1', '2026-10-19T00:00:00Z'), ctx('0.2.0', undefined, ['0.2.1'])) as { code: string }).code, 'failed-before');
  assert.equal(checkPolicy(m('0.2.2', '2026-10-19T00:00:00Z'), ctx('0.2.0', undefined, ['0.2.1'])).ok, true);
});
test('C7: semver helpers are numeric and strict', () => {
  assert.ok(compareSemver('0.10.0', '0.9.0') > 0);
  assert.equal(isPlainSemver('1.2.3-beta'), false);
  assert.throws(() => compareSemver('1.2', '1.2.3'));
});
