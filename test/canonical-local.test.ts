// test/canonical-local.test.ts: one spelling for a local path; the protected set; workspaces stay free
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { tempDir } from './tmp-cleanup.js';
import { canonicalLocal, dataFolderTargets, isOpaqueDevicePath, isProtected, protectedTargets } from '../src/core/exec/canonical-path.js';

const win = process.platform === 'win32';
const opts = { skip: !win };
const root = tempDir('legion-canon-');
const data = join(root, 'Fake Data Folder');
mkdirSync(join(data, 'gates'), { recursive: true });
mkdirSync(join(data, 'workspaces', 'builder'), { recursive: true });
writeFileSync(join(data, 'state.json'), '{}');
const want = (p: string): string => resolve(p).toLowerCase();
const drive = data.slice(0, 1);
const rest = data.slice(2).replace(/\\/g, '/'); // /Users/..../Fake Data Folder
const share = (host: string, sep: '\\' | '/'): string => `${sep}${sep}${host}${sep}${drive}$${rest.replace(/\//g, sep)}${sep}state.json`;

test('every spelling of this computer folds to the drive path', opts, () => {
  const target = want(join(data, 'state.json'));
  const spellings = [
    join(data, 'state.json'), data.replace(/\\/g, '/') + '/state.json', `\\\\?\\${join(data, 'state.json')}`, `//?/${data.replace(/\\/g, '/')}/state.json`,
    `\\\\?\\UNC\\localhost\\${drive}$${rest.replace(/\//g, '\\')}\\state.json`,
    share('localhost', '\\'), share('127.0.0.1', '\\'), share('[::1]', '\\'), share(hostname(), '\\'), share(hostname().toUpperCase(), '\\'),
    share('localhost', '/'), share('127.0.0.1', '/'), share('[::1]', '/'), share(hostname(), '/'),
  ];
  for (const s of spellings) assert.equal(canonicalLocal(s), target, s);
});

test('trailing dots and spaces, dot and dot-dot steps', opts, () => {
  const target = want(join(data, 'state.json'));
  for (const s of [`${data}\\state.json.`, `${data}\\state.json. .`, `${data}\\state.json `, `${data}. \\state.json`, `${data}\\.\\state.json`, `${data}\\gates\\..\\state.json`, `${data}\\workspaces\\builder\\..\\..\\state.json`, `${data}\\gates...\\..\\state.json`]) assert.equal(canonicalLocal(s), target, s);
});

test('a relative path resolves against cwd', opts, () => {
  assert.equal(canonicalLocal('state.json', { cwd: data }), want(join(data, 'state.json')));
  assert.equal(canonicalLocal('..\\state.json', { cwd: join(data, 'gates') }), want(join(data, 'state.json')));
  assert.equal(canonicalLocal('..\\..\\state.json', { cwd: join(data, 'workspaces', 'builder') }), want(join(data, 'state.json')));
});

test('a short 8.3 name and a junction resolve to the real name, even for a file that does not exist yet', opts, () => {
  let short = '';
  try { short = execSync(`cmd /c for %I in ("${data}") do @echo %~sI`, { encoding: 'utf8' }).trim(); } catch { /* none */ }
  if (short && short.toLowerCase() !== data.toLowerCase()) assert.equal(canonicalLocal(join(short, 'gates', 'app.json')), want(join(data, 'gates', 'app.json')), short);
  const link = join(root, 'link-to-data');
  symlinkSync(data, link, 'junction');
  assert.equal(canonicalLocal(join(link, 'gates', 'new.json')), want(join(data, 'gates', 'new.json')));
});

test('opaque device paths are named', () => {
  assert.equal(isOpaqueDevicePath('\\\\?\\Volume{1234}\\x'), true);
  assert.equal(isOpaqueDevicePath('\\\\.\\GLOBALROOT\\Device\\HarddiskVolume3\\x'), true);
  assert.equal(isOpaqueDevicePath('\\\\?\\C:\\x'), false);
  assert.equal(isOpaqueDevicePath('C:\\x'), false);
});

test('the protected set: the five names plus module paths; workspaces and other folders stay free', opts, () => {
  const away = join(data, 'away');
  const set = protectedTargets(data, [{ protectedPaths: () => [away] }, {}]);
  assert.deepEqual(dataFolderTargets(data).map((p) => p.slice(data.length + 1)), ['gates', 'gates-key.bin', 'gates-key.unconfirmed', 'config.json', 'state.json', 'projects.json', 'connectors', 'providers']);
  for (const p of [join(data, 'gates', 'app.json'), join(data, 'gates-key.bin'), join(data, 'config.json'), join(data, 'state.json'), join(data, 'projects.json'), join(away, 'p.json'), share('localhost', '\\'), `${data}\\state.json.`, '\\\\?\\Volume{1}\\x']) assert.equal(isProtected(p, set), true, p);
  assert.equal(isProtected('state.json', set, data), true);
  for (const p of [join(data, 'workspaces', 'builder', 'a.md'), join(data, 'workspaces'), join(data, 'other', 'x.txt'), join(root, 'elsewhere.txt'), join(data, 'state.json.bak2')]) assert.equal(isProtected(p, set), false, p);
});
