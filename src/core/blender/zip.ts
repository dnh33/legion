/**
 * A small, strict zip extractor for the one archive Legion may unpack itself (the pinned portable Blender). Pure: the archive is read through a
 * ZipSource and files are written through a ZipSink, so tests run on in-memory fakes and no program is started (no tar, no unzip).
 *
 * What it refuses, before it writes anything: an entry name that is absolute, has a drive letter or a colon, climbs out with "..", ends in a dot or
 * a space, names a Windows device, holds a NUL, is a symbolic link, is encrypted, uses a method other than stored/deflate, repeats another entry
 * (case-insensitively), or sits outside the one expected top folder; more entries or more unpacked bytes than the caps; zip64 archives. While
 * unpacking, an entry that inflates past its declared size, or whose CRC-32 differs, fails the whole run (the caller deletes the staging folder).
 * What it does not do: it cannot tell a good executable from a bad one (the sha256 of the archive is checked by the caller before this runs), and
 * it does not apply file permissions or timestamps.
 */
import { posix, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

export interface ZipSource {
  size: number;
  /** Bytes [offset, offset+length) of the archive. */
  read(offset: number, length: number): Promise<Buffer>;
  /** A stream of bytes [start, endInclusive]. */
  stream(start: number, endInclusive: number): Readable;
}
export interface ZipSink {
  mkdirp(absDir: string): void;
  /** Opens a NEW file for writing (it must not exist; the staging folder is fresh). */
  openWrite(absFile: string): Writable;
}
export interface ZipLimits { maxEntries: number; maxUnpackedBytes: number }
export interface ZipEntry { name: string; rel: string; dir: boolean; method: number; crc: number; csize: number; usize: number; localOffset: number }

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

export class ZipError extends Error {}

/** The relative path to extract an entry to, or a ZipError. `topDir` is the one folder every entry must be under. */
export function safeEntryPath(raw: string, topDir: string): { rel: string; dir: boolean } {
  if (!raw || /[\0]/.test(raw)) throw new ZipError('an entry has an empty or invalid name');
  const name = raw.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new ZipError(`an entry has an absolute path: ${shown(raw)}`);
  if (name.includes(':')) throw new ZipError(`an entry name contains a colon: ${shown(raw)}`);
  const dir = name.endsWith('/');
  const parts = name.split('/').filter((p) => p !== '');
  if (!parts.length) throw new ZipError('an entry has an empty name');
  for (const p of parts) {
    if (p === '..') throw new ZipError(`an entry climbs out of the target folder: ${shown(raw)}`);
    if (p === '.' ) throw new ZipError(`an entry has a "." segment: ${shown(raw)}`);
    if (/[. ]$/.test(p)) throw new ZipError(`an entry name ends in a dot or a space (Windows would rename it): ${shown(raw)}`);
    if (DEVICE.test(p)) throw new ZipError(`an entry names a Windows device: ${shown(raw)}`);
    if (/[<>"|?*\u0001-\u001f]/.test(p)) throw new ZipError(`an entry name has a character Windows does not allow: ${shown(raw)}`);
  }
  const rel = posix.normalize(parts.join('/'));
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('/')) throw new ZipError(`an entry climbs out of the target folder: ${shown(raw)}`);
  if (rel !== topDir && !rel.startsWith(`${topDir}/`)) throw new ZipError(`an entry is outside the expected folder ${topDir}: ${shown(raw)}`);
  return { rel, dir };
}
const shown = (s: string): string => JSON.stringify(s.length > 80 ? `${s.slice(0, 80)}...` : s);

/** The absolute target of `rel` under `root`, or a ZipError when it would not stay inside (a second check after safeEntryPath). */
export function targetInside(root: string, rel: string): string {
  const base = resolve(root);
  const abs = resolve(base, ...rel.split('/'));
  if (abs !== base && !abs.startsWith(base.endsWith(sep) ? base : base + sep)) throw new ZipError(`refusing to write outside the target folder: ${shown(rel)}`);
  return abs;
}

/** Reads the central directory. Throws ZipError for anything the extractor will not handle. */
export async function listEntries(src: ZipSource, topDir: string, limits: ZipLimits): Promise<ZipEntry[]> {
  if (src.size < 22) throw new ZipError('the file is too small to be a zip archive');
  const tailLen = Math.min(src.size, 65557);
  const tail = await src.read(src.size - tailLen, tailLen);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === SIG_EOCD) { at = i; break; }
  if (at < 0) throw new ZipError('not a zip archive (no end-of-directory record)');
  const total = tail.readUInt16LE(at + 10);
  const cdSize = tail.readUInt32LE(at + 12);
  const cdOffset = tail.readUInt32LE(at + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('zip64 archives are not supported');
  if (total > limits.maxEntries) throw new ZipError(`the archive has ${total} entries, more than the limit of ${limits.maxEntries}`);
  if (cdOffset + cdSize > src.size) throw new ZipError('the central directory is outside the file');
  const cd = await src.read(cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let p = 0;
  let unpacked = 0;
  for (let n = 0; n < total; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CEN) throw new ZipError('the central directory is damaged');
    const madeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const csize = cd.readUInt32LE(p + 20);
    const usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const ext = cd.readUInt32LE(p + 38);
    const localOffset = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen > cd.length) throw new ZipError('the central directory is damaged');
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new ZipError(`an entry is encrypted: ${shown(name)}`);
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('zip64 entries are not supported');
    const { rel, dir } = safeEntryPath(name, topDir);
    // made-by host 3 = Unix: the high 16 bits of the external attributes are st_mode; a symbolic link must never be unpacked
    if ((madeBy >> 8) === 3 && ((ext >>> 16) & 0o170000) === 0o120000) throw new ZipError(`an entry is a symbolic link: ${shown(name)}`);
    if (!dir && method !== 0 && method !== 8) throw new ZipError(`an entry uses compression method ${method}, which is not supported: ${shown(name)}`);
    const key = rel.toLowerCase();
    if (seen.has(key)) throw new ZipError(`the archive lists the same path twice: ${shown(name)}`);
    seen.add(key);
    unpacked += usize;
    if (unpacked > limits.maxUnpackedBytes) throw new ZipError(`the archive would unpack to more than ${Math.round(limits.maxUnpackedBytes / 1e6)} MB`);
    entries.push({ name, rel, dir, method, crc, csize, usize, localOffset });
  }
  // a path may not be both a file and the parent folder of another entry
  const files = new Set(entries.filter((e) => !e.dir).map((e) => e.rel.toLowerCase()));
  for (const e of entries) {
    let parent = posix.dirname(e.rel);
    while (parent && parent !== '.' && parent !== '/') {
      if (files.has(parent.toLowerCase())) throw new ZipError(`an entry is both a file and a folder: ${shown(parent)}`);
      parent = posix.dirname(parent);
    }
  }
  return entries;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export const crc32Update = (crc: number, buf: Buffer): number => {
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
};

/** Counts bytes and the CRC-32; fails when more than `limit` bytes pass. */
class Meter extends Transform {
  bytes = 0;
  crc = 0;
  constructor(private readonly limit: number, private readonly onBytes: (n: number) => void) { super(); }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) { cb(new ZipError('an entry unpacks to more than its declared size')); return; }
    try { this.onBytes(chunk.length); } catch (e) { cb(e as Error); return; }
    this.crc = crc32Update(this.crc, chunk);
    cb(null, chunk);
  }
}

/**
 * Unpacks every entry under `destRoot` (which should be a fresh staging folder). Throws on the first problem; the caller removes the folder.
 * Returns the number of files written.
 */
export async function extractZip(src: ZipSource, sink: ZipSink, destRoot: string, topDir: string, limits: ZipLimits): Promise<{ files: number; bytes: number }> {
  const entries = await listEntries(src, topDir, limits);
  // every target is resolved and checked before anything is written
  const planned = entries.map((e) => ({ e, abs: targetInside(destRoot, e.rel) }));
  sink.mkdirp(resolve(destRoot));
  let files = 0;
  let total = 0;
  for (const { e, abs } of planned) {
    if (e.dir) { sink.mkdirp(abs); continue; }
    const head = await src.read(e.localOffset, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== SIG_LOC) throw new ZipError(`a local header is damaged: ${shown(e.name)}`);
    const start = e.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    if (start + e.csize > src.size) throw new ZipError(`an entry runs past the end of the file: ${shown(e.name)}`);
    sink.mkdirp(resolve(abs, '..'));
    const meter = new Meter(e.usize, (n) => { total += n; if (total > limits.maxUnpackedBytes) throw new ZipError('the archive unpacks to more than the size limit'); });
    const out = sink.openWrite(abs);
    if (e.csize === 0 && e.usize === 0) { await new Promise<void>((res, rej) => { out.on('error', rej); out.end(res); }); files++; continue; }
    const raw = src.stream(start, start + e.csize - 1);
    if (e.method === 8) await pipeline(raw, createInflateRaw(), meter, out);
    else await pipeline(raw, meter, out);
    if (meter.bytes !== e.usize) throw new ZipError(`an entry is shorter than its declared size: ${shown(e.name)}`);
    if (meter.crc !== e.crc) throw new ZipError(`an entry fails its CRC-32 check: ${shown(e.name)}`);
    files++;
  }
  return { files, bytes: total };
}
