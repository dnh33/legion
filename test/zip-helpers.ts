import { deflateRawSync } from 'node:zlib';
import { crc32Update } from '../src/core/blender/zip.js';

// ---------------------------------------------------------------- a tiny zip writer (stored or deflate), with the knobs the attacks need
export interface ZEntry { name: string; data?: Buffer; method?: 0 | 8; flags?: number; unixMode?: number; crc?: number; usize?: number; csize?: number }
export function makeZip(entries: ZEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const raw = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 0;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, 'utf8');
    const crc = e.crc ?? crc32Update(0, raw);
    const csize = e.csize ?? body.length;
    const usize = e.usize ?? raw.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.flags ?? 0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(((e.unixMode ? 3 : 0) << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(e.flags ?? 0, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(e.unixMode ? (e.unixMode << 16) >>> 0 : 0, 38); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

