/** H1 item 1: an out-of-install runtime copy is made ahead of the commit, verified, used by the apply, and cleaned up afterwards. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { FULL_PACKAGE_SET, MARKER_FILE_NAME, RUNTIME_COPY_DIR, cleanupRuntimeCopy, markCommitted, readJournal, swapIn } from '../src/core/updater/apply.js';
import { planApplySpawn, prepareRuntimeCopy, removeRuntimeCopy, runtimeCopyDir, verifyRuntimeCopy } from '../src/core/updater/runtime-copy.js';

function runtimeFixture(): { install: string; src: string; exe: string } {
  const install = cleanupTemp('h1-copy-');
  const src = join(install, 'runtime', 'electron');
  mkdirSync(join(src, 'locales'), { recursive: true });
  mkdirSync(join(src, 'resources'), { recursive: true });
  writeFileSync(join(src, 'electron.exe'), Buffer.alloc(50_000, 7));
  writeFileSync(join(src, 'ffmpeg.dll'), Buffer.alloc(9000, 1));
  writeFileSync(join(src, 'locales', 'en-US.pak'), 'pak');
  writeFileSync(join(src, 'resources', 'default_app.asar'), 'asar');
  return { install, src, exe: join(src, 'electron.exe') };
}

test('the copy lives under .update, outside every name the swap renames', () => {
  const d = runtimeCopyDir('C:\\inst');
  assert.ok(d.includes(`${sep}.update${sep}`) || d.includes('/.update/'));
  assert.equal(RUNTIME_COPY_DIR, 'runtime-copy');
  assert.ok(!FULL_PACKAGE_SET.includes('.update'));
});

test('prepareRuntimeCopy copies the whole Electron folder, stamps it, and verifyRuntimeCopy accepts it', async () => {
  const f = runtimeFixture();
  const r = await prepareRuntimeCopy({ installDir: f.install, srcDir: f.src, exeName: 'electron.exe' });
  assert.deepEqual(r, { ok: true, reused: false });
  const v = verifyRuntimeCopy({ installDir: f.install, srcDir: f.src, exeName: 'electron.exe' });
  assert.equal(v.ok, true);
  const dir = runtimeCopyDir(f.install);
  assert.equal(readFileSync(join(dir, 'locales', 'en-US.pak'), 'utf8'), 'pak');
  assert.equal(readFileSync(join(dir, 'electron.exe')).length, 50_000);
  assert.equal(readdirSync(join(f.install, '.update')).filter((n) => n.includes('tmp')).length, 0, 'no half-built folder is left behind');
});

test('a second prepare reuses a copy that still verifies', async () => {
  const f = runtimeFixture();
  await prepareRuntimeCopy({ installDir: f.install, srcDir: f.src, exeName: 'electron.exe' });
  assert.deepEqual(await prepareRuntimeCopy({ installDir: f.install, srcDir: f.src, exeName: 'electron.exe' }), { ok: true, reused: true });
});

test('verifyRuntimeCopy refuses: no copy, a changed exe size, a file added or removed in the source, a truncated copy', async () => {
  const f = runtimeFixture();
  const args = { installDir: f.install, srcDir: f.src, exeName: 'electron.exe' };
  assert.equal(verifyRuntimeCopy(args).ok, false, 'nothing prepared yet');
  await prepareRuntimeCopy(args);
  assert.equal(verifyRuntimeCopy(args).ok, true);
  writeFileSync(join(f.src, 'extra.dll'), 'x');
  assert.equal(verifyRuntimeCopy(args).ok, false, 'the runtime changed after the copy was made: stale');
  await prepareRuntimeCopy(args); // rebuilds
  assert.equal(verifyRuntimeCopy(args).ok, true);
  writeFileSync(join(runtimeCopyDir(f.install), 'electron.exe'), Buffer.alloc(10));
  const v = verifyRuntimeCopy(args);
  assert.equal(v.ok, false, 'a copy whose exe is not the right size is never used');
  writeFileSync(join(f.src, 'electron.exe'), Buffer.alloc(50_001));
  assert.equal(verifyRuntimeCopy(args).ok, false);
});

test('prepareRuntimeCopy rebuilds a stale copy and leaves nothing half-built when the source is gone', async () => {
  const f = runtimeFixture();
  const args = { installDir: f.install, srcDir: f.src, exeName: 'electron.exe' };
  await prepareRuntimeCopy(args);
  writeFileSync(join(f.src, 'extra.dll'), 'x');
  assert.deepEqual(await prepareRuntimeCopy(args), { ok: true, reused: false });
  assert.equal(verifyRuntimeCopy(args).ok, true);
  const bad = await prepareRuntimeCopy({ ...args, srcDir: join(f.install, 'nope') });
  assert.equal(bad.ok, false);
  assert.equal(readdirSync(join(f.install, '.update')).filter((n) => n.includes('tmp')).length, 0);
});

test('planApplySpawn: a verified copy is used (re-exec guard set); a missing or stale copy falls back to the running runtime', async () => {
  const f = runtimeFixture();
  const args = { installDir: f.install, srcDir: f.src, exeName: 'electron.exe' };
  const fallback = planApplySpawn(args);
  assert.equal(fallback.fromCopy, false);
  assert.equal(fallback.cmd, f.exe);
  assert.equal(fallback.env.LEGION_APPLY_REEXEC, undefined, 'the existing re-exec fallback stays in charge');
  await prepareRuntimeCopy(args);
  const ready = planApplySpawn(args);
  assert.equal(ready.fromCopy, true);
  assert.equal(ready.cmd, join(runtimeCopyDir(f.install), 'electron.exe'));
  assert.equal(ready.env.LEGION_APPLY_REEXEC, '1', 'no 368 MB copy at apply time');
  writeFileSync(join(f.src, 'extra.dll'), 'x');
  assert.equal(planApplySpawn(args).fromCopy, false);
});

test('removeRuntimeCopy deletes the copy and nothing else', async () => {
  const f = runtimeFixture();
  const args = { installDir: f.install, srcDir: f.src, exeName: 'electron.exe' };
  await prepareRuntimeCopy(args);
  mkdirSync(join(f.install, '.update', 'staging'), { recursive: true });
  assert.equal(await removeRuntimeCopy(f.install), true);
  assert.equal(existsSync(runtimeCopyDir(f.install)), false);
  assert.ok(existsSync(join(f.install, '.update', 'staging')));
  assert.ok(existsSync(f.exe));
});

// ---- cleanup after a successful update
async function committedInstall(): Promise<{ install: string; src: string }> {
  const f = runtimeFixture();
  put(f.install, { 'package.json': '{"version":"1.0.0"}', 'dist/a.js': 'old', 'dist-ui/i.html': 'o', 'node_modules/x/y.js': 'o' });
  const staged = join(f.install, '.update', 'staging', '1.1.0', 'x', 'legion-1.1.0');
  put(staged, { 'package.json': '{"version":"1.1.0"}', 'dist/a.js': 'new', 'dist-ui/i.html': 'n', 'node_modules/x/y.js': 'n', 'runtime/electron/electron.exe': 'n' });
  await prepareRuntimeCopy({ installDir: f.install, srcDir: f.src, exeName: 'electron.exe' });
  await swapIn({ installDir: f.install, stagedDir: staged, from: '1.0.0', to: '1.1.0', names: FULL_PACKAGE_SET });
  return { install: f.install, src: join(f.install, 'runtime', 'electron') };
}
function put(root: string, files: Record<string, string>): void {
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), c); }
}

test('cleanupRuntimeCopy: removed once the update is committed and no marker is live; kept before that', async () => {
  const c = await committedInstall();
  assert.equal(await cleanupRuntimeCopy(c.install), false, 'journal is still awaiting-health: the helper may be running from it');
  assert.ok(existsSync(runtimeCopyDir(c.install)));
  await new Promise((r) => setTimeout(r, 15)); // the commit must be later than the stamp
  markCommitted(c.install);
  writeFileSync(join(c.install, '.update', MARKER_FILE_NAME), JSON.stringify({ pid: 1, startTimeMs: 1, fromVersion: '1.0.0', toVersion: '1.1.0', startedAt: Date.now(), heartbeat: Date.now() }));
  assert.equal(await cleanupRuntimeCopy(c.install), false, 'the helper has not ended its marker yet');
  writeFileSync(join(c.install, '.update', MARKER_FILE_NAME), '');
  const { rmSync } = await import('node:fs');
  rmSync(join(c.install, '.update', MARKER_FILE_NAME));
  assert.equal(await cleanupRuntimeCopy(c.install), true);
  assert.equal(existsSync(runtimeCopyDir(c.install)), false);
  assert.equal(readJournal(c.install)?.state, 'committed');
});

test('cleanupRuntimeCopy keeps a copy that was prepared AFTER the last commit (it is for the next update)', async () => {
  const c = await committedInstall();
  markCommitted(c.install);
  await removeRuntimeCopy(c.install);
  await new Promise((r) => setTimeout(r, 15));
  await prepareRuntimeCopy({ installDir: c.install, srcDir: c.src, exeName: 'electron.exe' });
  assert.equal(await cleanupRuntimeCopy(c.install), false);
  assert.ok(existsSync(runtimeCopyDir(c.install)));
});
