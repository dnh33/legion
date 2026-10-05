/**
 * Tripwires for three claims that measurement here disproved.
 *
 * ## READ THE CAVEAT BEFORE TREATING THE NUMBERS AS SETTLED
 *
 * These guards exist because the three claims are plausible and WILL be proposed again. They do NOT exist because
 * Node was proved the best runtime, and the comparison that produced the figures is **biased toward Node**:
 *
 *   - the suite is written for `node:test`; the other runtimes are interpreting someone else's test harness
 *   - the codebase is built for Node's APIs, module resolution and process model, and neither rival was given
 *     anything equivalent to make it fair
 *   - the figures come from unoptimised runs of a workload optimised for the incumbent
 *
 * So "Bun was 2.5x slower at cold start" is close to meaningless as a verdict on Bun. What IS solid, because it is
 * not a performance claim at all: **Bun cannot execute this suite** (its `test()` isolation is unimplemented), and
 * **Deno's process-tree kill fails on Windows**, which matters regardless of speed for an app that terminates Chromium
 * and Blender. Those two are capability facts about this codebase, not opinions about a runtime.
 *
 * A fair comparison would need the workload ported, the harness equivalent, and both sides optimised. That has not
 * been done and is parked, not scheduled - see the ladder. Do not cite these numbers as evidence that Node wins;
 * cite them only as evidence that these three specific claims were checked and did not hold.
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