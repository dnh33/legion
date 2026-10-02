import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

// Test fixtures for the Node bootstrap: a tiny zip writer and a fake nodejs.org on 127.0.0.1. Not a test file itself.
export const PIN = '24.21.0';
export const ZIP_NAME = `node-v${PIN}-win-x64.zip`;

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** A plain zip. Names are written exactly as given (so '../x' and absolute names can be tested). */
export function makeZip(entries: Array<{ name: string; data?: Buffer }>): Buffer {
  const parts: Buffer[] = []; const cen: Buffer[] = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'); const raw = e.data ?? Buffer.alloc(0);
    const comp = raw.length ? deflateRawSync(raw) : raw; const method = raw.length ? 8 : 0; const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    cen.push(ch, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(cen); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** What the fake "node.exe" is: a tiny script that prints a version (Linux), or a copy of the running node (Windows, where a script cannot be an .exe). */
export function fakeNodeExe(): Buffer {
  return process.platform === 'win32' ? Buffer.from(readFileSyncSafe(process.execPath)) : Buffer.from(`#!/bin/sh\necho v${PIN}\n`);
}
import { readFileSync } from 'node:fs';
const readFileSyncSafe = (p: string): Buffer => readFileSync(p);

export function goodNodeZip(exe: Buffer = fakeNodeExe()): Buffer {
  const top = `node-v${PIN}-win-x64`;
  return makeZip([
    { name: `${top}/` },
    { name: `${top}/node.exe`, data: exe },
    { name: `${top}/npm.cmd`, data: Buffer.from('@echo 10.0.0\r\n') },
    { name: `${top}/npm`, data: Buffer.from('#!/bin/sh\necho 10.0.0\n') },
    { name: `${top}/README.md`, data: Buffer.from('hello') },
  ]);
}

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export type Mode = 'good' | 'badsha' | 'truncated' | 'oversize' | 'redirect' | 'slip' | 'nosums';
export interface Fake { server: Server; url: string; hits: string[]; setMode(m: Mode, zip?: Buffer): void; close(): Promise<void> }

export async function startFakeNode(zipDefault: Buffer): Promise<Fake> {
  let mode: Mode = 'good'; let zip = zipDefault; const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? ''; hits.push(path);
    const dir = `/dist/v${PIN}/`;
    if (path === `${dir}SHASUMS256.txt`) {
      if (mode === 'nosums') { res.writeHead(200); res.end(`${'a'.repeat(64)}  some-other-file.zip\n`); return; }
      const sum = mode === 'badsha' ? 'f'.repeat(64) : sha256(zip);
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`${'0'.repeat(64)}  node-v${PIN}-linux-x64.tar.gz\n${sum}  ${ZIP_NAME}\n`); return;
    }
    if (path === `${dir}${ZIP_NAME}`) {
      if (mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:9/evil.zip' }); res.end(); return; }
      if (mode === 'truncated') { res.writeHead(200, { 'content-length': String(zip.length) }); res.write(zip.subarray(0, Math.floor(zip.length / 2))); setTimeout(() => res.destroy(), 20); return; }
      if (mode === 'oversize') { res.writeHead(200, { 'content-length': String(10 * 1024 * 1024) }); res.end(Buffer.alloc(1024)); return; }
      res.writeHead(200, { 'content-length': String(zip.length) }); res.end(zip); return;
    }
    res.writeHead(404); res.end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    server, url: `http://127.0.0.1:${port}`, hits,
    setMode(m, z) { mode = m; if (z) zip = z; },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** A fake `node` + `npm` on a folder that goes on PATH. Prints the given version. */
export function fakeSystemNode(dir: string, version: string, withNpm = true): void {
  mkdirSync(dir, { recursive: true });
  const w = (name: string, body: string): void => { const p = join(dir, name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); chmodSync(p, 0o755); };
  if (process.platform === 'win32') { w('node.cmd', `@echo v${version}\r\n`); if (withNpm) w('npm.cmd', '@echo 10.0.0\r\n'); }
  else { w('node', `#!/bin/sh\necho v${version}\n`); if (withNpm) w('npm', '#!/bin/sh\necho 10.0.0\n'); }
}
