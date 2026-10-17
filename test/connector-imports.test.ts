/**
 * Source test (design 6.3, 7.2 item 7): `src/core/connectors/github/writes.ts` is importable only by `write-tools.ts` and the admin routes
 * (`repo-admin-routes.ts`). A write reaches GitHub only through the handler that cards unless the registry says off, so it cannot be built by importing the sender from somewhere else.
 * Mutation negative: an import added to gateway.ts (in memory) must make the check fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src');
const WRITES = 'src/core/connectors/github/writes.ts';
/** write-tools.ts (agent writes: carded unless the registry says off) and the admin side: the repo-create routes and the owner's CI panel buttons (ci/wiring.ts loads it lazily). */
const ALLOWED = new Set(['src/core/connectors/github/write-tools.ts', 'src/core/connectors/github/repo-admin-routes.ts', 'src/core/ci/wiring.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}
const rel = (p: string): string => relative(ROOT, p).split(sep).join('/');

/** Every file (relative, forward slashes) whose text imports, re-exports or dynamically imports writes.ts. */
export function importersOfWrites(files: Map<string, string>): string[] {
  const hits: string[] = [];
  const re = /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const [file, text] of files) {
    for (const m of text.matchAll(re)) {
      const spec = m[1]!;
      if (!spec.startsWith('.')) continue;
      const target = rel(resolve(ROOT, dirname(file), spec)).replace(/\.js$/, '.ts');
      if (target === WRITES || target === WRITES.replace(/\.ts$/, '')) { hits.push(file); break; }
    }
  }
  return hits.sort();
}

function sources(): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of walk(SRC)) m.set(rel(p), readFileSync(p, 'utf8'));
  return m;
}

test('only write-tools.ts and the admin routes import writes.ts', () => {
  const files = sources();
  assert.ok(files.has(WRITES), 'writes.ts exists');
  const importers = importersOfWrites(files);
  assert.ok(importers.length >= 1, 'write-tools.ts imports it');
  for (const f of importers) assert.ok(ALLOWED.has(f), `${f} must not import writes.ts`);
  assert.ok(importers.includes('src/core/connectors/github/write-tools.ts'));
});

test('mutation: an import added to the gateway, a route file or a dynamic import is caught', () => {
  const files = sources();
  const gw = 'src/core/connectors/gateway.ts';
  const base = files.get(gw)!;
  for (const add of [
    `import { createIssue } from './github/writes.js';\n`,
    `export * from './github/writes.js';\n`,
    `const m = await import('./github/writes.js');\n`,
    `import { createIssue } from './github/writes';\n`,
  ]) {
    const mutated = new Map(files).set(gw, add + base);
    assert.ok(importersOfWrites(mutated).includes(gw), add.trim());
  }
  const other = new Map(files).set('src/core/server.ts', `import { cancel } from './connectors/github/writes.js';\n` + files.get('src/core/server.ts')!);
  assert.ok(importersOfWrites(other).includes('src/core/server.ts'));
});
