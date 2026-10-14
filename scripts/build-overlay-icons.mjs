// Dev-only generator: draws the Windows taskbar number icons (assets/overlay/overlay-<key>-<px>.png). Outputs are committed; end users never run this.
// No dependencies: shapes are rasterised here with 8x8 supersampling and written as RGBA PNG. Three sizes per number so the taskbar picks a crisp one
// at 100% (16 px), 125% (20 px) and 150% (24 px) display scale. Amber badge (the colour that means "needs you" everywhere in Legion), dark digits,
// and a thin dark ring so the badge reads on both a dark and a light taskbar. Run: node scripts/build-overlay-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'overlay');
mkdirSync(out, { recursive: true });

const SIZES = [16, 20, 24];
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '9plus'];
const BADGE = [255, 204, 102]; // --warn
const INK = [11, 13, 16]; // --bg
const SS = 8;

// Seven-segment strokes in a unit box (x 0..1, y 0..1, y down). Segment ends are inset so corners do not blob.
const SEG = {
  a: [[0, 0], [1, 0]], b: [[1, 0], [1, 0.5]], c: [[1, 0.5], [1, 1]], d: [[0, 1], [1, 1]], e: [[0, 0.5], [0, 1]], f: [[0, 0], [0, 0.5]], g: [[0, 0.5], [1, 0.5]],
};
const DIGIT = { 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };

/** Distance from point p to segment ab. */
function dist(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Strokes (in pixels) for a key at size S: list of {a:[x,y], b:[x,y], w}. */
function strokes(key, S) {
  const list = [];
  const glyph = (digit, cx0, cy, h, w, sw) => {
    const cx = digit === '1' ? cx0 - w / 2 : cx0; // a 1 is drawn on the right-hand segments: centre it
    for (const s of DIGIT[digit]) {
      const [[x1, y1], [x2, y2]] = SEG[s];
      list.push({ a: [cx - w / 2 + x1 * w, cy - h / 2 + y1 * h], b: [cx - w / 2 + x2 * w, cy - h / 2 + y2 * h], w: sw });
    }
  };
  if (key === '9plus') {
    const h = S * 0.5; const w = S * 0.24; const sw = Math.max(1.4, S * 0.1);
    glyph('9', S * 0.34, S * 0.5, h, w, sw);
    const px = S * 0.73; const py = S * 0.5; const r = S * 0.1;
    list.push({ a: [px - r, py], b: [px + r, py], w: sw }, { a: [px, py - r], b: [px, py + r], w: sw });
  } else {
    const h = S * 0.6; const w = S * 0.36; const sw = Math.max(1.6, S * 0.12);
    glyph(key, S / 2, S * 0.5, h, w, sw);
  }
  return list;
}

function render(key, S) {
  const px = Buffer.alloc(S * S * 4);
  const R = S / 2 - 0.25; const ring = Math.max(0.9, S / 24);
  const st = strokes(key, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let cov = 0; let ink = 0; let rim = 0;
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          const sx = x + (i + 0.5) / SS; const sy = y + (j + 0.5) / SS;
          const d = Math.hypot(sx - S / 2, sy - S / 2);
          if (d > R) continue;
          cov++;
          if (d > R - ring) rim++;
          else if (st.some((s) => dist(sx, sy, s.a[0], s.a[1], s.b[0], s.b[1]) <= s.w / 2)) ink++;
        }
      }
      const n = SS * SS;
      if (!cov) continue;
      const dark = (ink + rim * 0.8) / cov; // 0..1 share of dark inside the covered part
      const o = (y * S + x) * 4;
      px[o] = Math.round(BADGE[0] * (1 - dark) + INK[0] * dark);
      px[o + 1] = Math.round(BADGE[1] * (1 - dark) + INK[1] * dark);
      px[o + 2] = Math.round(BADGE[2] * (1 - dark) + INK[2] * dark);
      px[o + 3] = Math.round((cov / n) * 255);
    }
  }
  return px;
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(S, rgba) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

for (const key of KEYS) for (const S of SIZES) writeFileSync(join(out, `overlay-${key}-${S}.png`), png(S, render(key, S)));
// A contact sheet for looking at the icons enlarged (not shipped; written next to the icons only when asked).
if (process.argv[2] === '--sheet') {
  const Z = 10; const cell = 24 * Z + 8; const W = cell * KEYS.length; const H = cell * SIZES.length;
  const sheet = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { const dark = ((i % W) / cell | 0) % 2; const v = dark ? 32 : 235; sheet[i * 4] = sheet[i * 4 + 1] = sheet[i * 4 + 2] = v; sheet[i * 4 + 3] = 255; }
  KEYS.forEach((key, ki) => SIZES.forEach((S, si) => {
    const p = render(key, S);
    for (let y = 0; y < S * Z; y++) for (let x = 0; x < S * Z; x++) {
      const s = ((y / Z | 0) * S + (x / Z | 0)) * 4; const a = p[s + 3] / 255;
      const o = ((si * cell + 4 + y) * W + ki * cell + 4 + x) * 4;
      for (let c = 0; c < 3; c++) sheet[o + c] = Math.round(p[s + c] * a + sheet[o + c] * (1 - a));
    }
  }));
  writeFileSync(process.argv[3] ?? 'overlay-sheet.png', png2(W, H, sheet));
}
function png2(W, H, rgba) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
