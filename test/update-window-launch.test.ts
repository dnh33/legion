/** How the "Updating Legion" window is started on a packaged runtime (no default_app.asar; resources/app holds Legion's own shim). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { realWindow, windowLaunchPlan } from '../src/core/updater/apply.js';

const SHIM = '{"name":"legion","version":"0.3.1","main":"../../../../dist/src/electron/main.js"}\r\næ ';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('plan: a dev runtime with default_app.asar and no app shim takes the folder argument', () => {
  const install = join(parse(tmpdir()).root, 'legion-inst-test');
  assert.equal(windowLaunchPlan({ runtimeDir: join(install, 'node_modules', 'electron', 'dist'), installDir: install, hasAppShim: false, hasDefaultApp: true }), 'folder');
});

test('plan: the prepared runtime copy inside .update, and a copy in the temp folder, are patched', () => {
  const install = join(parse(tmpdir()).root, 'legion-inst-test');
  assert.equal(windowLaunchPlan({ runtimeDir: join(install, '.update', 'runtime-copy'), installDir: install, hasAppShim: true, hasDefaultApp: false }), 'patch');
  assert.equal(windowLaunchPlan({ runtimeDir: join(tmpdir(), 'legion-apply-1234'), installDir: install, hasAppShim: true, hasDefaultApp: false }), 'patch');
});

test('plan: the install\'s own runtime is never patched, in any spelling', () => {
  const install = join(parse(tmpdir()).root, 'legion-inst-test');
  const own = join(install, 'runtime', 'electron');
  assert.equal(windowLaunchPlan({ runtimeDir: own, installDir: install, hasAppShim: true, hasDefaultApp: false }), 'none');
  assert.equal(windowLaunchPlan({ runtimeDir: join(install, 'x', '..', 'runtime', 'electron'), installDir: install, hasAppShim: true, hasDefaultApp: false }), 'none');
  if (process.platform === 'win32') assert.equal(windowLaunchPlan({ runtimeDir: own.toUpperCase(), installDir: install, hasAppShim: true, hasDefaultApp: false }), 'none');
});

test('plan: a path that only looks like it is inside .update or the temp folder is none', () => {
  const install = join(parse(tmpdir()).root, 'legion-inst-test');
  for (const runtimeDir of [join(install, '.update-evil', 'rt'), join(install, '.updatex'), join(install, '.update', '..', 'elsewhere'), join('D:', 'somewhere', 'electron'), `${tmpdir()}-other${'/'}rt`]) {
    assert.equal(windowLaunchPlan({ runtimeDir, installDir: install, hasAppShim: true, hasDefaultApp: false }), 'none', runtimeDir);
  }
});

test('plan: no shim and no default app means no window', () => {
  const install = join(parse(tmpdir()).root, 'legion-inst-test');
  assert.equal(windowLaunchPlan({ runtimeDir: join(install, '.update', 'rt'), installDir: install, hasAppShim: false, hasDefaultApp: false }), 'none');
});

interface Rig { install: string; shim: string; dir: string; lines: string[]; spawned: Array<{ cmd: string; args: string[]; opts: { stdio?: unknown; env?: Record<string, string | undefined> } }>; make: (restoreAfterMs?: number, spawnThrows?: boolean) => ReturnType<typeof realWindow>; cleanup: () => void }
function rig(): Rig {
  const install = mkdtempSync(join(tmpdir(), 'lwl-'));
  const rt = join(install, '.update', 'runtime-copy');
  const shim = join(rt, 'resources', 'app', 'package.json');
  mkdirSync(join(rt, 'resources', 'app'), { recursive: true });
  writeFileSync(shim, Buffer.from(SHIM, 'utf8'));
  const dir = join(install, '.update', 'run', 'window');
  mkdirSync(join(dir, 'dist', 'src', 'electron'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{}');
  const lines: string[] = [];
  const spawned: Rig['spawned'] = [];
  const make = (restoreAfterMs = 10_000, spawnThrows = false) => realWindow(install, { updateId: 'u1', from: '0.3.0', to: '0.3.1', window: { enabled: true, userData: join(install, 'ud'), args: ['--force-device-scale-factor=1'] } }, (l) => lines.push(l), {
    execPath: join(rt, 'electron.exe'), restoreAfterMs, pollMs: 20,
    spawn: ((cmd: string, args: string[], opts: Rig['spawned'][number]['opts']) => { if (spawnThrows) throw new Error('spawn failed'); spawned.push({ cmd, args, opts }); return { pid: 4242, on: () => undefined, unref: () => undefined }; }) as never,
  });
  return { install, shim, dir, lines, spawned, make, cleanup: () => { try { rmSync(install, { recursive: true, force: true }); } catch { /* */ } } };
}

test('patch: the shim points at the window while it starts, with no folder argument, and the output goes to a file', () => {
  const r = rig();
  try {
    const w = r.make();
    w.start();
    assert.equal(r.spawned.length, 1);
    assert.deepEqual(r.spawned[0]!.args, ['--force-device-scale-factor=1']);
    const patched = JSON.parse(readFileSync(r.shim, 'utf8')) as { main: string };
    assert.equal(patched.main, '../../../run/window/dist/src/electron/update-window-main.js');
    assert.ok(Array.isArray(r.spawned[0]!.opts.stdio) && typeof (r.spawned[0]!.opts.stdio as unknown[])[1] === 'number', 'stdout and stderr are file descriptors, not pipes');
    assert.ok(existsSync(join(r.dir, 'window-output.log')));
    assert.ok(r.lines.some((l) => l.includes('window: started pid=4242')));
    w.dispose?.();
  } finally { r.cleanup(); }
});

test('patch: restored byte for byte once state.json exists', async () => {
  const r = rig();
  try {
    const w = r.make();
    w.start();
    assert.notEqual(readFileSync(r.shim).toString('utf8'), SHIM);
    writeFileSync(join(r.dir, 'state.json'), '{"lock":"held"}');
    await sleep(150);
    assert.ok(readFileSync(r.shim).equals(Buffer.from(SHIM, 'utf8')));
    assert.ok(r.lines.some((l) => l.includes('back as it was')));
  } finally { r.cleanup(); }
});

test('patch: restored after the time limit when the window never answers', async () => {
  const r = rig();
  try {
    r.make(120).start();
    assert.notEqual(readFileSync(r.shim).toString('utf8'), SHIM);
    await sleep(350);
    assert.ok(readFileSync(r.shim).equals(Buffer.from(SHIM, 'utf8')));
  } finally { r.cleanup(); }
});

test('patch: finish() restores too, even for a window that never started', async () => {
  const r = rig();
  try {
    const w = r.make();
    w.start();
    await w.finish('failed', 'x');
    assert.ok(readFileSync(r.shim).equals(Buffer.from(SHIM, 'utf8')));
  } finally { r.cleanup(); }
});

test('patch: dispose() restores (the helper\'s last step on every exit path)', () => {
  const r = rig();
  try {
    const w = r.make();
    w.start();
    w.dispose?.();
    assert.ok(readFileSync(r.shim).equals(Buffer.from(SHIM, 'utf8')));
    assert.doesNotThrow(() => w.dispose?.());
  } finally { r.cleanup(); }
});

test('patch: a failed spawn restores the shim and logs', () => {
  const r = rig();
  try {
    r.make(10_000, true).start();
    assert.ok(readFileSync(r.shim).equals(Buffer.from(SHIM, 'utf8')));
    assert.ok(r.lines.some((l) => l.includes('could not start')));
  } finally { r.cleanup(); }
});

test('patch: a shim that cannot be written means no spawn and a log line', () => {
  const r = rig();
  try {
    rmSync(r.shim); mkdirSync(r.shim); // a folder where the file should be: neither read nor write works
    r.make().start();
    assert.equal(r.spawned.length, 0);
    assert.ok(r.lines.some((l) => l.includes('window: not started') && l.includes('app shim')));
  } finally { r.cleanup(); }
});

test('none: the install\'s own runtime starts no window and says why', () => {
  const install = mkdtempSync(join(tmpdir(), 'lwl-'));
  try {
    const rt = join(install, 'runtime', 'electron');
    mkdirSync(join(rt, 'resources', 'app'), { recursive: true });
    writeFileSync(join(rt, 'resources', 'app', 'package.json'), SHIM);
    const dir = join(install, '.update', 'run', 'window');
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'package.json'), '{}');
    const lines: string[] = []; let spawns = 0;
    realWindow(install, { updateId: 'u', from: 'a', to: 'b', window: { enabled: true, userData: 'x' } }, (l) => lines.push(l), { execPath: join(rt, 'electron.exe'), spawn: (() => { spawns += 1; return {}; }) as never }).start();
    assert.equal(spawns, 0);
    assert.ok(lines.some((l) => l.includes("window: not started (the helper runs from Legion's own runtime)")));
    assert.equal(readFileSync(join(rt, 'resources', 'app', 'package.json'), 'utf8'), SHIM);
  } finally { rmSync(install, { recursive: true, force: true }); }
});

test('main.ts exits at once when it was started as the update window, before any lock or path', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'electron', 'main.ts'), 'utf8');
  const guard = src.indexOf("process.env.LEGION_UPDATE_WINDOW === '1') process.exit(0)");
  assert.ok(guard > 0, 'the guard exists');
  assert.ok(guard < src.indexOf('const here = '), 'it comes before any path');
  assert.ok(guard < src.indexOf('requestSingleInstanceLock'), 'and before the lock');
});

test('patch: a runtime copy in the temp folder on another drive than the install starts no window and leaves the shim alone', () => {
  // the install on another drive than %TEMP% (the re-exec copy lives in %TEMP%): there is no relative path from the shim to the window
  const otherRoot = process.platform === 'win32' ? ['D:/', 'C:/', 'E:/'].map((d) => parse(join(d, 'x')).root).find((d) => existsSync(d) && parse(tmpdir()).root.toUpperCase() !== d) : undefined;
  if (!otherRoot) return; // needs two drives
  const install = mkdtempSync(join(otherRoot, 'lwl-x-'));
  const rt = mkdtempSync(join(tmpdir(), 'lwl-rt-'));
  try {
    mkdirSync(join(rt, 'resources', 'app'), { recursive: true });
    writeFileSync(join(rt, 'resources', 'app', 'package.json'), SHIM);
    const dir = join(install, '.update', 'run', 'window');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}');
    const lines: string[] = []; let spawns = 0;
    const w = realWindow(install, { updateId: 'u', from: 'a', to: 'b', window: { enabled: true, userData: 'x' } }, (l) => lines.push(l), { execPath: join(rt, 'electron.exe'), spawn: (() => { spawns += 1; return {}; }) as never });
    w.start();
    assert.equal(spawns, 0);
    assert.ok(lines.some((l) => l.includes('window: not started (the runtime copy is on another drive than the install)')), lines.join('\n'));
    assert.equal(readFileSync(join(rt, 'resources', 'app', 'package.json'), 'utf8'), SHIM);
    w.dispose?.();
  } finally { rmSync(install, { recursive: true, force: true }); rmSync(rt, { recursive: true, force: true }); }
});

test('rehearsal hold: only with LEGION_REHEARSAL=1, whole milliseconds, capped at 15 s', async () => {
  const { rehearsalHoldMs } = await import('../src/core/updater/apply.js');
  assert.equal(rehearsalHoldMs({}), 0);
  assert.equal(rehearsalHoldMs({ LEGION_REHEARSAL_HOLD_SWAP_MS: '8000' }), 0, 'never outside a rehearsal');
  assert.equal(rehearsalHoldMs({ LEGION_REHEARSAL: '1', LEGION_REHEARSAL_HOLD_SWAP_MS: '8000' }), 8000);
  assert.equal(rehearsalHoldMs({ LEGION_REHEARSAL: '1', LEGION_REHEARSAL_HOLD_SWAP_MS: '99999' }), 15000);
  for (const bad of ['-1', '1e4', '8000ms', ' 8000', '']) assert.equal(rehearsalHoldMs({ LEGION_REHEARSAL: '1', LEGION_REHEARSAL_HOLD_SWAP_MS: bad }), 0, bad);
});
