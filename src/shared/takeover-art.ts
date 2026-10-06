/**
 * "The Legion is taking over Claude": the takeover animation as pure data and pure functions, one source for every place it is
 * drawn (the boot splash, the title-bar egg, the README GIF). A critter in Claude Code's orange idles, glitches and is converted,
 * right to left, into the Legion great helm in the style of assets/icon.ico (steel, green T-visor, gold laurels and circuits, red
 * plume, binary ring). No DOM here: a renderer asks for the pixels of tick t and draws them.
 *
 * The critter is drawn by hand in Legion's palette and is only ever the "before" state; Legion's mascot is the helm.
 * Reference prototype the owner approved: docs/art/takeover-prototype.html. Spec: claude/spec-legion-takeover.md.
 */

/** Canvas size in art pixels. */
export const CANVAS_W = 34;
export const CANVAS_H = 32;

export const PALETTE: Readonly<Record<string, string>> = {
  S: '#9aa3ad', s: '#5d6672', K: '#05070a', G: '#e6c36a', g: '#b8913f', L: '#c9a24b', N: '#2fd28a', V: '#06231a', E: '#b6ffd6',
  n: '#0f5a3c', P: '#e0353f', p: '#8e1a22', O: '#D97757', o: '#A8502F', R: '#7CFFB2', r: '#0f5a3c',
};
/** Colour-split ghosts and the torn seam. */
export const GLITCH_RED = '#ff2a6d';
export const GLITCH_CYAN = '#00e5ff';

export const HELM_ROWS: readonly string[] = [
  '................PPP.......', '..............PPpPPP......', '.............PPp...P......', '...........KGGPK..........',
  '.........KKGgRgGKK........', '.......KKSSSGGGSSSKK......', '......KSSSSsSSSsSSSSK.....', '.....KSSSSSsSSSsSSSSSK....',
  '....KLSSSSSSSSSSSSSSSLK...', '...KLLSSSSSSSSSSSSSSSLLK..', '...KLSSgSSSSSSSSSSSgSSLK..', '...KSSNNNNNNNNNNNNNNNSSK..',
  '...KSSNVVEEVVVVVEEVVNSSK..', '...KSSNVVEEVVVVVEEVVNSSK..', '...KSSNNNNNNVVVNNNNNNSSK..', '...KSSSgSSSNVVVNSSSgSSSK..',
  '...KSSSgggSNVVVNSgggSSSK..', '...KSSSSSgSNVVVNSgSSSSSK..', '...KsSSSSSSNVVVNSSSSSSsK..', '...KssSSSSSNNNNNSSSSSssK..',
  '....KssSSSSSSGSSSSSSssK...', '.....KKsssssssssssssKK....', '.......KKKKKKKKKKKKK......', '........nnnnnnnnnnn.......',
];
export const CRITTER_ROWS: readonly string[] = [
  '...OOOOOOOOOOOO...', '...OOOOOOOOOOOO...', '...OOKOOOOOOKOO...', '...OOKOOOOOOKOO...', 'OOOOOOOOOOOOOOOOOO', 'OOOOOOOOOOOOOOOOOO',
  '...OOOOOOOOOOOO...', '...OOOOOOOOOOOO...', '...O.O.O..O.O.O...', '...O.O.O..O.O.O...',
];
const HELM_AT = { x: 4, y: 4 };
const CRITTER_AT = { x: 8, y: 13 };
const RING = { cx: 16.5, cy: 15.5, outer: 15, inner: 13 };
const RING_BITS = '1011001110100101110010110100111010';

export const HEADLINE_IDLE = 'claude code ready.';
export const HEADLINE_TAKING = 'THE LEGION IS TAKING OVER CLAUDE';
export const HEADLINE_TAKEN = 'THE LEGION HAS TAKEN CLAUDE';

/** Phases in ticks. `hold` Infinity: stay converted (the splash holds until the app is ready). */
export interface Timeline { tickMs: number; idle: number; flicker: number; sweep: number; hold: number }
/** The approved prototype loop: about 10 s. */
export const FULL: Timeline = { tickMs: 110, idle: 16, flicker: 8, sweep: 44, hold: 22 };
/** The boot splash: converted within 1 s (the splash is held at least 1.2 s), then holds. */
export const BOOT: Timeline = { tickMs: 50, idle: 4, flicker: 2, sweep: 10, hold: Infinity };

export const convertedAtMs = (tl: Timeline): number => (tl.idle + tl.flicker + tl.sweep) * tl.tickMs;
export const loopTicks = (tl: Timeline): number => tl.idle + tl.flicker + tl.sweep + tl.hold;

type Grid = Map<string, string>;
const key = (x: number, y: number) => `${x},${y}`;

function place(rows: readonly string[], at: { x: number; y: number }, into: Grid, map?: (c: string) => string): void {
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (c !== '.') into.set(key(x + at.x, y + at.y), map ? map(c) : c); }));
}

/** The converted helm with its binary ring; `spin` scrolls the ring's bits (the splash's hold). */
export function helmGrid(spin = 0): Grid {
  const g: Grid = new Map();
  place(HELM_ROWS, HELM_AT, g);
  let i = 0;
  for (let a = 0; a < 360; a += 5) {
    const x = Math.round(RING.cx + RING.outer * Math.cos(a * Math.PI / 180)), y = Math.round(RING.cy + RING.outer * Math.sin(a * Math.PI / 180));
    if (!g.has(key(x, y)) && a % 15 !== 5) g.set(key(x, y), RING_BITS[(i++ + spin) % RING_BITS.length] === '1' ? 'R' : 'r');
  }
  for (let a = 0; a < 360; a += 12) {
    const x = Math.round(RING.cx + RING.inner * Math.cos(a * Math.PI / 180)), y = Math.round(RING.cy + RING.inner * Math.sin(a * Math.PI / 180));
    if (!g.has(key(x, y))) g.set(key(x, y), 'r');
  }
  return g;
}

/** The critter; `bounce` lifts it a pixel, `eyesShut` blinks. */
export function critterGrid(bounce = 0, eyesShut = false): Grid {
  const g: Grid = new Map();
  place(CRITTER_ROWS, { x: CRITTER_AT.x, y: CRITTER_AT.y + bounce }, g, (c) => (eyesShut && c === 'K' ? 'O' : c));
  return g;
}

/** Deterministic random in [0, 1) (mulberry32), so a seeded run draws the same glitches every time. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Pixel { x: number; y: number; color: string; opacity?: number }
export type Phase = 'idle' | 'flicker' | 'sweep' | 'hold';
export interface Frame { phase: Phase; pixels: Pixel[]; headline: string; headlineColor: string; progress: number; glitch: boolean }

export function phaseAt(tl: Timeline, t: number): Phase {
  if (t < tl.idle) return 'idle';
  if (t < tl.idle + tl.flicker) return 'flicker';
  if (t < tl.idle + tl.flicker + tl.sweep) return 'sweep';
  return 'hold';
}

/** The pixels and text of tick `t`. `rand` drives the glitch (Math.random live, `seeded(n)` in tests and the GIF). */
export function frameAt(tl: Timeline, t: number, rand: () => number = Math.random): Frame {
  const phase = phaseAt(tl, t);
  const crit = critterGrid(phase === 'idle' && t % 8 >= 4 ? -1 : 0, phase === 'idle' && t % 16 === 10);
  const holdTick = t - (tl.idle + tl.flicker + tl.sweep);
  const helm = helmGrid(phase === 'hold' && tl.hold === Infinity ? Math.floor(holdTick / 2) : 0);
  let seam = CANVAS_W, glitch = false, progress = 0;
  let flip: Set<number> | null = null;
  if (phase === 'flicker') {
    glitch = rand() < 0.8;
    flip = new Set();
    for (let k = 0; k < 4; k++) flip.add(Math.floor(rand() * CANVAS_H));
  } else if (phase === 'sweep') {
    progress = (t - tl.idle - tl.flicker) / tl.sweep;
    seam = Math.round(CANVAS_W - progress * (CANVAS_W + 1));
    glitch = rand() < 0.6;
  } else if (phase === 'hold') { seam = -2; progress = 1; }

  const shifts = new Map<number, number>();
  if (glitch) {
    const bands = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < bands; k++) {
      const y0 = Math.floor(rand() * CANVAS_H), h = 1 + Math.floor(rand() * 3), dx = (rand() < 0.5 ? -1 : 1) * (1 + Math.floor(rand() * 2));
      for (let y = y0; y < y0 + h; y++) shifts.set(y, dx);
    }
  }

  const pixels: Pixel[] = [];
  const keys = [...new Set([...helm.keys(), ...crit.keys()])].sort();
  for (const k of keys) {
    const [x, y] = k.split(',').map(Number) as [number, number];
    let useHelm = x > seam || (x === seam && y % 2 === 0);
    if (flip?.has(y)) useHelm = !useHelm;
    const c = useHelm ? helm.get(k) : crit.get(k);
    if (!c) continue;
    const dx = shifts.get(y) ?? 0;
    if (dx) {
      pixels.push({ x: x + dx - 1, y, color: GLITCH_RED, opacity: 0.5 });
      pixels.push({ x: x + dx + 1, y, color: GLITCH_CYAN, opacity: 0.5 });
    }
    pixels.push({ x: x + dx, y, color: PALETTE[c]! });
  }
  if (glitch && seam > 0 && seam < CANVAS_W) {
    for (let y = 0; y < CANVAS_H; y += 2) if (rand() < 0.35) pixels.push({ x: seam, y, color: rand() < 0.5 ? GLITCH_CYAN : GLITCH_RED, opacity: 0.8 });
  }

  const base = phase === 'idle' ? HEADLINE_IDLE : phase === 'hold' ? HEADLINE_TAKEN : HEADLINE_TAKING;
  const headline = glitch ? [...base].map((ch) => (ch !== ' ' && rand() < 0.08 ? '▓▒░'[Math.floor(rand() * 3)]! : ch)).join('') : base;
  return { phase, pixels, headline, headlineColor: phase === 'idle' ? '#D97757' : '#FF6B6B', progress, glitch };
}

/** "[████      ] 40%", or '' before the takeover starts. */
export function progressBar(f: Frame, width = 20): string {
  if (f.phase === 'idle') return '';
  const n = Math.round(f.progress * width);
  return `[${'█'.repeat(n)}${' '.repeat(width - n)}] ${Math.round(f.progress * 100)}%`;
}

/** One still for reduced motion and the README: fully converted, no glitch. */
export function stillFrame(): Frame {
  return frameAt({ ...FULL, hold: 1 }, FULL.idle + FULL.flicker + FULL.sweep, () => 1);
}
