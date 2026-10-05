import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus } from '../src/core/bus.js';
import { SettingsError, SettingsService, validatePatch } from '../src/core/settings.js';
import { defaultConfig } from '../src/shared/config.js';

function svc() {
  const dir = cleanupTemp('legion-budget-');
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ port: 4747 }));
  const config = defaultConfig();
  return { s: new SettingsService({ config, bus: new EventBus(), configPath: file, dataDir: dir }), config, file };
}
const disk = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

test('no spend limit by default: the key is absent from config and from the settings view', () => {
  const { s, config } = svc();
  assert.equal('maxBudgetUsd' in config.claude, false);
  assert.equal('maxBudgetUsd' in s.view().claude, false);
});

test('a spend limit is saved to config.json, applied live, shown in the view, and cleared with null', () => {
  const { s, config, file } = svc();
  const v = s.patch({ claude: { maxBudgetUsd: 12.5 } });
  assert.equal(v.claude.maxBudgetUsd, 12.5);
  assert.equal(config.claude.maxBudgetUsd, 12.5);
  assert.equal(disk(file).claude.maxBudgetUsd, 12.5);
  const cleared = s.patch({ claude: { maxBudgetUsd: null } });
  assert.equal('maxBudgetUsd' in cleared.claude, false);
  assert.equal('maxBudgetUsd' in config.claude, false);
  assert.equal('maxBudgetUsd' in disk(file).claude, false);
});

test('saving other Claude settings leaves the spend limit alone', () => {
  const { s, config, file } = svc();
  s.patch({ claude: { maxBudgetUsd: 3 } });
  s.patch({ claude: { maxTurns: 50 } });
  assert.equal(config.claude.maxBudgetUsd, 3);
  assert.equal(disk(file).claude.maxBudgetUsd, 3);
});

test('the limit must be 0.05 to 1000 dollars in whole cents; anything else is refused and nothing is saved', () => {
  const { s, config, file } = svc();
  for (const bad of [0, -1, 0.04, 1000.01, 1e9, 1.005, NaN, Infinity, '5', true, {}]) {
    assert.throws(() => s.patch({ claude: { maxBudgetUsd: bad as any } }), (e: any) => e instanceof SettingsError && e.status === 400, String(bad));
  }
  assert.equal('maxBudgetUsd' in config.claude, false);
  assert.equal(disk(file).claude, undefined);
  for (const good of [0.05, 1, 2.5, 1000]) assert.equal(validatePatch({ claude: { maxBudgetUsd: good } }).claude?.maxBudgetUsd, good);
});

test('a hand-edited bad limit in config.json is not shown in the view', () => {
  const { s, config } = svc();
  (config.claude as any).maxBudgetUsd = 'lots';
  assert.equal('maxBudgetUsd' in s.view().claude, false);
});
