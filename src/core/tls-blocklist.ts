/**
 * A temporary block of the eight compromised eMudhra intermediate CA keys for the core's own outbound TLS (https, fetch).
 *
 * In October 2026 the private keys of eight eMudhra intermediate CAs (six TLS, two code signing) turned out to be recoverable:
 * anyone could use them to issue a trusted certificate for any host. Browsers block them through live lists. The core runs on
 * Electron's Node in a Windows package install and on plain Node.js everywhere else (Mac, Linux, source installs, LEGION_NODE),
 * and neither blocked them when this was written. This module blocks them for the core on any of those runtimes, as plain code,
 * so it reaches every install through a code-only update: it wraps tls.checkServerIdentity, which tls.connect (and so https and
 * fetch) calls for every verified server chain unless the caller passes its own check. A chain that contains one of the keys is
 * refused with CERT_REVOKED, the code Electron 44.9.1 and later use for the same chains in their own Node and Chromium.
 *
 * Limits: a caller that passes its own checkServerIdentity or turns verification off is not covered, and neither are the agent
 * CLIs Legion starts (they bring their own runtime). The app window is Chromium's: it needs Electron 44.9.1 or later. Remove this
 * module once every runtime the core runs on ships the same block (tracked in the release tracker).
 *
 * Opens no connection and imports no network module: tls-blocklist-install.ts puts the wrapper on node:tls (the one file
 * test/bsv-scan.ts allows the tls module for this).
 */
import { createHash, X509Certificate } from 'node:crypto';

/**
 * SHA-256 of the DER SubjectPublicKeyInfo -> the CA's name. The same eight hashes as Electron's patches (PR 55127) and the
 * incident tracker's impacted-intermediates.json; each key is shared by its emSign-issued and its Sectigo cross-signed certificate.
 */
export const BLOCKED_SPKI_SHA256: Readonly<Record<string, string>> = Object.freeze({
  ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105: 'EM DV TLS CA - G3B',
  '43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b': 'EM OV TLS CA - G3B',
  e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41: 'EM EV TLS CA - G3B',
  '49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f': 'EM DV TLS CA - G3C',
  '63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8': 'EM OV TLS CA - G3C',
  '5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0': 'EM EV TLS CA - G3C',
  ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6: 'EM OV CS CA - G3B',
  '92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30': 'EM OV CS CA - G3C',
});

/** The parts of a tls peer certificate this module reads: its DER bytes and, in a detailed chain, its issuer. */
export interface ChainCert { raw: Buffer; issuerCertificate?: ChainCert }

/** SHA-256 (hex) of a certificate's SubjectPublicKeyInfo, from the certificate's DER bytes. */
export function spkiSha256(der: Buffer): string {
  const spki = new X509Certificate(der).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex');
}

/** A peer chain whose links do not all verify: the walk would not be the chain the server was verified through. */
class ChainMismatch extends Error {}

/**
 * The name of the first blocked CA in a peer chain (leaf first, linked by issuerCertificate), or undefined.
 *
 * Node builds that chain for getPeerCertificate by matching names and key ids, not signatures, so a server holding a blocked key
 * can send a decoy with the blocked CA's name ahead of the real certificate: Node's walk takes the decoy while OpenSSL verifies
 * through the real one. So every link is checked: it must be signed by the next certificate's key. A certificate with the blocked
 * key is the only one that can sign for a blocked CA, and it is caught by its key. A walk may end without a root (Node does not
 * always find the root for a cross-signed one, e.g. Google Trust Services chains); the links up to there are still real.
 * Throws ChainMismatch when a link does not verify, and on a certificate it cannot read.
 */
export function blockedKeyIn(cert: ChainCert, blocked: Readonly<Record<string, string>> = BLOCKED_SPKI_SHA256): string | undefined {
  const seen = new Set<object>();
  let c: ChainCert | undefined = cert;
  let x = new X509Certificate(cert.raw);
  while (c && !seen.has(c)) {
    seen.add(c);
    const hit = blocked[spkiSha256(c.raw)];
    if (hit) return hit;
    const next: ChainCert | undefined = c.issuerCertificate;
    if (!next || next === c) return undefined; // the end of the walk, or a self-issued root
    const nx = new X509Certificate(next.raw);
    if (!x.verify(nx.publicKey)) throw new ChainMismatch(`the link from "${x.subject.replace(/\n/g, ', ')}" to "${nx.subject.replace(/\n/g, ', ')}" does not verify`);
    c = next; x = nx;
  }
  return undefined;
}

type ServerIdentityCheck = (host: string, cert: ChainCert) => Error | undefined;

/** Wraps a server identity check: a chain with a blocked key, a chain whose links do not verify, or one that cannot be read, is refused before the host name is checked. */
export function guardServerIdentity(original: ServerIdentityCheck): ServerIdentityCheck {
  return (host, cert) => {
    let hit: string | undefined;
    try { hit = blockedKeyIn(cert); } catch (e) {
      if (e instanceof ChainMismatch) return Object.assign(new Error(`Legion refuses the certificate chain of ${host}: ${e.message}.`), { code: 'ERR_TLS_CHAIN_MISMATCH' });
      return Object.assign(new Error(`Legion could not read the certificate chain of ${host}: ${e instanceof Error ? e.message : String(e)}`), { code: 'ERR_TLS_CERT_UNREADABLE' });
    }
    if (hit) return Object.assign(new Error(`The certificate chain of ${host} goes through ${hit}, a certificate authority whose key was compromised. Legion refuses it.`), { code: 'CERT_REVOKED' });
    return original(host, cert);
  };
}

const INSTALLED = Symbol.for('legion.tlsBlocklist');

/** Installs the guard on a tls module (the real one by default, see tls-blocklist-install.ts). Returns false when it is already there. */
export function installTlsBlocklist(tls: { checkServerIdentity(host: string, cert: ChainCert): Error | undefined }): boolean {
  const current = tls.checkServerIdentity as ServerIdentityCheck & { [INSTALLED]?: true };
  if (current[INSTALLED]) return false;
  const guarded = Object.assign(guardServerIdentity(current), { [INSTALLED]: true as const });
  tls.checkServerIdentity = guarded;
  return true;
}
