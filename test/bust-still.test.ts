/** Resting busts are pre-rendered pictures (spec 9.1 bust-still): the registry covers every bust x state x theme. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STILL_BUSTS, STILL_STATES, STILL_THEMES, stillFile, stillState } from '../ui/src/mascot/stillsLogic.js';

// dist/test/bust-still.test.js -> repo root
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STILLS = join(ROOT, 'ui', 'src', 'mascot', 'stills');
/** Every expected still that is not a file under dir. */
const missingStills = (dir: string): string[] => STILL_THEMES.flatMap((t) => STILL_BUSTS.flatMap((b) => STILL_STATES.map((s) => stillFile(b, s, t)))).filter((f) => !existsSync(join(dir, f)));
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

test('the still registry names exactly the painted busts (the loaders in busts.ts plus the Marshal)', () => {
  const src = read('ui', 'src', 'mascot', 'busts.ts');
  const loaders = [...src.matchAll(/^\s{2}(\w+): \(\) => import\(/gm)].map((m) => m[1]);
  assert.deepEqual([...STILL_BUSTS].sort(), [...loaders, 'zealot'].sort());
});

test('every bust x state x theme has a still on disk, and nothing else is in the folder', () => {
  assert.deepEqual(missingStills(STILLS), []);
  for (const theme of STILL_THEMES) {
    assert.equal(readdirSync(join(STILLS, theme)).length, STILL_BUSTS.length * STILL_STATES.length, theme);
  }
});

test('a missing still is reported (negative: one file removed from a copy)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'legion-stills-'));
  try {
    cpSync(STILLS, tmp, { recursive: true });
    assert.deepEqual(missingStills(tmp), []);
    const gone = stillFile('scout', 'awaiting', 'light');
    rmSync(join(tmp, gone));
    assert.deepEqual(missingStills(tmp), [gone]);
    assert.equal(existsSync(join(tmp, gone)), false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('poses without their own picture rest on the idle one; the six that have one map to themselves', () => {
  for (const s of STILL_STATES) assert.equal(stillState(s), s);
  for (const s of ['listening', 'victory', 'annoyed'] as const) assert.equal(stillState(s), 'idle');
});

test('still file names are theme/bust-state.webp', () => {
  assert.equal(stillFile('zealot', 'idle', 'dark'), 'dark/zealot-idle.webp');
});
