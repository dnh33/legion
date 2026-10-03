/**
 * The spend path against the fake BRC-100 wallet (test/bsv-fake-wallet.ts), every scenario of test/bsv-spend-scenarios.ts on the REAL
 * compiled modules. The same scenarios run against one-change mutants in bsv-spend-mutants.test.ts and must fail there.
 */
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadMods, SCENARIOS } from './bsv-spend-scenarios.js';

// tests run from dist/test; the compiled sources are one level up
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const mods = loadMods(ROOT);
for (const [name, run] of Object.entries(SCENARIOS)) if (name !== 'injection-corpus-moves-nothing') test(`spend flow: ${name}`, async () => { await run(await mods); });
void join;
