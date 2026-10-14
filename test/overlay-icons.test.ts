import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OVERLAY_KEYS } from '../src/electron/attention.js';
import { OVERLAY_SIZES, overlayFile } from '../src/electron/overlay-files.js';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

test('every taskbar number has a pre-drawn PNG at 100%, 125% and 150% scale', () => {
  assert.deepEqual(OVERLAY_SIZES.map((s) => s.px), [16, 20, 24]);
  assert.deepEqual(OVERLAY_SIZES.map((s) => s.scale), [1, 1.25, 1.5]);
  for (const key of OVERLAY_KEYS) {
    for (const { px } of OVERLAY_SIZES) {
      const f = join(REPO, 'assets', 'overlay', overlayFile(key, px));
      assert.ok(existsSync(f), `${f} is missing: run node scripts/build-overlay-icons.mjs`);
      const b = readFileSync(f);
      assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG');
      assert.equal(b.readUInt32BE(16), px, `${f} width`);
      assert.equal(b.readUInt32BE(20), px, `${f} height`);
      assert.equal(b[25], 6, `${f} must be RGBA (transparent corners)`);
    }
  }
});
