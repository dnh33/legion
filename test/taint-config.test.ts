import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus } from '../src/core/bus.js';
import { SettingsError, SettingsService } from '../src/core/settings.js';
import { defaultConfig, normalizeTaint } from '../src/shared/config.js';

test('C1: a config with no taint key reads as the new default: by source, outside files count, notice not shown', () => {
  assert.deepEqual(normalizeTaint(undefined), { shell: 'local', outsideFiles: true, noticeSeen: false });
  assert.deepEqual(normalizeTaint({}), { shell: 'local', outsideFiles: true, noticeSeen: false });
  assert.deepEqual(defaultConfig().taint, { shell: 'local', outsideFiles: true, noticeSeen: false });
});

test('C2: only the literal strict turns strict on, only false turns outside files off, only true marks the notice seen', () => {
  assert.equal(normalizeTaint({ shell: 'strict' }).shell, 'strict');
  for (const v of ['Strict', 'off', 1, null, true]) assert.equal(normalizeTaint({ shell: v }).shell, 'local', String(v));
  assert.equal(normalizeTaint({ outsideFiles: false }).outsideFiles, false);
  for (const v of ['false', 0, null, undefined]) assert.equal(normalizeTaint({ outsideFiles: v }).outsideFiles, true, String(v));
  assert.equal(normalizeTaint({ noticeSeen: true }).noticeSeen, true);
  assert.equal(normalizeTaint({ noticeSeen: 'true' }).noticeSeen, false);
});

test('C3: the setting is saved to config.json, read back by the view, and bad values are refused with a 400', () => {
  const config = defaultConfig();
  const dir = cleanupTemp('legion-taint-');
  const file = join(dir, 'config.json');
  writeFileSync(file, '{}');
  const svc = new SettingsService({ config, bus: new EventBus(), configPath: file, dataDir: dir });
  assert.deepEqual(svc.view().taint, { shell: 'local', outsideFiles: true, noticeSeen: false });
  const v = svc.patch({ taint: { shell: 'strict', noticeSeen: true } });
  assert.deepEqual(v.taint, { shell: 'strict', outsideFiles: true, noticeSeen: true });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).taint, { shell: 'strict', noticeSeen: true });
  assert.equal(config.taint?.shell, 'strict', 'the running config changes at once');
  svc.patch({ taint: { outsideFiles: false } });
  assert.deepEqual(normalizeTaint(JSON.parse(readFileSync(file, 'utf8')).taint), { shell: 'strict', outsideFiles: false, noticeSeen: true });
  const bad = (e: unknown) => e instanceof SettingsError && e.status === 400;
  assert.throws(() => svc.patch({ taint: { shell: 'off' } }), bad);
  assert.throws(() => svc.patch({ taint: { outsideFiles: 'no' } }), bad);
  assert.throws(() => svc.patch({ taint: 'strict' }), bad);
});
