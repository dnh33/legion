// A deterministic zip writer that does not hold the archive in memory (the full package is about 700 MB unpacked).
// Same fixed fields as writeZip in release-lib.mjs: DOS date 1980-01-01, no extra fields, no comments, method 0 or 8.
// Entries must come sorted by name (plain code-unit order) and unique, so the same input always gives the same bytes.
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export const ZIP_LIMITS = Object.freeze({ entries: 60_000, bytes: 0xfffffffe });

/**
 * entries: [{ name, data?: Buffer, file?: string, mode?: number }] sorted ascending by name. `file` is read when its turn comes (one file in memory at a time).
 * Writes <out>.part and renames it to <out> at the end. Returns { size, sha256, entries }.
 */
export function writeZipFile(out, entries) {
  if (entries.length > ZIP_LIMITS.entries) throw new Error(`too many entries (${entries.length})`);
  for (let i = 1; i < entries.length; i++) if (!(entries[i - 1].name < entries[i].name)) throw new Error(`entries are not sorted and unique at "${entries[i].name}"`);
  const part = `${out}.part`;
  const fd = openSync(part, 'w');
  const hash = createHash('sha256');
  let off = 0;
  const emit = (b) => { writeSync(fd, b); hash.update(b); off += b.length; if (off > ZIP_LIMITS.bytes) throw new Error('the archive is over 4 GiB (zip64 is not written)'); };
  const cen = [];
  try {
    for (const e of entries) {
      const name = Buffer.from(e.name, 'utf8');
      if (name.length > 0xffff) throw new Error(`name too long: ${e.name.slice(0, 40)}`);
      const raw = e.data ?? readFileSync(e.file);
      const comp = raw.length ? deflateRawSync(raw, { level: 6 }) : raw;
      const method = raw.length ? 8 : 0;
      const crc = crc32(raw);
      const localOffset = off;
      const flags = /^[\x20-\x7e]*$/.test(e.name) ? 0 : 0x800;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
      emit(lh); emit(name); if (comp.length) emit(comp);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
      ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(localOffset, 42);
      cen.push(ch, name);
    }
    const cd = Buffer.concat(cen);
    const cdOffset = off;
    emit(cd);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(cdOffset, 16);
    emit(end);
  } catch (e) { try { closeSync(fd); } catch { /* ignore */ } rmSync(part, { force: true }); throw e; }
  closeSync(fd);
  renameSync(part, out);
  return { size: off, sha256: hash.digest('hex'), entries: entries.length };
}
