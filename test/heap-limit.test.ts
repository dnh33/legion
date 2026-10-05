import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_HEAP_MB, MIN_HEAP_MB, hasExplicitHeapLimit, heapArgv, resolveHeapMb } from '../src/electron/heap-limit.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

test('heap limit: a core child gets a ceiling that is a quarter of RAM, capped, and never below the floor', () => {
  assert.equal(resolveHeapMb({}, [], 64000), DEFAULT_HEAP_MB, 'a big machine does not hand the core a huge ceiling');
  assert.equal(resolveHeapMb({}, [], 8192), 2048, 'a quarter of 8 GB is exactly the cap');
  assert.equal(resolveHeapMb({}, [], 4096), 1024, 'a quarter of 4 GB');
  assert.equal(resolveHeapMb({}, [], 1024), MIN_HEAP_MB, 'a tiny machine still gets the floor, never less');
});

test('heap limit: an owner who already chose a ceiling keeps it, from argv or NODE_OPTIONS', () => {
  assert.equal(hasExplicitHeapLimit({}, ['--max-old-space-size=8192']), true);
  assert.equal(hasExplicitHeapLimit({ NODE_OPTIONS: '--max-old-space-size=4096' }, []), true);
  assert.equal(hasExplicitHeapLimit({ NODE_OPTIONS: '--no-warnings' }, []), false, 'an unrelated NODE_OPTIONS is not a heap limit');
  assert.equal(resolveHeapMb({}, ['--max-old-space-size=8192'], 64000), undefined);
  assert.equal(resolveHeapMb({ NODE_OPTIONS: '--max-old-space-size=4096' }, [], 64000), undefined);
  assert.deepEqual(heapArgv({ NODE_OPTIONS: '--max-old-space-size=4096' }, [], 64000), [], 'no argv when the owner already set one');
});

test('heap limit: a machine that reports no RAM gets the default rather than NaN or zero', () => {
  assert.equal(resolveHeapMb({}, [], 0), DEFAULT_HEAP_MB);
  assert.equal(resolveHeapMb({}, [], Number.NaN), DEFAULT_HEAP_MB);
  assert.equal(resolveHeapMb({}, [], -5), DEFAULT_HEAP_MB);
});

test('heap limit: every real machine yields a finite positive integer', () => {
  const mb = resolveHeapMb({}, []);
  assert.ok(Number.isInteger(mb) && (mb as number) >= MIN_HEAP_MB, `got ${mb}`);
  assert.ok((mb as number) <= DEFAULT_HEAP_MB);
});

test('both places that start the core pass the ceiling', () => {
  assert.match(read('src/electron/main.ts'), /spawn\(launch\.cmd, \[\.\.\.heapArgv\(\), coreEntry\]/, 'the Electron main process sets it');
  assert.match(read('src/bin/legion-mcp-stdio.ts'), /spawn\(process\.execPath, \[\.\.\.heapArgv\(\), corePath\]/, 'the stdio bridge sets it too');
  assert.match(read('src/electron/main.ts'), /heapArgv.*from '\.\/heap-limit\.js'|from '\.\/heap-limit\.js'/, 'main.ts imports the helper');
});

test('negative: without heapArgv the core child is started with no ceiling at all', () => {
  // The mutation this test exists to catch: reverting the argv to a bare [coreEntry].
  const src = read('src/electron/main.ts');
  const reverted = src.replace(/\[\.\.\.heapArgv\(\), coreEntry\]/, '[coreEntry]');
  assert.doesNotMatch(reverted, /heapArgv\(\), coreEntry\]/, 'the revert leaves no ceiling in place');
  assert.match(src, /heapArgv\(\), coreEntry\]/, 'the real source has one');
});