import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/core/bus.js';
import { makeBoatGetter, SettingsService, SettingsError } from '../src/core/settings.js';
import { gate, isClientRoute } from '../src/core/admin.js';
import { DEFAULT_COMPACTION, defaultConfig } from '../src/shared/config.js';
import { AUTH, asClient, makeFakes, start } from './helpers-c.js';

test('makeBoatGetter: client appears when the key is set live, is rebuilt on change, disappears when cleared', () => {
  const config = defaultConfig();
  let made = 0;
  const get = makeBoatGetter(config, () => ({ n: ++made }) as any);
  assert.equal(get(), null);
  const dir = cleanupTemp('legion-st-');
  const file = join(dir, 'config.json');
  writeFileSync(file, '{}');
  const svc = new SettingsService({ config, bus: new EventBus(), configPath: file, dataDir: dir });
  svc.patch({ boat: { apiKey: 'k1' } });
  const a = get() as any;
  assert.equal(a.n, 1);
  assert.equal(get(), a, 'cached while unchanged');
  svc.patch({ boat: { baseUrl: 'https://other.test/api' } });
  assert.equal((get() as any).n, 2);
  svc.patch({ boat: { apiKey: null } });
  assert.equal(get(), null);
});

test('patch does not persist env-derived values and writes atomically (no tmp left)', () => {
  const config = defaultConfig();
  config.boat.apiKey = 'from-env-0000'; // pretend loadConfig merged BOAT_API_KEY
  const dir = cleanupTemp('legion-st-');
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ port: 4747, custom: 1 }));
  const svc = new SettingsService({ config, bus: new EventBus(), configPath: file, dataDir: dir });
  svc.patch({ claude: { maxTurns: 9 } });
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(disk.boat, undefined);
  assert.equal(disk.custom, 1);
  assert.equal(disk.claude.maxTurns, 9);
  assert.throws(() => svc.patch({ claude: { maxTurns: -1 } }), (e: any) => e instanceof SettingsError && e.status === 400);
  assert.deepEqual(readdirSyncNoTmp(dir), ['config.json']);
});

import { readdirSync } from 'node:fs';
function readdirSyncNoTmp(d: string) { return readdirSync(d).filter((f) => !f.startsWith('.')); }

/* ---------------- compaction settings ---------------- */

function compactionSvc(disk: unknown = { port: 4747 }) {
  const dir = cleanupTemp('legion-st-');
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(disk));
  const config = defaultConfig();
  const svc = new SettingsService({ config, bus: new EventBus(), configPath: file, dataDir: dir });
  return { svc, config, file, dir };
}

test('compaction: an absent block reads back as the shipped defaults', () => {
  const { svc } = compactionSvc();
  assert.deepEqual(svc.view().compaction, DEFAULT_COMPACTION);
});

test('compaction: a value written survives a restart (re-read from config.json on disk)', () => {
  const { svc, file } = compactionSvc();
  const saved = svc.patch({ compaction: { thresholdFraction: 0.72, protectFirst: 7, contextWindowOverride: 200_000 } });

  // 1) the raw file on disk carries it. THIS is the assertion that catches the apply() persistence trap:
  //    a section missing from the apply() list is written to the in-memory config only and vanishes on restart.
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(disk.compaction, 'compaction was written to config.json');
  assert.equal(disk.compaction.thresholdFraction, 0.72);
  assert.equal(disk.compaction.protectFirst, 7);
  assert.equal(disk.compaction.contextWindowOverride, 200_000);
  assert.equal(saved.compaction.thresholdFraction, 0.72, 'applied live');

  // 2) a fresh service built the way loadConfig would (file deep-merged over defaults) shows the saved values.
  const base = defaultConfig();
  const reloaded = { ...base, ...disk, compaction: { ...base.compaction, ...(disk.compaction ?? {}) } } as any;
  const svc2 = new SettingsService({ config: reloaded, bus: new EventBus(), configPath: file, dataDir: join(file, '..') });
  assert.deepEqual(svc2.view().compaction, { ...DEFAULT_COMPACTION, thresholdFraction: 0.72, protectFirst: 7, contextWindowOverride: 200_000 });
});

test('compaction: out-of-range and wrong-typed values are rejected, naming the field and its range', () => {
  const { svc, file } = compactionSvc();
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['thresholdFraction low', { thresholdFraction: 0.05 }, /compaction\.thresholdFraction must be a number between 0\.1 and 0\.95/],
    ['thresholdFraction high', { thresholdFraction: 1 }, /compaction\.thresholdFraction must be a number between 0\.1 and 0\.95/],
    ['thresholdFraction type', { thresholdFraction: 'high' }, /compaction\.thresholdFraction must be a number between 0\.1 and 0\.95/],
    ['tailBudgetShare low', { tailBudgetShare: 0.01 }, /compaction\.tailBudgetShare must be a number between 0\.02 and 0\.6/],
    ['tailBudgetShare high', { tailBudgetShare: 0.7 }, /compaction\.tailBudgetShare must be a number between 0\.02 and 0\.6/],
    ['summaryShare high', { summaryShare: 0.5 }, /compaction\.summaryShare must be a number between 0\.02 and 0\.4/],
    ['protectFirst low', { protectFirst: 0 }, /compaction\.protectFirst must be an integer between 1 and 20/],
    ['protectFirst non-integer', { protectFirst: 2.5 }, /compaction\.protectFirst must be an integer between 1 and 20/],
    ['protectFirst high', { protectFirst: 21 }, /compaction\.protectFirst must be an integer between 1 and 20/],
    ['contextWindowOverride low', { contextWindowOverride: 100 }, /compaction\.contextWindowOverride must be an integer between 4096 and 4000000/],
    ['contextWindowOverride high', { contextWindowOverride: 5_000_000 }, /compaction\.contextWindowOverride must be an integer between 4096 and 4000000/],
    ['smallWindowTokens low', { smallWindowTokens: 1_000 }, /compaction\.smallWindowTokens must be an integer between 4096 and 4000000/],
  ];
  for (const [label, body, re] of cases) {
    assert.throws(() => svc.patch({ compaction: body }), (e: any) => e instanceof SettingsError && e.status === 400 && re.test(e.message), label);
  }
  assert.throws(() => svc.patch({ compaction: 'nope' }), (e: any) => e instanceof SettingsError && e.status === 400, 'compaction must be an object');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).compaction, undefined, 'an invalid patch writes nothing');

  // edges of every range are accepted, not clamped
  const ok = svc.patch({ compaction: { thresholdFraction: 0.1, tailBudgetShare: 0.6, summaryShare: 0.02, protectFirst: 1, contextWindowOverride: null, smallWindowTokens: 4_096 } });
  // enabled is part of the shape and defaults to true when a patch does not mention it.
  assert.deepEqual(ok.compaction, { enabled: true, thresholdFraction: 0.1, tailBudgetShare: 0.6, summaryShare: 0.02, protectFirst: 1, contextWindowOverride: null, smallWindowTokens: 4_096 });
});

test('compaction: reset restores the shipped defaults, on disk and live', () => {
  const { svc, file } = compactionSvc();
  svc.patch({ compaction: { thresholdFraction: 0.8, protectFirst: 12, smallWindowTokens: 100_000 } });
  assert.equal(svc.view().compaction.protectFirst, 12);
  const view = svc.resetCompaction();
  assert.deepEqual(view.compaction, DEFAULT_COMPACTION);
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(disk.compaction.thresholdFraction, DEFAULT_COMPACTION.thresholdFraction);
  assert.equal(disk.compaction.protectFirst, DEFAULT_COMPACTION.protectFirst);
  assert.equal(disk.compaction.smallWindowTokens, DEFAULT_COMPACTION.smallWindowTokens);
});

test('compaction routes stay admin-only: default-deny refuses a token-only caller', () => {
  for (const [method, path] of [['GET', '/api/settings'], ['PATCH', '/api/settings'], ['POST', '/api/settings/compaction/reset']] as const) {
    assert.equal(isClientRoute(method, path), false, `${method} ${path} is not a client route`);
    assert.deepEqual(
      gate({ method, path, adminOk: false, bearerOk: true, hasSecret: true }),
      { allow: false, status: 403, error: 'admin_required' },
      `${method} ${path} refuses a token-only caller`,
    );
    assert.deepEqual(gate({ method, path, adminOk: true, bearerOk: true, hasSecret: true }), { allow: true, admin: true });
  }
});

test('compaction reset over HTTP: 200 for the admin window, 403 for a token-only client', async () => {
  const f = makeFakes();
  const { base, close } = await start(f.ctx);
  try {
    const client = await fetch(base + '/api/settings/compaction/reset', { method: 'POST', headers: { ...asClient, 'Content-Type': 'application/json' } });
    assert.equal(client.status, 403);
    assert.match(String((await client.json() as any).error), /admin_required/);

    const admin = await fetch(base + '/api/settings/compaction/reset', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' } });
    assert.equal(admin.status, 200);
    assert.deepEqual((await admin.json() as any).compaction, DEFAULT_COMPACTION);
  } finally { await close(); }
});
