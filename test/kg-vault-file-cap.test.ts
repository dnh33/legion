/**
 * The vault import's file-count cap, with real files. Split out of kg-vault.test.ts because writing and importing 5,003
 * files takes over a minute: in its own file it runs beside the others instead of holding up the rest of that file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importVault, VAULT_MAX_FILES } from '../src/core/kg/vault.js';
import { HUMAN, mkGraph, tmpDir } from './kg-helpers.js';

test('import stops at the file cap: the first 5000 files are imported and the rest is reported as skipped', () => {
  const many = tmpDir();
  for (let i = 0; i < VAULT_MAX_FILES + 3; i++) writeFileSync(join(many, `f${String(i).padStart(5, '0')}.md`), `# N${i}\n`);
  const g2 = mkGraph().g;
  // the user-initiated import, as in kg-vault.test.ts (the app's route)
  const r2 = importVault(g2, many, undefined, { userInitiated: true });
  assert.equal(r2.files, VAULT_MAX_FILES);
  assert.equal(g2.stats(HUMAN).nodes, VAULT_MAX_FILES);
  assert.ok(r2.skipped.some((s) => s.path === '*' && /5000/.test(s.reason)));
});
