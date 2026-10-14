import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { tempDir } from './tmp-cleanup.js';

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');
const vendored = read('ui/src/sound/vendor/uisfx/index.js');

test('the vendored sound runtime needs no eval, no network, no media file and no data: URL (Legion CSP: script-src self, default-src self)', () => {
  for (const [name, re] of [['eval', /\beval\s*\(/], ['new Function', /new Function\b/], ['fetch', /\bfetch\s*\(/], ['XMLHttpRequest', /XMLHttpRequest/], ['dynamic import', /\bimport\s*\(/], ['data: URL', /data:[a-z]+\//i], ['new Audio', /new Audio\b/], ['decodeAudioData', /decodeAudioData/], ['createObjectURL', /createObjectURL/], ['WebSocket', /WebSocket/]] as const) {
    assert.ok(!re.test(vendored), `vendored runtime uses ${name}`);
  }
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(read('ui/index.html'))?.[1] ?? '';
  assert.ok(csp.includes("script-src 'self'") && !csp.includes('unsafe-eval'), 'the CSP stays without unsafe-eval');
});

test('sounds add no dependency: package.json and the lockfile do not mention uisfx; the licence and notice are kept', () => {
  assert.ok(!/uisfx/i.test(read('package.json')));
  assert.ok(!/uisfx/i.test(read('package-lock.json')));
  assert.match(read('ui/src/sound/vendor/uisfx/LICENSE'), /MIT License/);
  assert.match(read('ui/src/sound/vendor/uisfx/LICENSE-AUDIO'), /CC0/);
  assert.match(read('NOTICE'), /uisfx/);
});

test('the pack picker lists every built-in pack, no placeholder for the lore packs, and an unknown id falls back to Minimal', async () => {
  const dir = tempDir('legion-sounds-');
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, `export * from '${join(process.cwd(), 'ui/src/sound/soundPacks.ts').replace(/\\/g, '/')}';\n`);
  const out = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
  writeFileSync(join(dir, 'packs.mjs'), out.outputFiles[0]!.text);
  const m = await import(pathToFileURL(join(dir, 'packs.mjs')).href) as typeof import('../ui/src/sound/soundPacks.js');
  const packs = m.listPacks();
  assert.equal(packs.length, 12);
  assert.ok(packs.some((p) => p.id === 'minimal'));
  assert.ok(packs.every((p) => !p.custom && p.label && p.description));
  assert.equal(m.CUSTOM_PACKS.length, 0);
  assert.equal(m.packOrDefault('forge', packs), 'minimal');
  assert.equal(m.packOrDefault('zen', packs), 'zen');
  const withCustom = m.listPacks([{ id: 'forge', label: 'Forge', description: 'x', recipes: {} }, { id: 'minimal', label: 'Dup', description: 'x', recipes: {} }]);
  assert.equal(withCustom.length, 13);
  assert.equal(withCustom.filter((p) => p.id === 'minimal').length, 1);
});
