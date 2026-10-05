/**
 * Tripwire: three runtime-migration claims that were measured and are FALSE for this codebase.
 *
 * Each one was checked against primary sources and against this repo on 2026-10-05. They are written down here because
 * they are the plausible-sounding suggestions a future agent (or a human) will reach for again, and because each has a
 * measured cost if someone tries it.
 *
 * - Bun: `bun test` cannot run this suite. 25 fail / 24 errors on 30 files vs Node's 0, because `bun test` does not
 *   isolate a file per process and hits oven-sh/bun#5090 ("test() inside another test()") on every file after the first.
 * - Deno: 2 real failures on Windows — it leaks its own `deno_node_shim_active` into the child environment (which the
 *   env-allowlist test exists to catch) and its process-tree kill leaves a stuck browser alive.
 * - Node type stripping: Legion cannot run on it. Node 26 removed --experimental-transform-types, parameter properties
 *   are not erasable, and every import uses a `.js` specifier that must resolve to a real `.ts` file.
 *
 * The Electron main process runs on Electron's own embedded Node, so a runtime swap needs Electron gone first.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

/** Every src file, relative to the repo root. */
function srcFiles(dir = join(REPO, 'src')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? srcFiles(p) : e.name.endsWith('.ts') ? [p] : [];
  });
}

test('Node type stripping cannot run Legion: parameter properties are not erasable and are present in the source', () => {
  // The mutation this guards: "drop tsc, let Node run the .ts files". Node 26 removed --experimental-transform-types,
  // so `constructor(private readonly x: T)` is a hard SyntaxError (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  const offenders = srcFiles().filter((f) => /constructor\([^)]*\b(private|public|protected|readonly)\s/.test(readFileSync(f, 'utf8')));
  assert.ok(offenders.length > 0, 'if this is empty the claim needs re-measuring: Node may now transform parameter properties');
});

test('no enum or namespace anywhere in src (each is non-erasable under strip-only)', () => {
  const bad = srcFiles().filter((f) => /^\s*(export\s+)?(const\s+)?enum\s|^\s*(export\s+)?namespace\s|^\s*declare\s+module\s/m.test(readFileSync(f, 'utf8')));
  assert.deepEqual(bad.map((f) => f.slice(REPO.length)), [], 'non-erasable TypeScript syntax crept in');
});

test('Node type stripping cannot run Legion: no source import names a .ts file, so .js specifiers would not resolve', () => {
  // Type stripping requires `from './dep.ts'`. Legion's imports are `from './dep.js'`, which under stripping looks for a
  // real dep.js on disk and fails with ERR_MODULE_NOT_FOUND — proven with a two-file probe.
  const importers = srcFiles().filter((f) => /from '\.[^']*\.js'/.test(readFileSync(f, 'utf8')));
  assert.ok(importers.length > 0, 'the codebase does use .js specifiers');
  const tsSpecifiers = srcFiles().filter((f) => /from '\.[^']*\.ts'/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(tsSpecifiers, [], 'no source file names a .ts extension, so none of them would resolve under stripping');
});

test('the core is started through Electron\'s own embedded Node, so the runtime is Electron\'s to choose', () => {
  // resolve-node.ts picks ELECTRON_RUN_AS_NODE=1 for a prebuilt package install. That is a deliberate product
  // decision (a packaged install ships no separate node.exe), not an accident to be refactored away.
  const resolveNode = read('src/electron/resolve-node.ts');
  assert.match(resolveNode, /ELECTRON_RUN_AS_NODE: '1'/, 'the packaged path still uses Electron in node mode');
  assert.match(read('src/electron/main.ts'), /resolveCoreLaunch\(root\)/, 'the launcher still resolves the core command');
});

test('the suite\'s test runner is node --test, which isolates a file per process (bun test does not)', () => {
  // The measured difference, recorded so a swap has to beat this: 30 files gave Node 428 pass / 0 fail and Bun
  // 69 pass / 25 fail / 24 errors, because bun test keeps every file in one process and trips bun#5090.
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.test, /node --test/, 'the suite runs on node --test');
  assert.doesNotMatch(pkg.scripts.test, /bun test/, 'and not on bun test, which cannot run it');
});