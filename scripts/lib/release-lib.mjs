// Shared helpers of the release scripts (owner-run, plain Node). The signing key never lives in the repo: scripts refuse key paths inside it.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function args(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) die(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (!(k in spec)) die(`unknown option --${k}`);
    if (spec[k] === 'flag') out[k] = true; else { out[k] = argv[++i]; if (out[k] === undefined) die(`--${k} needs a value`); }
  }
  return out;
}
export function die(msg) { console.error(`error: ${msg}`); process.exit(1); }

/** True when `p` is inside this repo or inside any git work tree (a folder with .git above it). */
export function insideGitTree(p) {
  const abs = resolve(p);
  if (abs === REPO || abs.startsWith(REPO + sep)) return true;
  for (let d = abs; ; d = dirname(d)) { if (existsSync(join(d, '.git'))) return true; if (dirname(d) === d) return false; }
}

export async function loadDist(rel) { return import(pathToFileURL(join(REPO, 'dist', rel)).href); }

// ---- zip: deterministic writer (fixed DOS date, sorted by the caller) and a reader of single entries
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** entries: [{ name, data: Buffer }] in the order to write. Fixed timestamp (1980-01-01), so the same input gives the same bytes. */
export function writeZip(entries) {
  const parts = []; const cen = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'); const raw = e.data; const comp = raw.length ? deflateRawSync(raw, { level: 9 }) : raw;
    const method = raw.length ? 8 : 0; const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    cen.push(ch, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(cen); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
/** The bytes of one entry of a zip written by writeZip (or any plain, non-zip64 zip), or undefined. */
export function readZipEntry(zip, wanted) {
  let at = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { at = i; break; }
  if (at < 0) return undefined;
  const total = zip.readUInt16LE(at + 10); let p = zip.readUInt32LE(at + 16);
  for (let n = 0; n < total; n++) {
    const method = zip.readUInt16LE(p + 10); const csize = zip.readUInt32LE(p + 20); const nl = zip.readUInt16LE(p + 28); const xl = zip.readUInt16LE(p + 30); const cl = zip.readUInt16LE(p + 32); const lo = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nl).toString('utf8'); p += 46 + nl + xl + cl;
    if (name !== wanted) continue;
    const start = lo + 30 + zip.readUInt16LE(lo + 26) + zip.readUInt16LE(lo + 28);
    const body = zip.subarray(start, start + csize);
    return method === 8 ? inflateRawSync(body) : body;
  }
  return undefined;
}
export const readText = (p) => readFileSync(p, 'utf8');
/** Entry names of a plain zip, in order. */
export function listZipNames(zip) {
  let at = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { at = i; break; }
  if (at < 0) return [];
  const total = zip.readUInt16LE(at + 10); let p = zip.readUInt32LE(at + 16); const names = [];
  for (let n = 0; n < total; n++) { const nl = zip.readUInt16LE(p + 28); names.push(zip.subarray(p + 46, p + 46 + nl).toString('utf8')); p += 46 + nl + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32); }
  return names;
}
