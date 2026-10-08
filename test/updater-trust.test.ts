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

test('C6b: the optional fullAsset (the signed full package) is validated as strictly as the app asset, and is absent on every existing manifest', () => {
  const full = { name: 'legion-0.3.0-win-x64.zip', size: 1234, sha256: 'a'.repeat(64) };
  const m = parseManifest(Buffer.from(JSON.stringify({ ...rel('0.3.0').manifestObj, fullAsset: full })));
  assert.deepEqual(m.fullAsset, full);
  // Absent: back-compatible, and (with planRelease) a notify-only route.
  assert.equal(parseManifest(rel('0.3.0').manifest).fullAsset, undefined);
  const bad = (fullAsset: unknown) => assert.throws(
    () => parseManifest(Buffer.from(JSON.stringify({ ...rel('0.3.0').manifestObj, fullAsset }))),
    ManifestError, JSON.stringify(fullAsset).slice(0, 70),
  );
  bad({ ...full, name: 'evil.zip' });                       // wrong name
  bad({ ...full, name: 'legion-0.3.0-app.zip' });           // the app asset name is not the full name
  bad({ ...full, name: 'legion-0.3.1-win-x64.zip' });       // another version's full package
  bad({ name: full.name, size: full.size });                // no sha256
  bad({ ...full, size: 0 });
  bad({ ...full, size: -1 });
  bad({ ...full, size: 1.5 });
  bad({ ...full, size: 999_999_999_999 });                  // over the full-package cap
  bad({ ...full, sha256: 'A'.repeat(64) });                 // uppercase hex
  bad({ ...full, sha256: 'abc' });
  bad(5);
  bad([]);
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

// Lettered patch suffixes (owner directive 2026-10-03: a patch on top of an unreleased number, e.g. 0.2.2-a). These MUST
// order the way node-semver orders a pre-release, or the updater offers downgrades and refuses legitimate updates.
test('a lettered patch suffix is accepted; other pre-release shapes stay rejected', () => {
  for (const v of ['0.2.2-a', '0.2.2-b', '0.2.2-z', '1.0.0-a']) assert.ok(isPlainSemver(v), `${v} should be accepted`);
  for (const v of ['0.2.2-A', '0.2.2-', '0.2.2-ab', '0.2.2-beta.1', '0.2.2-a1', '0.2.2a', '', '0.2.2-a-b']) {
    assert.equal(isPlainSemver(v), false, `${v} should be rejected`);
  }
});

test('a lettered suffix sorts BELOW its own plain release and ABOVE the previous one (no downgrade, no missed update)', () => {
  assert.ok(compareSemver('0.2.2-a', '0.2.1') > 0, '0.2.2-a must be OFFERED to someone on 0.2.1');
  assert.ok(compareSemver('0.2.2-a', '0.2.2') < 0, 'the plain 0.2.2 must SUPERSEDE 0.2.2-a');
  assert.ok(compareSemver('0.2.2', '0.2.2-a') > 0, 'asymmetric: plain release ranks above its own suffix');
  assert.ok(compareSemver('0.2.2-a', '0.2.2-b') < 0, 'letters order among themselves');
  assert.ok(compareSemver('0.2.2-b', '0.2.2-a') > 0, 'asymmetric letters');
  assert.equal(compareSemver('0.2.2-a', '0.2.2-a'), 0, 'equal');
  assert.ok(compareSemver('0.2.10-a', '0.2.9') > 0, 'numeric compare still wins over the suffix');
});

test('checkPolicy offers a lettered-suffix release to the previous version and refuses it as a downgrade from its own plain release', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  const m = (v: string) => parseManifest(rel(v, { publishedAt: '2026-10-19T00:00:00Z' }).manifest);
  const ctx = (v: string) => ({ running: { version: v }, nowMs: now, failedVersions: ['0.2.1'] });
  assert.equal(checkPolicy(m('0.2.2-a'), ctx('0.2.1')).ok, true, 'offered to 0.2.1');
  assert.equal((checkPolicy(m('0.2.2-a'), ctx('0.2.2')) as { code: string }).code, 'downgrade', 'refused to 0.2.2');
});
