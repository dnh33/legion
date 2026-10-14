/** pruneTokenizer: the package keeps the one vocabulary Legion counts with and drops the other four (27 MB unpacked, about 3 MB kept). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { lib, REPO, tmp } from './prebuilt-helpers.js';

function size(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size;
  return n;
}
function copyOfInstalled(): string {
  const nm = join(tmp('tokenizer-prune-'), 'node_modules');
  mkdirSync(nm, { recursive: true });
  cpSync(join(REPO, 'node_modules', 'gpt-tokenizer'), join(nm, 'gpt-tokenizer'), { recursive: true });
  return nm;
}

test('pruneTokenizer drops the other vocabularies and the pruned copy still counts', async () => {
  const { pruneTokenizer } = await lib();
  const nm = copyOfInstalled();
  const before = size(join(nm, 'gpt-tokenizer'));
  const r = pruneTokenizer(nm);
  const after = size(join(nm, 'gpt-tokenizer'));
  assert.ok(before > 20_000_000, `the installed package is the full one (${before})`);
  assert.ok(after < 5_000_000, `kept ${after} bytes`);
  assert.equal(r.removedBytes, before - after);
  for (const gone of ['data', 'src', 'esm', 'cjs/bpeRanks/cl100k_base.js', 'cjs/bpeRanks/p50k_base.js', 'cjs/bpeRanks/r50k_base.js', 'cjs/encoding/cl100k_base.js']) assert.ok(!existsSync(join(nm, 'gpt-tokenizer', gone)), gone);
  for (const kept of ['package.json', 'LICENSE', 'cjs/encoding/o200k_base.js', 'cjs/bpeRanks/o200k_base.js']) assert.ok(existsSync(join(nm, 'gpt-tokenizer', kept)), kept);
  const run = spawnSync(process.execPath, ['-e', "console.log(require('gpt-tokenizer/cjs/encoding/o200k_base').countTokens('hello world'))"], { cwd: join(nm, '..'), encoding: 'utf8', env: { ...process.env, NODE_PATH: nm } });
  assert.equal(run.stdout.trim(), '2', run.stderr);
});

test('pruneTokenizer says so when the package is not installed, and is safe to run twice', async () => {
  const { pruneTokenizer } = await lib();
  assert.equal(pruneTokenizer(tmp('tokenizer-none-')), null);
  const nm = copyOfInstalled();
  pruneTokenizer(nm);
  assert.equal(pruneTokenizer(nm)!.removedBytes, 0);
});
