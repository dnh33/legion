import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './ps-helpers.js';

// The refusal tests need key-shaped inputs. They are published test vectors, built from two pieces so no secret scanner
// matches a whole literal in the repo.
test('no test source contains a whole xprv / tprv / WIF test vector', () => {
  const dir = join(repoRoot, 'test');
  const bad: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const text = readFileSync(join(dir, f), 'utf8');
    if (/\b[xt]prv[1-9A-HJ-NP-Za-km-z]{100,}/.test(text)) bad.push(`${f}: extended private key`);
    if (/['"`][5KL][1-9A-HJ-NP-Za-km-z]{50,51}['"`]/.test(text)) bad.push(`${f}: WIF`);
  }
  assert.deepEqual(bad, []);
});
