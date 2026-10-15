/** The version lives in three places that must move together (docs/SHIPPING.md, Version): package.json, package-lock.json and src/shared/config.ts. The installer smoke test caught a release with config.ts left behind; this catches it in plain CI. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { VERSION } from '../src/shared/config.js';

test('VERSION in src/shared/config.ts, package.json and package-lock.json agree', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
  const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8')) as { version: string; packages: Record<string, { version?: string }> };
  assert.equal(VERSION, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages['']?.version, pkg.version);
});
