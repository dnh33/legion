/** The shared export copy-back rules (exports.ts) as both runners use them: the cloud VM (through SandboxRunner with an in-memory VM, so this runs on Windows too) and local disk (LocalRunner, see blender-local.test.ts). */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { defaultBlenderConfig } from '../src/shared/blender.js';
import { MAX_EXPORT_BYTES, MAX_EXPORT_FILES, QUARANTINE_SUFFIX, collectExports, safeSegment } from '../src/core/blender/exports.js';
import { SandboxRunner } from '../src/core/blender/sandbox.js';
import type { VmPort } from '../src/core/blender/sandbox.js';
import { agent, tmp } from './blender-helpers.js';
import { linkOrSkip } from './fs-links.js';

const src = (files: Record<string, Buffer | string>) => ({
  list: () => Object.entries(files).map(([name, c]) => ({ name, bytes: Buffer.byteLength(c) })),
  read: (name: string) => Buffer.from(files[name] as string),
});

test('only known extensions and plain names come back; .blend is set aside as <name>.blend.untrusted in blender-quarantine', async () => {
  const ws = tmp('legion-bl-ex-');
  const r = await collectExports({ workspace: ws, taskId: 'tk', ...src({ 'a.glb': 'g', 'b.PNG': 'p', 'evil.sh': 'x', 'noext': 'x', '.hidden.glb': 'x', '-rf.glb': 'x', 'a b.obj': 'o', 'x.blend': 'BLEND' }) });
  assert.deepEqual(r.files.map((f) => f.name).sort(), ['a b.obj', 'a.glb', 'b.PNG', 'x.blend']);
  const blend = r.files.find((f) => f.name === 'x.blend')!;
  assert.equal(blend.quarantined, true);
  assert.equal(blend.path, join(ws, 'blender-quarantine', safeSegment('tk'), 'x.blend' + QUARANTINE_SUFFIX));
  assert.equal(existsSync(join(ws, 'blender-exports', safeSegment('tk'), 'x.blend')), false);
  assert.equal(existsSync(join(ws, 'blender-exports', safeSegment('tk'), 'x.blend' + QUARANTINE_SUFFIX)), false);
  assert.deepEqual(readdirSync(join(ws, 'blender-exports', safeSegment('tk'))).sort(), ['a b.obj', 'a.glb', 'b.PNG']);
  assert.equal(r.files.filter((f) => !f.quarantined).every((f) => f.quarantined === undefined), true);
});

test('at most 20 files; a file over 15 MB (listed size or actual size) is skipped', async () => {
  const ws = tmp('legion-bl-ex-');
  const many: Record<string, string> = {};
  for (let i = 0; i < 30; i++) many[`f${i}.png`] = 'p';
  assert.equal((await collectExports({ workspace: ws, taskId: 'many', ...src(many) })).files.length, MAX_EXPORT_FILES);
  const liar = await collectExports({ workspace: ws, taskId: 'big', list: () => [{ name: 'a.glb', bytes: 10 }, { name: 'b.glb', bytes: MAX_EXPORT_BYTES + 1 }], read: (n) => (n === 'a.glb' ? Buffer.from('x') : Buffer.alloc(1)) });
  assert.deepEqual(liar.files.map((f) => f.name), ['a.glb']);
  const lied = await collectExports({ workspace: ws, taskId: 'big2', list: () => [{ name: 'c.glb', bytes: 5 }], read: () => Buffer.alloc(MAX_EXPORT_BYTES + 1) });
  assert.deepEqual(lied.files, [], 'a file that is bigger than it said is dropped');
});

test('a task id cannot climb out of the export folder', async () => {
  const ws = tmp('legion-bl-ex-');
  const r = await collectExports({ workspace: ws, taskId: '../../x', ...src({ 'a.png': 'p' }) });
  assert.equal(r.files[0]!.path, join(ws, 'blender-exports', safeSegment('../../x'), 'a.png'));
  assert.match(safeSegment(''), /^task-[0-9a-f]{8}$/);
});

test('a link planted in the workspace export or quarantine folder stops the copy and nothing is written through it', async (t) => {
  const ws = tmp('legion-bl-ex-');
  const outside = tmp('legion-bl-out-');
  mkdirSync(join(ws, 'blender-exports'), { recursive: true });
  mkdirSync(join(ws, 'blender-quarantine'), { recursive: true });
  if (!linkOrSkip(t, outside, join(ws, 'blender-exports', safeSegment('tl')), 'dir')) return;
  const r = await collectExports({ workspace: ws, taskId: 'tl', ...src({ 'a.png': 'p' }) });
  assert.deepEqual(r.files, []);
  assert.match(r.problems.join('\n'), /Exports were not copied/);
  assert.deepEqual(readdirSync(outside), []);
  if (!linkOrSkip(t, outside, join(ws, 'blender-quarantine', safeSegment('tl')), 'dir')) return;
  const q = await collectExports({ workspace: ws, taskId: 'tl', ...src({ 'q.blend': 'B' }) });
  assert.deepEqual(q.files, []);
  assert.deepEqual(readdirSync(outside), []);
});

test('a link planted INSIDE the real destination folder also stops the copy', async (t) => {
  const ws = tmp('legion-bl-ex-');
  const outside = tmp('legion-bl-out-');
  mkdirSync(join(ws, 'blender-exports', safeSegment('tn')), { recursive: true });
  if (!linkOrSkip(t, outside, join(ws, 'blender-exports', safeSegment('tn'), 'sub'), 'dir')) return;
  const r = await collectExports({ workspace: ws, taskId: 'tn', ...src({ 'a.png': 'p' }) });
  assert.deepEqual(r.files, []);
  assert.match(r.problems.join('\n'), /symbolic link/);
  assert.equal(existsSync(join(ws, 'blender-exports', safeSegment('tn'), 'a.png')), false);
});

test('a listing that fails returns nothing and does not throw; a read that fails is reported for that file only', async () => {
  const ws = tmp('legion-bl-ex-');
  assert.deepEqual(await collectExports({ workspace: ws, taskId: 'x', list: () => { throw new Error('no folder'); }, read: () => Buffer.alloc(0) }), { files: [], problems: [] });
  const r = await collectExports({ workspace: ws, taskId: 'x', list: () => [{ name: 'a.png', bytes: 1 }, { name: 'b.png', bytes: 1 }], read: (n) => { if (n === 'a.png') throw new Error('gone'); return Buffer.from('b'); } });
  assert.deepEqual(r.files.map((f) => f.name), ['b.png']);
  assert.match(r.problems[0]!, /a\.png could not be copied: gone/);
});

test('the VM runner uses the same rules (in-memory VM, no bash needed)', async () => {
  const ws = tmp('legion-bl-ex-');
  const cfg = defaultBlenderConfig();
  const files: Record<string, Buffer> = { 'cube.glb': Buffer.from('glTF'), 'x.blend': Buffer.from('BLEND'), 'evil.sh': Buffer.from('rm'), 'huge.glb': Buffer.alloc(MAX_EXPORT_BYTES + 1) };
  let runId = '';
  let hash = '';
  const vm: VmPort = {
    status: () => ({ agentId: 'sculptor', sandboxId: 's', state: 'running', size: 'default', lastUsedAt: null, createdAt: null }),
    ensureRunning: async () => vm.status('sculptor'),
    exec: async (_id, c) => {
      if (c.includes('printf %s "$HOME"')) return { exitCode: 0, stdout: '/home/u', stderr: '' };
      if (c.includes('command -v')) return { exitCode: 0, stdout: '/home/u/blender\n', stderr: '' };
      if (c.includes('find .')) return { exitCode: 0, stdout: Object.entries(files).map(([n, b]) => `${n}\t${b.length}`).join('\n') + '\n', stderr: '' };
      const m = /'([0-9a-f]{16})' '([0-9a-f]{64})'/.exec(c);
      if (m) { runId = m[1]!; hash = m[2]!; }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    readFile: async (_id, path, enc) => {
      if (path.endsWith(`result-${runId}.json`)) return JSON.stringify({ ok: true, output: 'vm ran', run: runId, hash });
      return (files[path.split('/').pop()!] ?? Buffer.alloc(0)).toString(enc ?? 'utf8');
    },
    writeFile: async () => undefined,
  };
  const sb = new SandboxRunner({ vms: vm, config: () => cfg, boatConfigured: () => true, workspaceOf: () => ws });
  const r = await sb.run({ agent: agent(), taskId: 'tv', script: 'print(1)\n' });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(r.files.map((f) => f.name).sort(), ['cube.glb', 'x.blend']);
  assert.equal(readFileSync(join(ws, 'blender-exports', safeSegment('tv'), 'cube.glb'), 'utf8'), 'glTF');
  assert.equal(r.files.find((f) => f.name === 'x.blend')!.path, join(ws, 'blender-quarantine', safeSegment('tv'), 'x.blend.untrusted'));
  assert.equal(existsSync(join(ws, 'blender-exports', safeSegment('tv'), 'x.blend')), false);
  assert.match(r.text, /QUARANTINED/);
  writeFileSync(join(ws, 'keep'), '');
});

test('L2: ids that sanitise to the same text, or share a long prefix, get different folders', () => {
  assert.notEqual(safeSegment('a/b'), safeSegment('a_b'));
  assert.notEqual(safeSegment('x'.repeat(80) + '1'), safeSegment('x'.repeat(80) + '2'));
  assert.equal(safeSegment('same'), safeSegment('same'));
  assert.ok(safeSegment('a'.repeat(500)).length <= 49);
});

test('L7: Windows device names are refused as export names, with or without an extension; ordinary names stay', async () => {
  const ws = tmp('legion-bl-ex-');
  const names = ['CON.png', 'con.glb', 'NUL', 'Prn.obj', 'AUX.png', 'COM1.png', 'lpt9.glb', 'com5.stl', 'good.png', 'console.png', 'COM10.png', 'a b.obj', 'trail.'];
  const r = await collectExports({ workspace: ws, taskId: 'dev', ...src(Object.fromEntries(names.map((n) => [n, 'x']))) });
  assert.deepEqual(r.files.map((f) => f.name).sort(), ['COM10.png', 'a b.obj', 'console.png', 'good.png']);
});

test('an exports base folder moves exports and quarantine under it (created if missing), and nothing lands in the workspace', async () => {
  const ws = tmp('legion-bl-ex-');
  const base = join(tmp('legion-bl-base-'), 'chosen'); // does not exist yet
  const seg = safeSegment('bk');
  const r = await collectExports({ workspace: ws, exportsBaseDir: base, taskId: 'bk', ...src({ 'a.glb': 'g', 'x.blend': 'B' }) });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.files.map((f) => f.name).sort(), ['a.glb', 'x.blend']);
  assert.equal(r.files.find((f) => f.name === 'a.glb')!.path, join(base, 'exports', seg, 'a.glb'));
  assert.equal(r.files.find((f) => f.name === 'x.blend')!.path, join(base, 'quarantine', seg, 'x.blend' + QUARANTINE_SUFFIX));
  assert.equal(existsSync(join(base, 'exports', seg, 'a.glb')), true, 'the configured base folder is created on demand');
  assert.equal(existsSync(join(ws, 'blender-exports')), false, 'nothing is written to the workspace when a base is set');
});
