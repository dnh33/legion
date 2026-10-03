/**
 * The trust anchor: Ed25519 public keys compiled into the app. A release manifest is accepted only if its signature (over the RAW bytes
 * of the manifest file) verifies against the key named by the signature file's keyId. An empty list means "this build has no update key":
 * every check fails closed. Rotation: a normal signed release carries the old AND the new key; a later release drops the old one.
 * There is no remote revocation: a compromised key means a manual reinstall (plan section 9).
 */
import { createPublicKey, verify } from 'node:crypto';

export interface UpdateKey { id: string; publicKeyPem: string }

/** The owner pastes the PUBLIC key printed by scripts/release-keygen.mjs here before the first release. Never a private key. */
export const UPDATE_KEYS: readonly UpdateKey[] = Object.freeze([
  { id: 'k1', publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA41Hd+3TZlF6e5uDTNY27y6GUZZ0Db50opAz7GlmONt0=
-----END PUBLIC KEY-----` },
]);

export type VerifyResult = { ok: true; keyId: string } | { ok: false; reason: string };

/** The signature file is JSON: {"keyId":"...","alg":"ed25519","sig":"<128 hex chars>"}. */
export function verifyManifestSignature(manifestBytes: Buffer, sigText: string, keys: readonly UpdateKey[]): VerifyResult {
  if (!keys.length) return { ok: false, reason: 'this build has no update key, so updates are off' };
  let sig: { keyId?: unknown; alg?: unknown; sig?: unknown };
  try { sig = JSON.parse(sigText) as typeof sig; } catch { return { ok: false, reason: 'the signature file is not valid JSON' }; }
  if (!sig || typeof sig !== 'object' || sig.alg !== 'ed25519' || typeof sig.keyId !== 'string' || typeof sig.sig !== 'string') return { ok: false, reason: 'the signature file has the wrong shape' };
  if (!/^[0-9a-f]{128}$/i.test(sig.sig)) return { ok: false, reason: 'the signature is not 64 bytes of hex' };
  const key = keys.find((k) => k.id === sig.keyId);
  if (!key) return { ok: false, reason: 'the signature names a key this build does not trust' };
  try {
    const pub = createPublicKey(key.publicKeyPem);
    if (pub.asymmetricKeyType !== 'ed25519') return { ok: false, reason: 'the embedded key is not an Ed25519 key' };
    if (!verify(null, manifestBytes, pub, Buffer.from(sig.sig, 'hex'))) return { ok: false, reason: 'the signature does not match the manifest' };
  } catch { return { ok: false, reason: 'the signature could not be checked' }; }
  return { ok: true, keyId: key.id };
}
