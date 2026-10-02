/** Fixtures for the prebuilt-package tests: a fake package tree (fake electron, fake claude), loaders for the plain .mjs scripts. Not a test file. */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const tmp = (p = 'prebuilt-'): string => mkdtempSync(join(tmpdir(), p));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const load = (rel: string): Promise<any> => import(pathToFileURL(join(REPO, ...rel.split('/'))).href);
export const lib = () => load('scripts/lib/package-lib.mjs');
export const installer = () => load('scripts/package-install.mjs');

export const FAKE_ELECTRON = '#!/bin/sh\nexec node "$@"\n';
export const FAKE_CLAUDE = '#!/bin/sh\necho "2.1.285 (fake)"\n';

export function put(root: string, rel: string, body: string | Buffer, exec = false): void {
  const p = join(root, ...rel.split('/'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  if (exec) chmodSync(p, 0o755);
}

export interface FakePkgOpts { version?: string; claude?: string; extra?: Record<string, string>; skipList?: boolean; platform?: string }
/** A complete fake package folder with PACKAGE-FILES.json (built by the real makeFilesList). */
export async function fakePackage(opts: FakePkgOpts = {}): Promise<string> {
  const v = opts.version ?? '0.9.0';
  const root = tmp('prebuilt-pkg-');
  put(root, 'package.json', JSON.stringify({ name: 'legion', version: v }));
  put(root, 'package-lock.json', '{"lockfileVersion":3}\n');
  put(root, 'build-info.json', JSON.stringify({ version: v, publishedAt: '2026-10-20T10:00:00Z', builtAt: '2026-10-20T10:00:00Z', commit: 'abc1234', platform: opts.platform ?? 'win32-x64', kind: 'package' }));
  put(root, 'dist/src/electron/main.js', `// main ${v}`);
  put(root, 'dist/src/bin/legion-core.js', '// core');
  put(root, 'dist-ui/index.html', '<html>');
  put(root, 'assets/icon.ico', 'ico');
  put(root, 'scripts/setup.ps1', '# setup');
  put(root, 'setup.cmd', '@echo off\r\n');
  put(root, 'LICENSE', 'MIT'); put(root, 'NOTICE', 'n');
  put(root, 'node_modules/zod/index.js', 'z');
  put(root, 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe', opts.claude ?? FAKE_CLAUDE, true);
  put(root, 'runtime/electron/electron.exe', FAKE_ELECTRON, true);
  put(root, 'runtime/electron/resources/default_app.asar', 'asar');
  for (const [k, b] of Object.entries(opts.extra ?? {})) put(root, k, b);
  if (!opts.skipList) {
    const { makeFilesList } = await lib();
    put(root, 'PACKAGE-FILES.json', JSON.stringify(await makeFilesList(root)));
  }
  return root;
}
