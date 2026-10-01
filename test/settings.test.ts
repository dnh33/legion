import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/core/bus.js';
import { makeBoatGetter, SettingsService, SettingsError } from '../src/core/settings.js';
import { defaultConfig } from '../src/shared/config.js';

test('makeBoatGetter: client appears when the key is set live, is rebuilt on change, disappears when cleared', () => {
  const config = defaultConfig();
  let made = 0;
  const get = makeBoatGetter(config, () => ({ n: ++made }) as any);
  assert.equal(get(), null);
  const dir = mkdtempSync(join(tmpdir(), 'legion-st-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'legion-st-'));
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
