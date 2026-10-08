/** Shared fixtures for the updater tests: test-time key pairs only, a fake release server on 127.0.0.1, a tiny zip writer. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { assetNameFor, fullAssetNameFor, MANIFEST_NAME, SIG_NAME, type UpdateSource } from '../src/core/updater/config.js';
import type { UpdateKey } from '../src/core/updater/trust.js';

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

export interface TestKey { id: string; key: UpdateKey; sign(bytes: Buffer): string }
export function makeKey(id = 'test-1'): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    id,
    key: { id, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    sign: (bytes) => sign(null, bytes, privateKey).toString('hex'),
  };
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export interface ZipFile { name: string; data?: Buffer | string; dir?: boolean; symlink?: boolean }
/** A minimal zip (deflate) writer for fixtures. Names are written exactly as given, so hostile names can be tested. */
export function makeZip(files: ZipFile[]): Buffer {
  const parts: Buffer[] = [];
  const cen: Buffer[] = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = f.dir ? Buffer.alloc(0) : Buffer.from(f.data ?? '');
    const comp = f.dir || raw.length === 0 ? raw : deflateRawSync(raw);
    const method = comp === raw ? 0 : 8;
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((f.symlink ? 3 : 0) << 8 | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(f.symlink ? (0o120777 << 16) >>> 0 : 0, 38); ch.writeUInt32LE(off, 42);
    cen.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(cen);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

export const LOCK = '{"name":"legion","lockfileVersion":3}\n';

/** The files of a valid app package for `version`, all under legion-<version>/. */
export function packageFiles(version: string, over: { lock?: string; extra?: ZipFile[]; drop?: string[]; pkgVersion?: string } = {}): ZipFile[] {
  const top = `legion-${version}/`;
  const f: ZipFile[] = [
    { name: `${top}package.json`, data: JSON.stringify({ name: 'legion', version: over.pkgVersion ?? version }) },
    { name: `${top}package-lock.json`, data: over.lock ?? LOCK },
    { name: `${top}dist/src/electron/main.js`, data: '// main' },
    { name: `${top}dist/src/bin/legion-core.js`, data: '// core' },
    { name: `${top}dist-ui/index.html`, data: '<html></html>' },
    { name: `${top}assets/icon.png`, data: 'png' },
    { name: `${top}build-info.json`, data: '{}' },
  ];
  return [...f.filter((x) => !(over.drop ?? []).some((d) => x.name === top + d)), ...(over.extra ?? [])];
}

/** The two executables a Legion full package must ship (mirrors scripts/lib/package-lib.mjs ELECTRON_REL / CLAUDE_REL). */
const FULL_EXES = ['runtime/electron/electron.exe', 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'];
/** The files of a valid FULL package for `version`: the app files plus node_modules, runtime and PACKAGE-FILES.json. */
export function fullPackageFiles(version: string, over: { lock?: string; extra?: ZipFile[]; drop?: string[]; pkgVersion?: string } = {}): ZipFile[] {
  const top = `legion-${version}/`;
  const files: ZipFile[] = [
    ...packageFiles(version, over),
    { name: `${top}node_modules/electron/index.js`, data: '// electron' },
    { name: `${top}node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`, data: 'MZ claude' },
    { name: `${top}runtime/electron/electron.exe`, data: 'MZ electron' },
    { name: `${top}PACKAGE-FILES.json`, data: JSON.stringify({ schema: 1, files: FULL_EXES.map((p) => ({ path: p, size: 1, sha256: '0'.repeat(64) })) }) },
  ];
  return files.filter((x) => !(over.drop ?? []).some((d) => x.name === top + d));
}

export interface Release { version: string; zip: Buffer; fullZip?: Buffer; manifest: Buffer; sig: string; manifestObj: Record<string, unknown> }
export function makeRelease(k: TestKey, version: string, o: { files?: ZipFile[]; manifest?: Record<string, unknown>; lock?: string; publishedAt?: string; signWith?: TestKey; requiresFullInstall?: boolean; full?: { files?: ZipFile[]; drop?: string[]; pkgVersion?: string } } = {}): Release {
  const lock = o.lock ?? LOCK;
  const zip = makeZip(o.files ?? packageFiles(version, o.lock !== undefined ? { lock } : {}));
  // A signed full package exists only when the caller asks for one. `depsSha256` is the app lock's raw hash, so the
  // full package must carry the SAME lock bytes or checkFullTree refuses it (this mirrors the real release scripts).
  const fullZip = o.full ? makeZip(o.full.files ?? fullPackageFiles(version, { lock, ...o.full })) : undefined;
  const manifestObj = {
    schema: 1, product: 'legion', channel: 'stable', version, publishedAt: o.publishedAt ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    asset: { name: assetNameFor(version), size: zip.length, sha256: sha256(zip) },
    ...(fullZip ? { fullAsset: { name: fullAssetNameFor(version), size: fullZip.length, sha256: sha256(fullZip) } } : {}),
    depsSha256: sha256(lock), requiresFullInstall: o.requiresFullInstall ?? false, notes: 'Test notes <b>x</b>', ...o.manifest,
  };
  const manifest = Buffer.from(JSON.stringify(manifestObj, null, 2) + '\n');
  const signer = o.signWith ?? k;
  return { version, zip, ...(fullZip ? { fullZip } : {}), manifest, manifestObj, sig: JSON.stringify({ keyId: signer.id, alg: 'ed25519', sig: signer.sign(manifest) }) };
}

export interface FakeServer { url: string; source: UpdateSource; hits: string[]; close(): Promise<void>; setRelease(r: Release | null): void; handler: { custom?: (req: IncomingMessage, res: ServerResponse) => boolean } }
/** A fake GitHub on loopback: /releases/latest/download/<manifest|sig>, /releases/download/v<ver>/<asset>. `custom` can take over any request. */
export async function startFakeServer(initial: Release | null): Promise<FakeServer> {
  let rel = initial;
  const hits: string[] = [];
  const handler: FakeServer['handler'] = {};
  const srv: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (handler.custom?.(req, res)) return;
    const u = req.url ?? '';
    if (rel && u === `/releases/latest/download/${MANIFEST_NAME}`) { res.writeHead(200, { 'content-length': rel.manifest.length }); res.end(rel.manifest); return; }
    if (rel && u === `/releases/latest/download/${SIG_NAME}`) { res.writeHead(200); res.end(rel.sig); return; }
    if (rel && u === `/releases/download/v${rel.version}/${assetNameFor(rel.version)}`) { res.writeHead(200, { 'content-length': rel.zip.length }); res.end(rel.zip); return; }
    if (rel && rel.fullZip && u === `/releases/download/v${rel.version}/${fullAssetNameFor(rel.version)}`) { res.writeHead(200, { 'content-length': rel.fullZip.length }); res.end(rel.fullZip); return; }
    res.writeHead(404); res.end('no');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url, hits, handler,
    source: { base: url, policy: { hosts: ['127.0.0.1'], allowLoopbackHttp: true } },
    setRelease: (r) => { rel = r; },
    close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}
