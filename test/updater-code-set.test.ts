/**
 * Everything the full-install route runs after a code-only update has replaced the app lives in the code-only update set
 * (CODE_SET: dist, ...), never in runtime/ or node_modules. So releasing the hardened updater as a plain code-only release
 * makes the NEXT (full-package) update run on it. These pin the facts that argument rests on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE_SET, FULL_PACKAGE_SET } from '../src/core/updater/apply.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const dir = join(REPO, 'src', 'core', 'updater');
const imports = (file: string): string[] => [...readFileSync(file, 'utf8').matchAll(/^import[^'"\n]*from '([^']+)'/gm)].map((m) => m[1]!);

test('the compiled app (dist) is in the code-only set; node_modules and runtime are only in the full set', () => {
  assert.ok(CODE_SET.includes('dist') && CODE_SET.includes('dist-ui'));
  assert.ok(!CODE_SET.includes('node_modules') && !CODE_SET.includes('runtime'));
  assert.ok(FULL_PACKAGE_SET.includes('node_modules') && FULL_PACKAGE_SET.includes('runtime'));
});

test('the swap helper imports node: builtins only, so it runs alone from .update/run and needs nothing from node_modules or runtime', () => {
  const bad = imports(join(dir, 'apply.ts')).filter((i) => !i.startsWith('node:'));
  assert.deepEqual(bad, []);
});

test('no updater module imports a package: only node: builtins and the app\'s own files (all compiled into dist)', () => {
  const bad: string[] = [];
  for (const n of readdirSync(dir).filter((f) => f.endsWith('.ts'))) for (const i of imports(join(dir, n))) if (!i.startsWith('node:') && !i.startsWith('.')) bad.push(`${n}: ${i}`);
  assert.deepEqual(bad, []);
});

test('the helper is copied from the running build\'s own dist at every apply, so a code-only update replaces it', () => {
  const main = readFileSync(join(REPO, 'src', 'electron', 'updater-main.ts'), 'utf8');
  assert.match(main, /const helperSource = join\(here, '\.\.', 'core', 'updater', 'apply\.js'\)/);
  assert.match(main, /copyFileSync\(helperSource, join\(run, 'apply\.mjs'\)\)/);
});
