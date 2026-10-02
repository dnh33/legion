/** scripts/build-package.mjs with a fake electron and a fake claude: layout, pruning, SDK check, determinism, subset, round trip through the installer and the updater's stager. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { load, builtTree, fakeElectronDist, fakeNodeModules, FAKE_CLAUDE, installer, put, sha, tmp } from './prebuilt-helpers.js';
const { readZipEntry, listZipNames } = await load('scripts/lib/release-lib.mjs');

const AT = '2026-10-20T10:00:00Z';
async function build(over: Record<string, unknown> = {}) {
  const { buildPackage } = await load('scripts/build-package.mjs');
  const out = tmp('prebuilt-out-');
  const r = await buildPackage({ repo: process.cwd(), root: builtTree(), out, publishedAt: AT, commit: 'abc1234', dirty: false, nodeModules: fakeNodeModules(), electronDist: fakeElectronDist(), electronVersion: '44.5.1', selfcheck: true, ...over });
  return { r, out };
}

test('build: layout, build-info, file list, sums; no src, no tests, no .bin, no other SDK platform', async () => {
  const { r, out } = await build();
  const zip = readFileSync(r.zip); const names: string[] = listZipNames(zip);
  const top = 'legion-0.9.0/';
  assert.deepEqual(names, [...names].sort(), 'entries are sorted');
  for (const must of ['package.json', 'build-info.json', 'PACKAGE-FILES.json', 'runtime/electron/electron.exe', 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe', 'node_modules/zod/index.js', 'dist/src/electron/main.js', 'setup.cmd']) assert.ok(names.includes(top + must), must);
  for (const never of ['dist/test/a.test.js', 'src/core/a.ts', 'node_modules/.bin/zod.cmd', 'node_modules/.package-lock.json', 'node_modules/@anthropic-ai/claude-agent-sdk-win32-arm64/claude.exe', 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude']) assert.ok(!names.includes(top + never), never);
  const info = JSON.parse(readZipEntry(zip, top + 'build-info.json').toString());
  assert.deepEqual({ ...info, sdkBinarySha256: undefined }, { platform: 'win32-x64', kind: 'package', builtAt: AT, commit: 'abc1234', dirty: false, electron: '44.5.1', sdk: '0.3.285', version: '0.9.0', publishedAt: AT, sdkBinarySha256: undefined });
  assert.equal(info.sdkBinarySha256, sha(FAKE_CLAUDE));
  const sums = readFileSync(join(out, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
  assert.deepEqual(sums.map((l) => l.slice(66)), ['legion-0.9.0-app.zip', 'legion-0.9.0-win-x64.zip', 'legion-update-manifest.json']);
  assert.equal(sums[1]!.slice(0, 64), sha(zip)); assert.equal(sums[1]!.slice(0, 64), r.sha256);
  assert.ok(existsSync(join(out, 'legion-update-manifest.json')) && !existsSync(join(out, 'legion-update-manifest.json.sig')), 'never signed here');
  assert.ok(!existsSync(join(out, '.work')), 'scratch removed');
});

test('build: the update zip is a byte-exact subset of the full zip (one format), and the manifest matches the update zip', async () => {
  const { r, out } = await build();
  const full = readFileSync(r.zip); const app = readFileSync(r.appZip);
  const appNames: string[] = listZipNames(app); assert.ok(appNames.length > 5);
  for (const n of appNames) assert.ok(readZipEntry(full, n).equals(readZipEntry(app, n)), n);
  const m = JSON.parse(readFileSync(join(out, 'legion-update-manifest.json'), 'utf8'));
  assert.equal(m.asset.sha256, sha(app)); assert.equal(m.asset.name, 'legion-0.9.0-app.zip');
  assert.ok(!appNames.some((n) => n.includes('node_modules') || n.includes('runtime/')), 'the update zip carries no runtime and no node_modules');
});

test('build: reproducible (same inputs twice give the same bytes) and the timestamps are fixed', async () => {
  const root = builtTree(); const nm = () => fakeNodeModules(); const el = fakeElectronDist();
  const a = await build({ root, nodeModules: nm(), electronDist: el }); const b = await build({ root, nodeModules: nm(), electronDist: el });
  assert.equal(a.r.sha256, b.r.sha256);
  assert.ok(readFileSync(a.r.zip).equals(readFileSync(b.r.zip)));
  const z = readFileSync(a.r.zip); assert.equal(z.readUInt16LE(12), 0x21); assert.equal(z.readUInt16LE(10), 0);
});

test('build: the finished zip is read back by the strict reader and passes the installer; the installer then installs it', async () => {
  const { r } = await build();
  const { extractZip } = await load('dist/src/core/blender/zip.js');
  const { installPackage } = await installer();
  const { createReadStream, createWriteStream, mkdirSync, openSync, fstatSync, readSync } = await import('node:fs');
  const dir = tmp('prebuilt-x-'); const fd = openSync(r.zip, 'r');
  await extractZip({ size: fstatSync(fd).size, read: async (o: number, l: number) => { const b = Buffer.alloc(l); const n = readSync(fd, b, 0, l, o); return b.subarray(0, n); }, stream: (s: number, e: number) => createReadStream(r.zip, { start: s, end: e }) },
    { mkdirp: (d: string) => mkdirSync(d, { recursive: true }), openWrite: (f: string) => createWriteStream(f, { flags: 'wx' }) }, dir, 'legion-0.9.0', { maxEntries: 20000, maxUnpackedBytes: 1e9 });
  const dest = join(tmp(), 'Legion');
  const res = await installPackage({ src: join(dir, 'legion-0.9.0'), dest, smoke: () => null }); // the strict reader does not set file modes, so the fake exes are not runnable here
  assert.equal(res.version, '0.9.0');
  assert.equal(readFileSync(join(dest, 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'), 'utf8'), FAKE_CLAUDE);
});

test('build: refuses a claude.exe that differs from the SDK manifest, a missing one, a wrong Electron version, a missing electron.exe', async () => {
  const bad = fakeNodeModules(); put(bad, '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe', 'tampered', true);
  await assert.rejects(build({ nodeModules: bad }), /does not match the checksum in the SDK manifest/);
  const nonModules = fakeNodeModules(); rmSync(join(nonModules, '@anthropic-ai/claude-agent-sdk-win32-x64'), { recursive: true });
  await assert.rejects(build({ nodeModules: nonModules }), /claude\.exe is missing/);
  await assert.rejects(build({ electronVersion: '43.0.0' }), /lock pins 44\.5\.1/);
  const noExe = fakeElectronDist(); rmSync(join(noExe, 'electron.exe'));
  await assert.rejects(build({ electronDist: noExe }), /electron\.exe is missing/);
  await assert.rejects(build({ publishedAt: 'yesterday' }), /publishedAt/);
});

test('build: refuses names Windows or the installer would refuse (device name, overlong path) instead of shipping them', async () => {
  const dev = fakeNodeModules(); put(dev, 'badpkg/con.js', 'x');
  await assert.rejects(build({ nodeModules: dev }), /reserved device name/);
  const long = fakeNodeModules(); put(long, 'deep/' + 'a'.repeat(120) + '/' + 'b'.repeat(100) + '.js', 'x');
  await assert.rejects(build({ nodeModules: long, selfcheck: false }), /path too long for Windows/);
});

test('build: the CLI refuses a non-Windows host (no foreign flag) and a dirty tree', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = (...a: string[]) => spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'build-package.mjs'), ...a], { encoding: 'utf8' });
  if (process.platform !== 'win32') { const r = run('--out', tmp()); assert.notEqual(r.status, 0); assert.match(r.stderr, /run it on Windows x64/); }
  const r2 = run('--out', tmp(), '--foreign'); assert.notEqual(r2.status, 0); assert.match(r2.stderr, /--foreign needs --node-modules/);
});

test('zip writer: refuses unsorted or duplicate entries, writes nothing on failure, and stores empty files', async () => {
  const { writeZipFile } = await load('scripts/lib/zip-stream.mjs');
  const f = join(tmp(), 'a.zip');
  assert.throws(() => writeZipFile(f, [{ name: 'b', data: Buffer.from('1') }, { name: 'a', data: Buffer.from('2') }]), /not sorted/);
  assert.throws(() => writeZipFile(f, [{ name: 'a', data: Buffer.from('1') }, { name: 'a', data: Buffer.from('2') }]), /not sorted/);
  assert.equal(existsSync(f), false); assert.equal(existsSync(f + '.part'), false);
  const w = writeZipFile(f, [{ name: 'a', data: Buffer.alloc(0) }, { name: 'b', data: Buffer.from('hello') }]);
  const z = readFileSync(f); assert.equal(w.sha256, sha(z)); assert.equal(readZipEntry(z, 'b').toString(), 'hello'); assert.equal(readZipEntry(z, 'a').length, 0);
});
