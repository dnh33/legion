/** How the core, the stdio proxy and the wrapper commands start in a package install: Electron's own Node, env on the child only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { coreChildEnv, coreStartHint, isPackageInstall, resolveCoreLaunch } from '../src/electron/resolve-node.js';
import { fakePackage, lib, REPO, tmp, put } from './prebuilt-helpers.js';

const root = '/app/legion';
const exe = join(root, 'runtime', 'electron', 'electron.exe');
const info = (o: object) => JSON.stringify(o);
const fsOf = (files: Record<string, string>) => ({ exists: (p: string) => p in files, read: (p: string) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]!; } });
const PKG = { [exe]: '', [join(root, 'build-info.json')]: info({ kind: 'package', platform: 'win32-x64' }) };

test('launch: a package install starts the core with its own electron.exe in node mode, env set for the child only', () => {
  const f = fsOf(PKG);
  const l = resolveCoreLaunch(root, {}, f.exists, f.read);
  assert.equal(l.mode, 'package'); assert.equal(l.cmd, exe); assert.deepEqual(l.env, { ELECTRON_RUN_AS_NODE: '1' });
  const penv: NodeJS.ProcessEnv = {}; resolveCoreLaunch(root, penv, f.exists, f.read); assert.equal(penv.ELECTRON_RUN_AS_NODE, undefined, 'this process is never switched into node mode');
});

test('launch: precedence LEGION_NODE > Legion\'s own runtime\\node > package > node on PATH; a source install is unchanged', () => {
  const own = join(root, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node'); const marker = join(root, 'runtime', 'node', '.legion-owned');
  const all = fsOf({ ...PKG, [own]: '', [marker]: '' });
  assert.deepEqual(resolveCoreLaunch(root, { LEGION_NODE: 'C:\\mine\\node.exe' }, all.exists, all.read), { cmd: 'C:\\mine\\node.exe', env: {}, mode: 'env' });
  assert.equal(resolveCoreLaunch(root, {}, all.exists, all.read).mode, 'runtime');
  assert.equal(resolveCoreLaunch(root, {}, fsOf(PKG).exists, fsOf(PKG).read).mode, 'package');
  const src = fsOf({ [join(root, 'package.json')]: '{}' });
  assert.deepEqual(resolveCoreLaunch(root, {}, src.exists, src.read), { cmd: 'node', env: {}, mode: 'path' });
});

test('launch: package detection needs BOTH build-info (kind package, win32-x64) and the bundled exe; junk build-info is not a package', () => {
  const ok = fsOf(PKG);
  assert.equal(isPackageInstall(root, ok.exists, ok.read), true);
  assert.equal(isPackageInstall(root, fsOf({ [exe]: '' }).exists, fsOf({ [exe]: '' }).read), false, 'no build-info');
  for (const bad of [{ kind: 'package', platform: 'linux-x64' }, { kind: 'source', platform: 'win32-x64' }, { platform: 'win32-x64' }]) {
    const f = fsOf({ [exe]: '', [join(root, 'build-info.json')]: info(bad) }); assert.equal(isPackageInstall(root, f.exists, f.read), false, JSON.stringify(bad));
  }
  const garbage = fsOf({ [exe]: '', [join(root, 'build-info.json')]: '{' }); assert.equal(isPackageInstall(root, garbage.exists, garbage.read), false);
  const noExe = fsOf({ [join(root, 'build-info.json')]: info({ kind: 'package', platform: 'win32-x64' }) }); assert.equal(isPackageInstall(root, noExe.exists, noExe.read), false);
});

test('launch: an update that rewrites build-info.json still leaves a package a package (the update zip carries the same kind)', async () => {
  const { detectKind } = await lib();
  const pkg = await fakePackage();
  assert.equal(detectKind(pkg).kind, 'package');
  put(pkg, 'build-info.json', JSON.stringify({ version: '9.9.9', publishedAt: '2026-10-20T10:00:00Z' }));
  assert.equal(detectKind(pkg).kind, 'unknown', 'a thin build-info would lose the package kind: the build writes the full one into the update zip too');
});

test('launch: detectKind tells a package from a source folder and from nothing', async () => {
  const { detectKind } = await lib();
  assert.deepEqual(detectKind(await fakePackage()), { kind: 'package', version: '0.9.0' });
  const s = tmp(); put(s, 'package.json', '{}'); put(s, 'src/x.ts', ''); assert.equal(detectKind(s).kind, 'source');
  assert.equal(detectKind(tmp()).kind, 'unknown');
  const p = await fakePackage(); put(p, 'src/x.ts', ''); assert.equal(detectKind(p).kind, 'package', 'package wins even if a src folder is there');
});

test('launch: the error text for a package names the runtime and the antivirus, not "install Node"', () => {
  assert.match(coreStartHint('package', 'EPERM'), /runtime\\electron\\electron\.exe.*Protection history.*does not retry/s);
  assert.doesNotMatch(coreStartHint('package'), /winget/);
  assert.match(coreStartHint('path'), /winget install OpenJS\.NodeJS\.LTS/);
  const main = readFileSync(join(REPO, 'src/electron/main.ts'), 'utf8');
  assert.match(main, /coreStartHint\(launch\.mode/); assert.match(main, /\.\.\.process\.env, \.\.\.launch\.env/);
});

test('launch: the stdio proxy keeps the core it starts in node mode when it runs under Electron, and leaves a plain node alone', () => {
  assert.equal(coreChildEnv({ A: '1' }, { electron: '44.5.1' } as unknown as NodeJS.ProcessVersions).ELECTRON_RUN_AS_NODE, '1');
  assert.equal(coreChildEnv({ A: '1' }, {} as NodeJS.ProcessVersions).ELECTRON_RUN_AS_NODE, undefined);
  assert.match(readFileSync(join(REPO, 'src/bin/legion-mcp-stdio.ts'), 'utf8'), /env: coreChildEnv\(process\.env\)/);
});

test('launch: node-mode command construction for a plain command line and for an MCP client config', async () => {
  const { nodeModeCommand, mcpStdioEntry } = await lib();
  const dir = 'C:\\Users\\a b\\AppData\\Local\\Programs\\Legion';
  assert.deepEqual(nodeModeCommand(dir), { command: `${dir}\\runtime\\electron\\electron.exe`, env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.deepEqual(mcpStdioEntry(dir), { command: `${dir}\\runtime\\electron\\electron.exe`, args: [`${dir}\\dist\\src\\bin\\legion-mcp-stdio.js`], env: { ELECTRON_RUN_AS_NODE: '1' } });
});

test('wrappers: the .cmd files run the installed electron.exe in node mode, relative to themselves, with no PATH change and no system node', () => {
  for (const [name, mustRun] of [['legion-node.cmd', /%\*/], ['legion-mcp.cmd', /legion-mcp-stdio\.js/], ['legion-mcp-config.cmd', /mcp-config\.mjs/], ['legion-claude.cmd', /claude\.exe/]] as const) {
    const t = readFileSync(join(REPO, 'scripts', name), 'utf8');
    assert.match(t, /^@echo off/i); assert.match(t, /%~dp0/, `${name} resolves relative to itself`); assert.match(t, mustRun, name);
    assert.doesNotMatch(t, /\bsetx\b|\bPATH\s*=|\bwhere node\b|^\s*node\s/im, `${name}: no PATH edit, no system node`);
    if (name !== 'legion-claude.cmd') { assert.match(t, /ELECTRON_RUN_AS_NODE=1/); assert.match(t, /runtime\\electron\\electron\.exe/); }
    assert.match(t, /setlocal/i, `${name}: env stays inside the script`);
    assert.ok(/\r\n/.test(t) && !/[^\r]\n/.test(t), `${name}: CRLF line ends`);
  }
});

test('mcp-config: in a package it prints the electron command with env; in a source tree it still prints node', () => {
  const run = (root: string) => spawnSync(process.execPath, [join(root, 'scripts', 'mcp-config.mjs')], { encoding: 'utf8', env: { ...process.env, LEGION_HOME: tmp('prebuilt-home-') } });
  const pkg = tmp('prebuilt-cfg-');
  for (const f of ['scripts/mcp-config.mjs', 'scripts/lib/package-lib.mjs']) put(pkg, f, readFileSync(join(REPO, f)));
  put(pkg, 'build-info.json', info({ kind: 'package', platform: 'win32-x64' })); put(pkg, 'runtime/electron/electron.exe', '');
  const a = run(pkg).stdout;
  assert.match(a, /"command": ".*electron\.exe"/); assert.match(a, /"ELECTRON_RUN_AS_NODE": "1"/); assert.match(a, /legion-mcp-stdio\.js/); assert.doesNotMatch(a, /"command": "node"/);
  const src = tmp('prebuilt-cfg-');
  for (const f of ['scripts/mcp-config.mjs', 'scripts/lib/package-lib.mjs']) put(src, f, readFileSync(join(REPO, f)));
  assert.match(run(src).stdout, /"command": "node"/);
});
