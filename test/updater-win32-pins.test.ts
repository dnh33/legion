/**
 * Windows pins for the Mac/Linux updater work (M1, R-M1). Every expectation here is TODAY's output (v0.3.4 behaviour, captured before the change).
 * The calls pass the platform the new code takes; the old code ignored it. The file passes before the change and must still pass after it:
 * that is the proof that Windows behaviour did not move.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { installMode } from '../src/core/updater/index.js';
import { planRelease } from '../src/core/updater/deps-change.js';
import { buildJob, commitMatches, isKnownNameSet } from '../src/core/updater/main-logic.js';
import { CODE_SET, FULL_PACKAGE_SET, windowLaunchPlan } from '../src/core/updater/apply.js';
import { DEFAULTS } from '../src/core/updater/config.js';
import { normalizeSettings } from '../src/core/updater/state.js';

type Fn = (...a: unknown[]) => unknown;
const W = 'win32' as NodeJS.Platform;
const root = join(parse(tmpdir()).root, 'legion-pin');
const trap = (name: string): Fn => () => { throw new Error(`${name} must not be called on win32`); };

test('pin installMode win32: .git is checkout, no .git is apply when writable, unwritable otherwise', () => {
  const call = installMode as unknown as (i: Record<string, unknown>) => string;
  assert.equal(call({ root, platform: W, exists: (p: string) => p.endsWith('.git') }), 'checkout');
  assert.equal(call({ root, platform: W, exists: () => false, writable: () => true }), 'apply');
  assert.equal(call({ root, platform: W, exists: () => false, writable: () => false }), 'unwritable');
});

test('pin installMode win32: a valid install marker is never read; .git still means checkout', () => {
  const call = installMode as unknown as (i: Record<string, unknown>) => string;
  const marker = JSON.stringify({ schema: 1, manager: 'install.sh', dir: root, head: 'a'.repeat(40) });
  assert.equal(call({ root, platform: W, exists: () => true, writable: () => true, readFile: trap('readFile'), realpath: trap('realpath') }), 'checkout');
  assert.equal(call({ root, platform: W, exists: () => true, writable: () => true, readFile: (p: string) => (p.endsWith('HEAD') ? 'a'.repeat(40) : marker), realpath: () => root }), 'checkout');
  // and with no .git the marker hooks are still untouched
  assert.equal(call({ root, platform: W, exists: () => false, writable: () => true, readFile: trap('readFile'), realpath: trap('realpath') }), 'apply');
});

const base = { depsSha256: 'a'.repeat(64) };
const full = { name: 'legion-0.3.5-win-x64.zip', size: 1, sha256: 'b'.repeat(64) };
test('pin planRelease win32: the three routes and their exact reasons', () => {
  const plan = planRelease as unknown as (m: unknown, p: NodeJS.Platform) => { route: string; reason: string };
  assert.deepEqual(plan({ ...base, requiresFullInstall: false }, W), { route: 'code', reason: 'the release does not change dependencies' });
  assert.deepEqual(plan({ ...base, requiresFullInstall: true, fullAsset: full }, W), { route: 'full', reason: 'the release changes dependencies (depsSha256 aaaaaaaaaaaa…) and ships a signed full package' });
  assert.deepEqual(plan({ ...base, requiresFullInstall: true }, W), { route: 'notify', reason: 'the release changes dependencies (depsSha256 aaaaaaaaaaaa…) and carries no signed full package: download its source and run setup.cmd' });
  assert.deepEqual(plan({ ...base, requiresFullInstall: false, fullAsset: full }, W), { route: 'code', reason: 'the release does not change dependencies' });
});

test('pin relaunch win32: the command is electron.exe "<install dir>" with the handoff flag and no extra switches', () => {
  const j = buildJob as unknown as (c: unknown, o: Record<string, unknown>) => { relaunch: unknown };
  const c = { installDir: 'C:/legion', stagedDir: 'C:/legion/.update/staging/0.3.5/x', from: '0.3.4', to: '0.3.5' };
  const want = { cmd: 'C:/legion/electron.exe', args: ['C:/legion'], cwd: 'C:/legion', env: { LEGION_UPDATE_HANDOFF: '1' } };
  assert.deepEqual(j(c, { parentPid: 1, port: 4747, execPath: 'C:/legion/electron.exe' }).relaunch, want);
  assert.deepEqual(j(c, { parentPid: 1, port: 4747, execPath: 'C:/legion/electron.exe', platform: W, argv: ['--no-sandbox', '--disable-gpu'] }).relaunch, want);
});

test('pin windowLaunchPlan win32: today\'s table', () => {
  const plan = windowLaunchPlan as unknown as (p: Record<string, unknown>) => string;
  const install = join(parse(tmpdir()).root, 'legion-inst-test');
  const dev = join(install, 'node_modules', 'electron', 'dist');
  assert.equal(plan({ runtimeDir: dev, installDir: install, hasAppShim: false, hasDefaultApp: true, platform: W }), 'folder');
  assert.equal(plan({ runtimeDir: dev, installDir: install, hasAppShim: false, hasDefaultApp: false, platform: W }), 'none');
  assert.equal(plan({ runtimeDir: join(install, '.update', 'runtime-copy'), installDir: install, hasAppShim: true, hasDefaultApp: false, platform: W }), 'patch');
  assert.equal(plan({ runtimeDir: join(install, 'runtime', 'electron'), installDir: install, hasAppShim: true, hasDefaultApp: false, platform: W }), 'none');
});

test('pin commitMatches win32: both name sets are accepted, and the sets themselves are frozen', () => {
  const cm = commitMatches as unknown as (c: unknown, d: string, p?: NodeJS.Platform) => boolean;
  const install = join(parse(tmpdir()).root, 'legion-inst-test');
  const c = (names?: readonly string[]) => ({ installDir: install, stagedDir: join(install, '.update', 'staging', '0.3.5', 'x'), from: '0.3.4', to: '0.3.5', ...(names ? { names } : {}) });
  assert.ok(cm(c(), install, W));
  assert.ok(cm(c(CODE_SET), install, W));
  assert.ok(cm(c(FULL_PACKAGE_SET), install, W));
  assert.ok(isKnownNameSet(FULL_PACKAGE_SET));
  assert.deepEqual([...CODE_SET], ['dist', 'dist-ui', 'assets', 'scripts', 'licenses', 'package.json', 'package-lock.json', 'build-info.json', 'NOTICE', 'LICENSE', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'setup.cmd', 'setup-yes.cmd', 'start-legion.cmd']);
  assert.deepEqual([...FULL_PACKAGE_SET], [...CODE_SET, 'node_modules', 'runtime']);
});

test('pin settings: auto-install is off by default and only a real true turns it on', () => {
  assert.equal(DEFAULTS.autoInstallWhenIdle, false);
  assert.equal(normalizeSettings({}).autoInstallWhenIdle, false);
  assert.equal(normalizeSettings({ autoInstallWhenIdle: 'yes' }).autoInstallWhenIdle, false);
  assert.equal(normalizeSettings({ autoInstallWhenIdle: true }).autoInstallWhenIdle, true);
  assert.equal(normalizeSettings({}).updateWindow, true);
});
