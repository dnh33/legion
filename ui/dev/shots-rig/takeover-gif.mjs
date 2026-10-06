// Renders the takeover animation (src/shared/takeover-art.ts, compiled to dist/) into the README GIF and a still PNG.
// Zero dependencies: the art is a pixel grid, so this rasterises it directly and encodes GIF (LZW) and PNG (zlib) itself.
// Seeded, so the same build gives the same file. Usage: npm run build:ts && node ui/dev/shots-rig/takeover-gif.mjs [outDir]
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const art = await import(pathToFileURL(join(ROOT, 'dist', 'src', 'shared', 'takeover-art.js')).href);
const OUT = process.argv[2] ?? join(ROOT, 'docs', 'images');
const SCALE = 10, PAD = 2;               // art pixels of margin around the canvas
const BG = [0x0b, 0x0f, 0x12];
const W = (art.CANVAS_W + PAD * 2) * SCALE, H = (art.CANVAS_H + PAD * 2) * SCALE;

const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/** One frame as an RGB buffer at art resolution (with margin), opacity blended like the SVG renderers. */
function raster(frame) {
  const w = art.CANVAS_W + PAD * 2, h = art.CANVAS_H + PAD * 2, buf = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) buf.set(BG, i * 3);
  for (const p of frame.pixels) {
    const x = p.x + PAD, y = p.y + PAD;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const o = (y * w + x) * 3, c = hex(p.color), a = p.opacity ?? 1;
    for (let k = 0; k < 3; k++) buf[o + k] = Math.round(c[k] * a + buf[o + k] * (1 - a));
  }
  return { w, h, buf };
}

// ---- GIF -----------------------------------------------------------------------------------------------------------------
function lzw(indices, minCode) {
  const clear = 1 << minCode, eoi = clear + 1, bytes = [];
  let size = minCode + 1, next = eoi + 1, dict = new Map(), acc = 0, nbits = 0;
  const emit = (code) => { acc |= code << nbits; nbits += size; while (nbits >= 8) { bytes.push(acc & 0xff); acc >>>= 8; nbits -= 8; } };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = prefix * 4096 + k;
    if (dict.has(key)) { prefix = dict.get(key); continue; }
    emit(prefix);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
    else { emit(clear); dict = new Map(); size = minCode + 1; next = eoi + 1; }
    prefix = k;
  }
  emit(prefix); emit(eoi);
  if (nbits > 0) bytes.push(acc & 0xff);
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) { const s = bytes.slice(i, i + 255); out.push(s.length, ...s); }
  out.push(0);
  return out;
}

function gif(frames, delayCs) {
  const colours = new Map();
  const indexed = frames.map(({ w, h, buf }) => {
    const idx = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (Math.floor(y / SCALE) * w + Math.floor(x / SCALE)) * 3, key = (buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2];
      if (!colours.has(key)) { if (colours.size >= 256) throw new Error('more than 256 colours'); colours.set(key, colours.size); }
      idx[y * W + x] = colours.get(key);
    }
    return idx;
  });
  let bits = 1; while ((1 << bits) < colours.size) bits++;
  const table = new Array((1 << bits) * 3).fill(0);
  for (const [key, i] of colours) table.splice(i * 3, 3, key >> 16, (key >> 8) & 0xff, key & 0xff);
  const minCode = Math.max(2, bits);
  const b = [...Buffer.from('GIF89a'), W & 0xff, W >> 8, H & 0xff, H >> 8, 0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0, ...table,
    0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0, 0, 0];               // loop forever
  frames.forEach((_, n) => {
    const d = delayCs[n];
    b.push(0x21, 0xf9, 0x04, 0, d & 0xff, d >> 8, 0, 0);                                     // frame delay
    b.push(0x2c, 0, 0, 0, 0, W & 0xff, W >> 8, H & 0xff, H >> 8, 0, minCode, ...lzw(indexed[n], minCode));
  });
  b.push(0x3b);
  return Buffer.from(b);
}

// ---- PNG -----------------------------------------------------------------------------------------------------------------
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const x of buf) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png({ w, buf }) {
  const raw = Buffer.alloc(H * (W * 3 + 1));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (Math.floor(y / SCALE) * w + Math.floor(x / SCALE)) * 3;
    raw.set(buf.subarray(o, o + 3), y * (W * 3 + 1) + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- render --------------------------------------------------------------------------------------------------------------
const tl = art.FULL, n = art.loopTicks(tl);
const frames = [], delays = [];
for (let t = 0; t < n; t++) {
  frames.push(raster(art.frameAt(tl, t, art.seeded(1000 + t))));
  delays.push(t === n - 1 ? 120 : Math.round(tl.tickMs / 10)); // hold the last frame a little longer before the loop
}
mkdirSync(OUT, { recursive: true });
const g = gif(frames, delays), still = png(raster(art.stillFrame()));
writeFileSync(join(OUT, 'legion-takeover.gif'), g);
writeFileSync(join(OUT, 'legion-takeover.png'), still);
console.log(`[takeover-gif] ${n} frames, ${W}x${H}: legion-takeover.gif ${(g.length / 1024).toFixed(0)} KB, legion-takeover.png ${(still.length / 1024).toFixed(0)} KB -> ${OUT}`);
