/** Optional step, token and price limits on an agent host entry. Every one is absent (off) by default. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus } from '../src/core/bus.js';
import { SettingsError, SettingsService, validatePatch } from '../src/core/settings.js';
import { defaultConfig, normalizeAcp } from '../src/shared/config.js';
import { acpCostOf, buildAcpView, BUILTIN_HERMES } from '../src/shared/acp-view.js';
import type { AcpEntry } from '../src/shared/acp-view.js';

function svcOn() {
  const dir = cleanupTemp('legion-acp-limits-');
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ port: 4747 }));
  const svc = new SettingsService({ config: defaultConfig(), bus: new EventBus(), configPath: file, dataDir: dir });
  return { svc, file };
}
const hermes = (svc: SettingsService) => svc.patch({}).acp.entries.find((e) => e.id === 'hermes')!;
const hasLimit = (e: object) => 'maxSteps' in e || 'maxTokensPerTask' in e || 'prices' in e;

test('limits are absent by default, on the built-in entry and on a custom one', () => {
  assert.equal(hasLimit(BUILTIN_HERMES), false);
  const n = normalizeAcp({ entries: [{ id: 'goose', command: 'goose' }] });
  for (const e of n.entries) {
    assert.equal(e.maxSteps, undefined, e.id);
    assert.equal(e.maxTokensPerTask, undefined, e.id);
    assert.equal(e.prices, undefined, e.id);
    assert.equal(hasLimit(e), false, `${e.id} carries no limit keys`);
  }
  assert.equal(hasLimit(buildAcpView(normalizeAcp(undefined)).entries[0]!), false);
});

test('maxSteps clamps to 1..10000 and rounds; a non-number turns it off', () => {
  const steps = (v: unknown) => normalizeAcp({ entries: [{ id: 'hermes', maxSteps: v }] }).entries[0]!.maxSteps;
  assert.equal(steps(0), 1);
  assert.equal(steps(-4), 1);
  assert.equal(steps(99999), 10000);
  assert.equal(steps(12.6), 13);
  assert.equal(steps(40), 40);
  assert.equal(steps('40'), undefined);
  assert.equal(steps(NaN), undefined);
  assert.equal(steps(null), undefined);
});

test('maxTokensPerTask clamps to 1000..100000000 and rounds; a non-number turns it off', () => {
  const toks = (v: unknown) => normalizeAcp({ entries: [{ id: 'hermes', maxTokensPerTask: v }] }).entries[0]!.maxTokensPerTask;
  assert.equal(toks(5), 1000);
  assert.equal(toks(1e12), 100_000_000);
  assert.equal(toks(250_000.4), 250_000);
  assert.equal(toks(250_000), 250_000);
  assert.equal(toks('1000'), undefined);
  assert.equal(toks(Infinity), undefined);
});

test('prices need both numbers, each 0..100000; anything else turns them off', () => {
  const pr = (v: unknown) => normalizeAcp({ entries: [{ id: 'hermes', prices: v }] }).entries[0]!.prices;
  assert.deepEqual(pr({ inputPerMTok: 3, outputPerMTok: 15 }), { inputPerMTok: 3, outputPerMTok: 15 });
  assert.deepEqual(pr({ inputPerMTok: 0, outputPerMTok: 0 }), { inputPerMTok: 0, outputPerMTok: 0 });
  assert.equal(pr({ inputPerMTok: 3 }), undefined);
  assert.equal(pr({ inputPerMTok: -1, outputPerMTok: 15 }), undefined);
  assert.equal(pr({ inputPerMTok: 3, outputPerMTok: 100001 }), undefined);
  assert.equal(pr({ inputPerMTok: '3', outputPerMTok: 15 }), undefined);
  assert.equal(pr({ inputPerMTok: NaN, outputPerMTok: 15 }), undefined);
  assert.equal(pr('free'), undefined);
  assert.deepEqual(pr({ inputPerMTok: 3, outputPerMTok: 15, extra: 1 }), { inputPerMTok: 3, outputPerMTok: 15 });
});

test('a custom entry keeps its limits too', () => {
  const g = normalizeAcp({ entries: [{ id: 'goose', command: 'goose', maxSteps: 30, maxTokensPerTask: 50_000, prices: { inputPerMTok: 1, outputPerMTok: 2 } }] }).entries[1]!;
  assert.equal(g.maxSteps, 30);
  assert.equal(g.maxTokensPerTask, 50_000);
  assert.deepEqual(g.prices, { inputPerMTok: 1, outputPerMTok: 2 });
});

test('acpCostOf: undefined without prices, otherwise tokens times the per-million price', () => {
  const bare: AcpEntry = { ...BUILTIN_HERMES };
  assert.equal(acpCostOf(bare, { input: 1_000_000, output: 1_000_000 }), undefined);
  const priced: AcpEntry = { ...BUILTIN_HERMES, prices: { inputPerMTok: 3, outputPerMTok: 15 } };
  assert.equal(acpCostOf(priced, { input: 1_000_000, output: 1_000_000 }), 18);
  assert.equal(acpCostOf(priced, { input: 500_000, output: 100_000 }), 3);
  assert.equal(acpCostOf(priced, { input: 0, output: 0 }), 0);
  assert.equal(acpCostOf(priced, { input: -5, output: NaN }), 0, 'a bad delta never makes a negative or NaN cost');
  const free: AcpEntry = { ...BUILTIN_HERMES, prices: { inputPerMTok: 0, outputPerMTok: 0 } };
  assert.equal(acpCostOf(free, { input: 10, output: 10 }), 0, 'zero prices are known, not unknown');
});

test('a patch sets each limit, shows it in the view, saves it to disk and clears it with null', () => {
  const { svc, file } = svcOn();
  assert.equal(hasLimit(hermes(svc)), false);
  let v = svc.patch({ acp: { entries: [{ id: 'hermes', maxSteps: 25, maxTokensPerTask: 200_000, prices: { inputPerMTok: 3, outputPerMTok: 15 } }] } });
  let e = v.acp.entries.find((x) => x.id === 'hermes')!;
  assert.equal(e.maxSteps, 25);
  assert.equal(e.maxTokensPerTask, 200_000);
  assert.deepEqual(e.prices, { inputPerMTok: 3, outputPerMTok: 15 });
  const disk = JSON.parse(readFileSync(file, 'utf8')).acp.entries.find((x: { id: string }) => x.id === 'hermes');
  assert.equal(disk.maxSteps, 25);
  assert.deepEqual(disk.prices, { inputPerMTok: 3, outputPerMTok: 15 });

  // clearing one leaves the others alone
  v = svc.patch({ acp: { entries: [{ id: 'hermes', maxSteps: null }] } });
  e = v.acp.entries.find((x) => x.id === 'hermes')!;
  assert.equal('maxSteps' in e, false);
  assert.equal(e.maxTokensPerTask, 200_000);
  assert.deepEqual(e.prices, { inputPerMTok: 3, outputPerMTok: 15 });
  v = svc.patch({ acp: { entries: [{ id: 'hermes', maxTokensPerTask: null }] } });
  assert.equal('maxTokensPerTask' in v.acp.entries.find((x) => x.id === 'hermes')!, false);
  v = svc.patch({ acp: { entries: [{ id: 'hermes', prices: null }] } });
  assert.equal(hasLimit(v.acp.entries.find((x) => x.id === 'hermes')!), false);
  const after = JSON.parse(readFileSync(file, 'utf8')).acp.entries.find((x: { id: string }) => x.id === 'hermes');
  assert.equal(hasLimit(after), false, 'cleared fields leave config.json');

  // an unrelated patch keeps a set limit
  svc.patch({ acp: { entries: [{ id: 'hermes', maxSteps: 7 }] } });
  v = svc.patch({ acp: { watchdogMinutes: 20 } });
  assert.equal(v.acp.entries.find((x) => x.id === 'hermes')!.maxSteps, 7);
});

test('a patch with a bad limit is refused in plain words', () => {
  const bad = (entry: Record<string, unknown>, re: RegExp) => assert.throws(
    () => validatePatch({ acp: { entries: [{ id: 'hermes', ...entry }] } }),
    (err: unknown) => err instanceof SettingsError && re.test(err.message),
  );
  bad({ maxSteps: 0 }, /maxSteps.*1.*10000/);
  bad({ maxSteps: 10001 }, /maxSteps/);
  bad({ maxSteps: 2.5 }, /maxSteps.*integer/);
  bad({ maxSteps: '5' }, /maxSteps/);
  bad({ maxTokensPerTask: 999 }, /maxTokensPerTask.*1000.*100000000/);
  bad({ maxTokensPerTask: 100_000_001 }, /maxTokensPerTask/);
  bad({ prices: { inputPerMTok: 3 } }, /prices/);
  bad({ prices: { inputPerMTok: -1, outputPerMTok: 1 } }, /prices\.inputPerMTok/);
  bad({ prices: { inputPerMTok: 1, outputPerMTok: 100001 } }, /prices\.outputPerMTok/);
  bad({ prices: 'free' }, /prices/);
  assert.doesNotThrow(() => validatePatch({ acp: { entries: [{ id: 'hermes', maxSteps: null, maxTokensPerTask: null, prices: null }] } }));
});
