/**
 * The takeover animation (src/shared/takeover-art.ts): it starts as the orange critter, ends as the Legion helm, the boot version
 * is converted inside the time the splash is held anyway, and a seeded run draws the same frames every time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOT, CANVAS_H, CANVAS_W, FULL, HEADLINE_IDLE, HEADLINE_TAKEN, HEADLINE_TAKING, PALETTE, convertedAtMs, frameAt, loopTicks, progressBar, seeded, stillFrame } from '../src/shared/takeover-art.js';

const colours = (f: ReturnType<typeof frameAt>) => new Set(f.pixels.filter((p) => p.opacity === undefined).map((p) => p.color));

test('frame 0 is the critter only: orange, no steel, no green visor, no ring', () => {
  const f = frameAt(FULL, 0, seeded(1));
  assert.equal(f.phase, 'idle');
  assert.equal(f.headline, HEADLINE_IDLE);
  const c = colours(f);
  assert.ok(c.has(PALETTE.O!));
  for (const k of ['S', 'N', 'E', 'R', 'P']) assert.ok(!c.has(PALETTE[k]!), `no ${k} in the critter frame`);
});

test('the last frame is the full helm: steel, green T-visor, red plume, binary ring, and no critter orange left', () => {
  const end = FULL.idle + FULL.flicker + FULL.sweep;
  const f = frameAt(FULL, end, seeded(1));
  assert.equal(f.phase, 'hold');
  assert.equal(f.headline, HEADLINE_TAKEN);
  assert.equal(progressBar(f), `[${'█'.repeat(20)}] 100%`);
  const c = colours(f);
  for (const k of ['S', 'N', 'E', 'R', 'P', 'G']) assert.ok(c.has(PALETTE[k]!), `the helm has ${k}`);
  assert.ok(!c.has(PALETTE.O!), 'no critter orange after the takeover');
  assert.deepEqual(colours(stillFrame()), c, 'the still is the converted helm');
});

test('mid-sweep shows both: critter orange on the left, Legion steel on the right', () => {
  const t = FULL.idle + FULL.flicker + Math.floor(FULL.sweep / 2);
  const f = frameAt(FULL, t, () => 0.99); // no glitch: only the seam splits the image
  assert.equal(f.phase, 'sweep');
  assert.equal(f.headline, HEADLINE_TAKING);
  const orange = f.pixels.filter((p) => p.color === PALETTE.O).map((p) => p.x);
  const steel = f.pixels.filter((p) => p.color === PALETTE.S).map((p) => p.x);
  assert.ok(orange.length > 0 && steel.length > 0);
  assert.ok(Math.max(...orange) <= Math.min(...steel) + 1, 'the conversion runs right to left');
});

test('the boot version is converted by 800 ms, well inside the 1200 ms the splash is held, then holds', () => {
  // the 1200 ms floor counts from the start of boot(); the art starts later, once the splash has loaded: keep a margin
  assert.ok(convertedAtMs(BOOT) <= 800, `converted at ${convertedAtMs(BOOT)} ms`);
  assert.equal(loopTicks(BOOT), Infinity);
  assert.equal(frameAt(BOOT, 10_000, seeded(2)).phase, 'hold');
});

test('a seeded run draws the same frames; every pixel stays on the canvas', () => {
  for (let t = 0; t < loopTicks(FULL); t++) {
    const a = frameAt(FULL, t, seeded(t + 7)), b = frameAt(FULL, t, seeded(t + 7));
    assert.deepEqual(a, b, `tick ${t}`);
    for (const p of a.pixels) assert.ok(p.x >= -3 && p.x < CANVAS_W + 3 && p.y >= 0 && p.y < CANVAS_H, `tick ${t} pixel ${p.x},${p.y}`);
  }
});
