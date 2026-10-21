/**
 * The core's own block of the eight compromised eMudhra intermediate CA keys (src/core/tls-blocklist.ts). Offline: the chain is the
 * public chain one of the tracker's test hosts serves (test/fixtures/emudhra-dv-g3b-chain.crt), handed to the check the way
 * tls.connect hands it a verified peer certificate. The live handshake against the test hosts is test/tls-blocklist-live.test.ts.
 */
import { strict as assert } from 'node:assert';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BLOCKED_SPKI_SHA256, blockedKeyIn, guardServerIdentity, installTlsBlocklist, spkiSha256 } from '../src/core/tls-blocklist.js';

const pems = (text: string): string[] => text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
const chainPems = pems(readFileSync(fileURLToPath(new URL('../../test/fixtures/emudhra-dv-g3b-chain.crt', import.meta.url)), 'utf8'));

/** A detailed peer certificate as tls.connect passes it to checkServerIdentity: leaf first, each issuer linked, the last one its own issuer. */
function peer(list: string[]): tls.DetailedPeerCertificate {
  const nodes = list.map((p) => ({ raw: new X509Certificate(p).raw, subject: {} }) as unknown as tls.DetailedPeerCertificate);
  nodes.forEach((n, i) => { (n as { issuerCertificate: tls.DetailedPeerCertificate }).issuerCertificate = nodes[i + 1] ?? n; });
  return nodes[0]!;
}

describe('core TLS key block (eMudhra intermediate CA compromise)', () => {
  it('lists exactly the eight compromised keys, as SHA-256 of the SubjectPublicKeyInfo', () => {
    const keys = Object.keys(BLOCKED_SPKI_SHA256);
    assert.equal(keys.length, 8);
    for (const k of keys) assert.match(k, /^[0-9a-f]{64}$/);
    assert.equal(new Set(Object.values(BLOCKED_SPKI_SHA256)).size, 8, 'one name per key');
  });

  it('hashes a certificate key the way the tracker and Electron do', () => {
    assert.equal(chainPems.length, 3);
    assert.equal(spkiSha256(new X509Certificate(chainPems[1]!).raw), 'ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105');
  });

  it('finds the compromised intermediate anywhere in a chain', () => {
    assert.equal(blockedKeyIn(peer(chainPems)), 'EM DV TLS CA - G3B');
    assert.equal(blockedKeyIn(peer(chainPems.slice(1))), 'EM DV TLS CA - G3B');
  });

  it('passes a chain without a blocked key, including a lone self-issued root', () => {
    assert.equal(blockedKeyIn(peer([chainPems[0]!, chainPems[2]!])), undefined);
    assert.equal(blockedKeyIn(peer([tls.rootCertificates[0]!])), undefined);
  });

  it('refuses a blocked chain with CERT_REVOKED before the host name check, and asks the original check otherwise', () => {
    const calls: string[] = [];
    const original = (host: string) => { calls.push(host); return undefined; };
    const check = guardServerIdentity(original);
    const err = check('dv-g3b-emudhra.we-have-a-problem.com', peer(chainPems));
    assert.ok(err instanceof Error);
    assert.equal((err as NodeJS.ErrnoException).code, 'CERT_REVOKED');
    assert.match(err.message, /EM DV TLS CA - G3B/);
    assert.deepEqual(calls, [], 'a blocked chain never reaches the host name check');
    assert.equal(check('example.test', peer([tls.rootCertificates[0]!])), undefined);
    assert.deepEqual(calls, ['example.test']);
  });

  it('fails closed when the chain cannot be read', () => {
    const broken = { raw: Buffer.from('not a certificate'), subject: {} } as unknown as tls.DetailedPeerCertificate;
    const err = guardServerIdentity(() => undefined)('example.test', broken);
    assert.ok(err instanceof Error);
  });

  it('installs once on the tls module and wraps whatever check was there', () => {
    const fake = { checkServerIdentity: (_h: string, _c: tls.PeerCertificate): Error | undefined => undefined };
    assert.equal(installTlsBlocklist(fake), true);
    const first = fake.checkServerIdentity;
    assert.equal(installTlsBlocklist(fake), false, 'a second install is a no-op');
    assert.equal(fake.checkServerIdentity, first);
    assert.equal((fake.checkServerIdentity('x', peer(chainPems)) as NodeJS.ErrnoException | undefined)?.code, 'CERT_REVOKED');
  });

  it('is installed by the core entry before anything else can open a connection', () => {
    const core = readFileSync(fileURLToPath(new URL('../../src/bin/legion-core.ts', import.meta.url)), 'utf8');
    const imports = [...core.matchAll(/^import (?:.* from )?'([^']+)';$/gm)].map((m) => m[1]);
    assert.equal(imports[1], '../core/tls-blocklist-install.js', 'second import, right after the log redactor');
  });
});
