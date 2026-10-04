/**
 * blender.baseDir, the one setting that produces TWO derived roots. This file pins the facts a user gets when they set it:
 *
 *  - it is read back from config.json (loadConfig applies normalizeBlender), and a relative or blank value falls back to the defaults,
 *    so the same saved string cannot behave differently per launch (never resolved against the process CWD);
 *  - <base>/local is the local scene/tmp/runner folder (LocalRunner.root, guard.localRoot);
 *  - <base>/exports/<task> and <base>/quarantine/<task> are where copied-back exports and quarantined .blend files land (exports.ts);
 *  - the containment root MOVES from the agent workspace to <base>, so exports can land outside the workspace on purpose, but a value
 *    that is itself a link, or a link planted inside it, is still refused: exports cannot be steered outside the configured folder.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { ABSOLUTE_PATH, defaultBlenderConfig, normalizeBlender } from '../src/shared/blender.js';
import { loadConfig } from '../src/shared/config.js';
import { collectExports, safeSegment } from '../src/core/blender/exports.js';
import { liveExportFolder } from '../src/core/blender/guard.js';
import { LocalRunner } from '../src/core/blender/local.js';
import type { ProcessPort, SpawnRequest, SpawnedProcess } from '../src/core/blender/ports.js';
import { scriptHash } from '../src/core/blender/static-check.js';
import { agent, tmp } from './blender-helpers.js';
import { linkOrSkip } from './fs-links.js';

const src = (files: Record<string, string>) => ({
  list: () => Object.entries(files).map(([name, c]) => ({ name, bytes: Buffer.byteLength(c) })),
  read: (name: string) => Buffer.from(files[name] as string),
});

test('blender.baseDir is read back from config.json; a relative or blank value falls back to the default folder', () => {
  const home = tmp('legion-bl-home-');
  const abs = tmp('legion-bl-bd-');
  const prev = process.env.LEGION_HOME;
  process.env.LEGION_HOME = home;
  const write = (baseDir: unknown) => writeFileSync(join(home, 'config.json'), JSON.stringify({ blender: { enabled: true, baseDir } }));
  try {
    write(abs);
    assert.equal(loadConfig().blender.baseDir, abs, 'an absolute folder is read back');
    // a relative value is dropped, never resolved against whatever the process CWD happens to be this launch
    write('relative/folder');
    assert.equal(loadConfig().blender.baseDir, undefined);
    write('   ');
    assert.equal(loadConfig().blender.baseDir, undefined, 'a blank folder means the default');
    write(5);
    assert.equal(loadConfig().blender.baseDir, undefined);
  } finally {
    if (prev === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = prev;
  }
});

test('a base must be absolute so the same saved value behaves the same on every launch', () => {
  for (const p of ['D:\\blender', 'D:/blender', '/mnt/blender', '\\\\server\\share']) {
    assert.equal(normalizeBlender({ baseDir: p }).baseDir, p, p);
  }
  for (const p of ['blender', './blender', '../blender', 'blender/exports', 'C:blender']) {
    assert.equal(normalizeBlender({ baseDir: p }).baseDir, undefined, p);
  }
  assert.equal(normalizeBlender({ baseDir: '  D:\\blender  ' }).baseDir, 'D:\\blender', 'surrounding whitespace is trimmed before the absolute check');
  assert.equal(ABSOLUTE_PATH.test('blender'), false);
});

/** A ProcessPort with no real child: it reads the task/run/hash the runner passes after `--` and writes the files the runner expects. */
class FakeProc implements ProcessPort {
  spawns: SpawnRequest[] = [];
  spawn(req: SpawnRequest): SpawnedProcess {
    this.spawns.push(req);
    const i = req.args.indexOf('--');
    const task = req.args[i + 1]!;
    const run = req.args[i + 2]!;
    const hash = req.args[i + 3]!;
    writeFileSync(join(task, 'scene.blend'), 'BLEND');
    mkdirSync(join(task, 'exports'), { recursive: true });
    writeFileSync(join(task, 'exports', 'cube.glb'), 'glTF-bytes');
    writeFileSync(join(task, `result-${run}.json`), JSON.stringify({ ok: true, output: 'fake ran', run, hash, violations: [] }));
    return { pid: 4242, exited: Promise.resolve({ code: 0, signal: null }), stdout: () => '', stderr: () => '' };
  }
  async kill(): Promise<boolean> { return true; }
}

test('setting baseDir moves BOTH derived roots: <base>/local (the scene folder) and <base>/exports/<task> (the copied-back exports)', async () => {
  const base = tmp('legion-bl-bd-');
  const data = tmp('legion-bl-data-');
  const ws = tmp('legion-bl-ws-');
  const cfg = defaultBlenderConfig();
  cfg.baseDir = base;
  const runner = new LocalRunner({
    proc: new FakeProc(), config: () => cfg, dataDir: data, workspaceOf: () => ws,
    install: () => ({ path: join(base, 'Blender 5.1', 'blender.exe'), version: '5.1.0' }),
  });
  const script = 'print(1)\n';
  const res = await runner.run({ agent: agent(), taskId: 't1', script, hash: scriptHash(script), timeoutMs: 20_000 });
  assert.equal(res.ok, true, res.text);
  const seg = safeSegment('t1');
  // root 1: the local scene/tmp/runner folder is <base>/local, NOT <dataDir>/blender/local
  assert.equal(existsSync(join(base, 'local', 'runner.py')), true, 'the local work folder moved to <base>/local');
  assert.equal(readFileSync(join(base, 'local', seg, 'scene.blend'), 'utf8'), 'BLEND');
  // root 2: copied-back exports land in <base>/exports/<task>, NOT the agent workspace
  assert.deepEqual(res.files.map((f) => f.name), ['cube.glb']);
  assert.equal(res.files[0]!.path, join(base, 'exports', seg, 'cube.glb'));
  assert.equal(readFileSync(join(base, 'exports', seg, 'cube.glb'), 'utf8'), 'glTF-bytes');
  // neither default location is touched while a base is set
  assert.equal(existsSync(join(data, 'blender', 'local')), false, 'nothing under <dataDir>/blender/local');
  assert.equal(existsSync(join(ws, 'blender-exports')), false, 'nothing under the agent workspace');
});

test('a base with a .. segment resolves to one canonical folder; exports still cannot leave it', async () => {
  const ws = tmp('legion-bl-ws-');
  const root = tmp('legion-bl-root-');
  const chosen = join(root, 'chosen');
  mkdirSync(chosen, { recursive: true });
  const base = join(chosen, '..', 'chosen'); // contains a .. segment that collapses back to `chosen`
  const seg = safeSegment('td');
  const r = await collectExports({ workspace: ws, exportsBaseDir: base, taskId: 'td', ...src({ 'a.glb': 'g' }) });
  assert.deepEqual(r.problems, []);
  assert.equal(existsSync(join(chosen, 'exports', seg, 'a.glb')), true, 'the .. segment collapses to the canonical folder');
  assert.equal(resolve(r.files[0]!.path), join(resolve(chosen), 'exports', seg, 'a.glb'));
  assert.equal(existsSync(join(ws, 'blender-exports')), false, 'nothing is written into the workspace');
});

test('a user-supplied base cannot be steered: an export folder that resolves outside it is refused', () => {
  const root = tmp('legion-bl-root-');
  const allowed = join(root, 'allowed');
  mkdirSync(allowed, { recursive: true });
  const good = liveExportFolder(join(allowed, 'exports', 't'), allowed);
  assert.equal(good.ok, true);
  const escape = liveExportFolder(join(allowed, '..', 'outside'), allowed);
  assert.equal(escape.ok, false);
  assert.match((escape as { error: string }).error, /outside/);
});

test('a user-supplied base that is itself a symbolic link is refused; no export is written through it', async (t) => {
  const ws = tmp('legion-bl-ws-');
  const outside = tmp('legion-bl-out-');
  const link = join(tmp('legion-bl-link-'), 'base');
  if (!linkOrSkip(t, outside, link, 'dir')) return;
  const r = await collectExports({ workspace: ws, exportsBaseDir: link, taskId: 'tl', ...src({ 'a.glb': 'g' }) });
  assert.deepEqual(r.files, []);
  assert.match(r.problems.join('\n'), /symbolic link|outside/i);
  assert.equal(existsSync(join(outside, 'exports', safeSegment('tl'), 'a.glb')), false, 'no file is written through the link');
});

test('a link planted inside the user-supplied base still stops the copy', async (t) => {
  const ws = tmp('legion-bl-ws-');
  const base = tmp('legion-bl-base-');
  const outside = tmp('legion-bl-out-');
  mkdirSync(join(base, 'exports'), { recursive: true });
  if (!linkOrSkip(t, outside, join(base, 'exports', safeSegment('tb')), 'dir')) return;
  const r = await collectExports({ workspace: ws, exportsBaseDir: base, taskId: 'tb', ...src({ 'a.png': 'p' }) });
  assert.deepEqual(r.files, []);
  assert.match(r.problems.join('\n'), /symbolic link/);
  assert.equal(existsSync(join(outside, 'a.png')), false);
});

test('a blank exports base means the workspace default, after trimming whitespace', async () => {
  const ws = tmp('legion-bl-ws-');
  const seg = safeSegment('te');
  for (const blank of [undefined, '', '   '] as const) {
    const r = await collectExports({ workspace: ws, ...(blank === undefined ? {} : { exportsBaseDir: blank }), taskId: 'te', ...src({ 'a.glb': 'g' }) });
    assert.deepEqual(r.problems, []);
    assert.equal(r.files[0]!.path, join(ws, 'blender-exports', seg, 'a.glb'), String(blank));
  }
});


/**
 * The WRITE path, which is the half that was missing.
 *
 * parsePatch dropped an unknown key without a 400, so POST /api/blender/config { baseDir } returned 200 and saved
 * nothing. Every test above proves the value is HONOURED when present in config.json; none of them prove a user can
 * PUT it there. A setting that cannot be set is the half-feature this test exists to prevent.
 */
test('baseDir can be SET and survives a reload; blank clears it back to the default', async () => {
  const dir = tmp('blender-base-write-');
  const { BlenderState } = await import('../src/core/blender/state.js');
  const st = new BlenderState({ dataDir: dir });

  st.update({ baseDir: join(dir, 'chosen') });
  assert.equal(st.config.baseDir, join(dir, 'chosen'), 'the value in force is what status() reports');

  // Re-read from DISK in a fresh state: an in-memory field proves nothing. BlenderState writes to config.json when
  // one exists and to its own blender.json otherwise, so assert on whichever it created - and require one of them.
  const written = [join(dir, 'config.json'), join(dir, 'blender.json')].filter(existsSync);
  assert.ok(written.length > 0, 'the setting was persisted to a file');
  const reread = JSON.parse(readFileSync(written[0]!, 'utf8')) as { blender?: { baseDir?: string }; baseDir?: string };
  assert.equal(reread.blender?.baseDir ?? reread.baseDir, join(dir, 'chosen'), 'written to disk, not just held in memory');

  const fresh = new BlenderState({ dataDir: dir });
  assert.equal(fresh.config.baseDir, join(dir, 'chosen'), 'survives a restart');

  // Blank and null both mean "back to the defaults", and must not leave an empty string as a base.
  for (const blank of [null, '', '   ']) {
    fresh.update({ baseDir: blank });
    assert.equal(fresh.config.baseDir, undefined, `${JSON.stringify(blank)} clears the setting`);
  }
});

test('a relative base is refused rather than resolved against the CWD', () => {
  // parsePatch rejects it, and normalizeBlender rejects it again for a hand-edited config.json.
  assert.equal(ABSOLUTE_PATH.test('blender/work'), false);
  assert.equal(ABSOLUTE_PATH.test('./blender'), false);
  const cfg = normalizeBlender({ ...defaultBlenderConfig(), baseDir: 'blender/work' });
  assert.equal(cfg.baseDir, undefined, 'a relative base never becomes a folder path');
});
