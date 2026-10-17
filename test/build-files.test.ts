import test from 'node:test';
import assert from 'node:assert/strict';
import { isBuildFile } from '../src/shared/build-files.js';

test('build and script files are matched, with either slash', () => {
  for (const p of ['p/package.json', 'C:\\p\\Makefile', 'p/scripts/build.sh', 'p/scripts/a/b.js', 'p/vitest.config.ts', 'p/Cargo.toml', 'p/conftest.py', 'p/sub/package-lock.json', 'p/pnpm-lock.yaml', 'p/pyproject.toml', 'p/.npmrc', 'p/go.mod']) assert.equal(isBuildFile(p), true, p);
  for (const p of ['p/src/index.ts', 'p/README.md', 'p/subscripts/a.js', 'p/package.json.bak', 'p/docs/package.md']) assert.equal(isBuildFile(p), false, p);
});
