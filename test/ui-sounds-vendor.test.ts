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
  assert.equal(packs.length, 14);
  assert.deepEqual(packs.slice(0, 2).map((p) => p.id), ['forge', 'reliquary']);
  assert.ok(packs.some((p) => p.id === 'minimal'));
  assert.ok(packs.every((p) => p.label && p.description));
  assert.equal(m.CUSTOM_PACKS.length, 2);
  assert.equal(m.defaultPack(packs), 'forge');
  assert.equal(m.packOrDefault('gone', packs), 'forge');
  const builtOnly = m.listPacks([]);
  assert.equal(builtOnly.length, 12);
  assert.equal(m.defaultPack(builtOnly), 'minimal'); // Forge missing: Minimal stands in
  assert.equal(m.packOrDefault('forge', builtOnly), 'minimal');
  assert.equal(m.packOrDefault('zen', packs), 'zen');
  const withCustom = m.listPacks([{ id: 'forge', label: 'Forge', description: 'x', cues: [], render: () => null }, { id: 'minimal', label: 'Dup', description: 'x', cues: [], render: () => null }]);
  assert.equal(m.defaultPack(withCustom), 'forge');
  assert.equal(m.packOrDefault('gone', withCustom), 'forge');
  assert.equal(withCustom.length, 13);
  assert.equal(withCustom[0]!.id, 'forge');
  const g = m.listCueGroups();
  assert.deepEqual(g.slice(0, 2).map((x) => x.pack), ['forge', 'reliquary']);
  assert.ok(g[0]!.cues.some((c) => c.id === 'notification'));
  // the picker offers the cues Legion plays, named by what they are for, never by the library's cue id
  assert.ok(g.every((x) => x.cues.length >= 7 && x.cues.length <= 9));
  assert.ok(g.every((x) => x.cues.every((c) => c.label && c.label !== c.id && /^[A-Z]/.test(c.label) && !/^(Notification|Complete|Error|Success|Cancel|Check|Deselect|Queued)$/.test(c.label))));
  assert.equal(g[2]!.cues.find((c) => c.id === 'notification')!.label, 'Something needs you');
  assert.equal(g[2]!.cues.find((c) => c.id === 'complete')!.label, 'A run finished');
  // plain, short, calm descriptions for the library packs; the two Legion packs speak in Legion's voice
  const lib = packs.filter((p) => !p.custom);
  assert.ok(lib.every((p) => { const n = p.description.split(/\s+/).length; return n >= 6 && n <= 8; }), lib.map((p) => p.description).join(' | '));
  assert.ok(lib.every((p) => !/premium|cheerful|voltage|washi|restrained|cinematic restraint/i.test(p.description)));
  assert.equal(packs[0]!.description, 'Forge-temple machinery, iron and servos.');
  assert.equal(packs[1]!.description, 'A sacred hall of bells and a quiet choir.');
  assert.equal(withCustom.filter((p) => p.id === 'minimal').length, 1);
});

test('every lore cue renders: not silent, no NaN, peak at or under 0 dBFS, and ends at zero', async () => {
  const dir = tempDir('legion-lore-');
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, `import '${join(process.cwd(), 'ui/src/sound/lore/lore.js').replace(/\\/g, '/')}';\n`);
  const out = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
  writeFileSync(join(dir, 'lore.mjs'), out.outputFiles[0]!.text);
  await import(pathToFileURL(join(dir, 'lore.mjs')).href);
  const lore = (globalThis as unknown as { LORE: { packs: string[]; has(p: string, c: string): boolean; render(p: string, c: string, sr: number): { left: Float32Array; right: Float32Array; peak: number; duration: number } } }).LORE;
  assert.deepEqual(lore.packs, ['forge', 'reliquary']);
  for (const pack of lore.packs) for (const cue of ['notification', 'complete', 'error', 'success', 'cancel', 'check', 'deselect', 'queued']) {
    assert.ok(lore.has(pack, cue), `${pack}/${cue} exists`);
    const r = lore.render(pack, cue, 44100);
    let peak = 0;
    for (const ch of [r.left, r.right]) for (let i = 0; i < ch.length; i++) { assert.ok(Number.isFinite(ch[i]), `${pack}/${cue} NaN at ${i}`); peak = Math.max(peak, Math.abs(ch[i]!)); }
    assert.ok(peak > 0.05, `${pack}/${cue} is silent (peak ${peak})`);
    assert.ok(peak <= 1, `${pack}/${cue} clips (peak ${peak})`);
    assert.ok(r.duration > 0.05 && r.duration < 3, `${pack}/${cue} duration ${r.duration}`);
    assert.ok(Math.abs(r.left[r.left.length - 1]!) < 1e-6, `${pack}/${cue} does not end at zero`);
  }
});
