/**
 * The Claude Code mod (mod/) runs vendored copies of pure desktop files (scripts/build-mod.mjs). This pins them to their source:
 * each copy must equal the source after the one documented transform (relative `.js` specifiers -> `.ts`), and every listed file
 * must be present. A drift means someone edited a copy, or changed a source without re-running `node scripts/build-mod.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const VENDOR = join(REPO, 'mod', 'vendor', 'legion');
const toModSource = (text: string): string => text.replace(/(\bfrom\s+['"])(\.{1,2}\/[^'"]+)\.js(['"])/g, '$1$2.ts$3');

const manifest = JSON.parse(readFileSync(join(VENDOR, 'manifest.json'), 'utf8')) as { files: string[] };

test('mod vendor: the manifest lists files', () => {
  assert.ok(manifest.files.length > 0);
});

for (const rel of manifest.files) {
  test(`mod vendor: ${rel} matches its source`, () => {
    const copy = join(VENDOR, rel);
    assert.ok(existsSync(copy), `${rel} is listed but not vendored: run node scripts/build-mod.mjs`);
    const want = toModSource(readFileSync(join(REPO, rel), 'utf8'));
    assert.equal(readFileSync(copy, 'utf8'), want, `${rel} drifted from its source: run node scripts/build-mod.mjs`);
  });
}

test('mod vendor: no vendored file imports node:* at runtime', () => {
  for (const rel of manifest.files) {
    const text = readFileSync(join(VENDOR, rel), 'utf8').replace(/import\s+type[^;]+;/g, '');
    assert.doesNotMatch(text, /\bfrom\s+['"]node:/, rel);
  }
});
