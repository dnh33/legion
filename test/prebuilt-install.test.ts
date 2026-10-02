/** The package installer (scripts/package-install.mjs): verification while copying, refused folders, swap + rollback, no touch of the data folder. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakePackage, installer, lib, put, tmp } from './prebuilt-helpers.js';

const ok = () => null;

test('install: a good package is copied, verified, swapped in; .update keeps no spare copy; the source is untouched', async () => {
  const { installPackage } = await installer();
  const src = await fakePackage(); const dest = join(tmp(), 'Legion');
  const r = await installPackage({ src, dest, smoke: ok });
  assert.equal(r.version, '0.9.0'); assert.equal(r.inPlace, false);
  for (const f of ['package.json', 'build-info.json', 'dist/src/electron/main.js', 'runtime/electron/electron.exe', 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe']) assert.ok(existsSync(join(dest, f)), f);
  assert.equal(existsSync(join(dest, 'PACKAGE-FILES.json')), false, 'the install-time list is not installed');
  assert.equal(existsSync(join(dest, '.update', 'prev')), false);
  assert.equal(existsSync(join(dest, '.update', 'staging')), false);
  assert.ok(existsSync(join(src, 'PACKAGE-FILES.json')) && existsSync(join(src, 'package.json')));
});

test('install: the real smoke test runs the installed runtime and the bundled claude (fakes)', async () => {
  if (process.platform === 'win32') return;
  const { installPackage, realSmoke } = await installer();
  const src = await fakePackage(); const dest = join(tmp(), 'Legion');
  await installPackage({ src, dest });
  assert.equal(realSmoke(dest), null);
});

test('install: re-run is idempotent and an update replaces the code, node_modules and runtime; unrelated files in the folder survive', async () => {
  const { installPackage } = await installer();
  const dest = join(tmp(), 'Legion');
  await installPackage({ src: await fakePackage({ version: '0.9.0' }), dest, smoke: ok });
  put(dest, 'uninstall.cmd', 'rem mine');
  const again = await installPackage({ src: await fakePackage({ version: '0.9.0' }), dest, smoke: ok });
  assert.equal(again.from, '0.9.0');
  const up = await installPackage({ src: await fakePackage({ version: '0.9.1', extra: { 'node_modules/new/index.js': 'n' } }), dest, smoke: ok });
  assert.equal(up.from, '0.9.0'); assert.equal(up.version, '0.9.1');
  assert.equal(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).version, '0.9.1');
  assert.ok(existsSync(join(dest, 'node_modules/new/index.js')));
  assert.equal(readFileSync(join(dest, 'uninstall.cmd'), 'utf8'), 'rem mine', 'uninstall.cmd is not touched');
  assert.equal(existsSync(join(dest, '.update', 'prev')), false);
});

test('install: never touches the data folder, and refuses a destination that is, holds or sits inside it', async () => {
  const { installPackage } = await installer();
  const data = tmp('prebuilt-data-'); put(data, 'config.json', '{"authToken":"x"}');
  const src = await fakePackage();
  for (const dest of [data, join(data, 'app'), join(data, '..')]) {
    await assert.rejects(installPackage({ src, dest, dataDirs: [data], smoke: ok }), (e: any) => e.code === 'unsafe-dest');
  }
  assert.equal(readFileSync(join(data, 'config.json'), 'utf8'), '{"authToken":"x"}');
  assert.deepEqual(readdirSync(data), ['config.json']);
  const ok2 = join(tmp(), 'Legion');
  await installPackage({ src, dest: ok2, dataDirs: [data], smoke: ok });
  assert.deepEqual(readdirSync(data), ['config.json']);
});

test('install: refuses a drive-style root, a foreign non-empty folder, a link, and folders inside each other', async () => {
  const { installPackage } = await installer();
  const src = await fakePackage();
  await assert.rejects(installPackage({ src, dest: 'C:\\', smoke: ok }), (e: any) => e.code === 'unsafe-dest');
  await assert.rejects(installPackage({ src, dest: '/', smoke: ok }), (e: any) => e.code === 'unsafe-dest');
  const foreign = tmp(); put(foreign, 'precious.txt', 'keep');
  await assert.rejects(installPackage({ src, dest: foreign, smoke: ok }), (e: any) => e.code === 'unsafe-dest');
  assert.equal(readFileSync(join(foreign, 'precious.txt'), 'utf8'), 'keep');
  const base = tmp(); const target = join(base, 'real'); mkdirSync(target);
  if (process.platform !== 'win32') { symlinkSync(target, join(base, 'link')); await assert.rejects(installPackage({ src, dest: join(base, 'link'), smoke: ok }), (e: any) => e.code === 'unsafe-dest'); }
  await assert.rejects(installPackage({ src, dest: join(src, 'inner'), smoke: ok }), (e: any) => e.code === 'unsafe-dest');
});

test('install: a package that does not match its file list is refused before anything is installed (changed byte, missing file, extra file, link, stray top-level name)', async () => {
  const { installPackage } = await installer();
  const cases: Array<[string, (src: string) => void, string]> = [
    ['changed byte', (s) => put(s, 'dist/src/bin/legion-core.js', '// c0re'), 'incomplete'],
    ['missing file', (s) => { rmSync(join(s, 'dist-ui', 'index.html')); }, 'blocked'],
    ['extra file', (s) => put(s, 'dist/src/evil.js', 'x'), 'incomplete'],
    ['stray top-level', (s) => put(s, 'evil.exe', 'x'), 'incomplete'],
  ];
  if (process.platform !== 'win32') cases.push(['link', (s) => symlinkSync('/etc/passwd', join(s, 'assets', 'l')), 'incomplete']);
  for (const [name, mutate, code] of cases) {
    const src = await fakePackage(); mutate(src); const dest = join(tmp(), 'Legion');
    await assert.rejects(installPackage({ src, dest, smoke: ok }), (e: any) => e.code === code, name);
    assert.equal(existsSync(join(dest, 'package.json')), false, `${name}: nothing installed`);
  }
});

test('install: a changed byte is caught WHILE copying too (list says one thing, bytes another), and the old install stays', async () => {
  const { installPackage } = await installer();
  const dest = join(tmp(), 'Legion');
  await installPackage({ src: await fakePackage({ version: '0.9.0' }), dest, smoke: ok });
  const src = await fakePackage({ version: '0.9.1' });
  const l = JSON.parse(readFileSync(join(src, 'PACKAGE-FILES.json'), 'utf8')); l.files.find((f: any) => f.path === 'assets/icon.ico').sha256 = 'a'.repeat(64);
  writeFileSync(join(src, 'PACKAGE-FILES.json'), JSON.stringify(l));
  await assert.rejects(installPackage({ src, dest, smoke: ok }), (e: any) => e.code === 'incomplete');
  assert.equal(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).version, '0.9.0');
  assert.equal(existsSync(join(dest, '.update', 'staging')), false);
});

test('install: a failing start test rolls back to the previous build, names the file, does not retry (exit code 3)', async () => {
  const { installPackage, InstallError } = await installer();
  const dest = join(tmp(), 'Legion');
  await installPackage({ src: await fakePackage({ version: '0.9.0' }), dest, smoke: ok });
  let calls = 0;
  const err = await installPackage({ src: await fakePackage({ version: '0.9.1' }), dest, smoke: () => { calls++; return 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'; } }).catch((e: unknown) => e as any);
  assert.ok(err instanceof InstallError); assert.equal(err.code, 'smoke'); assert.equal(err.exitCode, 3); assert.equal(calls, 1, 'one attempt, no retry loop');
  assert.match(err.message, /antivirus blocked or removed .*claude\.exe.*did not retry.*Protection history/s);
  assert.equal(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).version, '0.9.0', 'the previous version is back');
  assert.ok(existsSync(join(dest, 'runtime/electron/electron.exe')));
});

test('install: a first install whose start test fails leaves no half-install behind in package.json', async () => {
  const { installPackage } = await installer();
  const dest = join(tmp(), 'Legion');
  await assert.rejects(installPackage({ src: await fakePackage(), dest, smoke: () => 'runtime/electron/electron.exe' }), (e: any) => e.code === 'smoke');
  assert.equal(existsSync(join(dest, 'package.json')), false);
  assert.equal(existsSync(join(dest, 'runtime')), false);
});

test('install: in place (the package folder is the install folder) only verifies and smoke-tests; nothing is moved', async () => {
  const { installPackage } = await installer();
  const src = await fakePackage();
  const r = await installPackage({ src, dest: src, smoke: ok });
  assert.equal(r.inPlace, true);
  assert.equal(existsSync(join(src, '.update')), false);
  put(src, 'dist/src/bin/legion-core.js', '// tampered');
  await assert.rejects(installPackage({ src, dest: src, smoke: ok }), (e: any) => e.code === 'incomplete');
});

test('install: a package for another platform or a source folder is not a package', async () => {
  const { installPackage } = await installer();
  await assert.rejects(installPackage({ src: await fakePackage({ platform: 'linux-x64' }), dest: join(tmp(), 'L'), smoke: ok }), (e: any) => e.code === 'not-package');
  const srcLike = tmp(); put(srcLike, 'package.json', '{"name":"legion"}'); put(srcLike, 'src/a.ts', '');
  await assert.rejects(installPackage({ src: srcLike, dest: join(tmp(), 'L'), smoke: ok }), (e: any) => e.code === 'not-package');
});

test('install: the file list is parsed strictly (traversal, device names, duplicates, unknown top-level names, bad hashes)', async () => {
  const { parseFilesList, packageTopNames } = await lib();
  const top = packageTopNames(['dist', 'package.json']);
  const f = (path: string, extra: object = {}) => JSON.stringify({ schema: 1, files: [{ path, size: 1, sha256: 'a'.repeat(64), ...extra }] });
  assert.equal(parseFilesList(f('dist/a.js'), top).length, 1);
  for (const bad of ['../x', '/abs', 'dist\\a', 'dist/../a', 'C:/x', 'dist/con.js', 'dist/a.', 'evil/a.js', 'dist//a']) assert.throws(() => parseFilesList(f(bad), top), /./, bad);
  assert.throws(() => parseFilesList(f('dist/a.js', { sha256: 'xyz' }), top));
  assert.throws(() => parseFilesList(JSON.stringify({ schema: 1, files: [{ path: 'dist/a', size: 1, sha256: 'a'.repeat(64) }, { path: 'DIST/A', size: 1, sha256: 'a'.repeat(64) }] }), top));
  assert.throws(() => parseFilesList(f('dist/' + 'x'.repeat(250)), top));
  assert.throws(() => parseFilesList('{', top));
});

test('install: lstat sanity - the fake package really has no links (guards the fixture)', async () => {
  const src = await fakePackage();
  assert.equal(lstatSync(join(src, 'runtime', 'electron', 'electron.exe')).isSymbolicLink(), false);
});
