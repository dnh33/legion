// The flags that skip the stepping-stone byte/hash checks only work inside a rehearsal (LEGION_REHEARSAL=1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const run = (script: string, argv: string[], rehearsal: boolean) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (rehearsal) env.LEGION_REHEARSAL = '1'; else delete env.LEGION_REHEARSAL;
  return spawnSync(process.execPath, [join(REPO, 'scripts', script), ...argv], { encoding: 'utf8', env });
};

const cases: Array<[string, string[]]> = [
  ['release-publish.mjs', ['--dir', 'x', '--version', '0.0.1', '--notes-file', 'x', '--no-network']],
  ['release-publish.mjs', ['--dir', 'x', '--version', '0.0.1', '--notes-file', 'x', '--trust-module', 'x']],
  ['release-preflight.mjs', ['--version', '0.0.1', '--pkg', 'x', '--stones', '0.0.1']],
  ['release-preflight.mjs', ['--version', '0.0.1', '--pkg', 'x', '--no-network']],
  ['release-verify.mjs', ['--dir', 'x', '--stones', '0.0.1']],
  ['release-verify.mjs', ['--dir', 'x', '--no-network']],
  ['release-verify.mjs', ['--dir', 'x', '--trust-module', 'x']],
];

for (const [script, argv] of cases) {
  const flag = argv.find((x) => ['--no-network', '--stones', '--trust-module'].includes(x))!;
  test(`${script} ${flag} refuses without LEGION_REHEARSAL=1`, () => {
    const r = run(script, argv, false);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`${flag} .*rehearsal`, 'i'));
  });
  test(`${script} ${flag} is accepted with LEGION_REHEARSAL=1 (fails later, not on the flag)`, () => {
    const r = run(script, argv, true);
    assert.doesNotMatch(r.stderr, /only .*rehearsal/i);
  });
}
