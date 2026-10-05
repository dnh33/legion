import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MAX_TURNS, defaultConfig, loadConfig } from '../src/shared/config.js';

function withHome<T>(fn: (dir: string) => T): T {
  const dir = cleanupTemp('legion-turns-');
  const prev = process.env.LEGION_HOME;
  const prevBoat = process.env.BOAT_API_KEY;
  process.env.LEGION_HOME = dir;
  try { return fn(dir); } finally {
    if (prev === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = prev;
    if (prevBoat === undefined) delete process.env.BOAT_API_KEY; else process.env.BOAT_API_KEY = prevBoat;
  }
}
const disk = (dir: string) => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));

test('the default turn limit is no longer the old 40', () => {
  assert.equal(defaultConfig().claude.maxTurns, DEFAULT_MAX_TURNS);
  assert.ok(DEFAULT_MAX_TURNS > 40);
});

test('a config.json still on the old default 40 moves to the new default once, on disk, without env values', () => withHome((dir) => {
  process.env.BOAT_API_KEY = 'boat-from-env-only';
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ authToken: 'tok', claude: { auth: 'claude-login', maxTurns: 40 } }));
  assert.equal(loadConfig().claude.maxTurns, DEFAULT_MAX_TURNS);
  const d = disk(dir);
  assert.equal(d.claude.maxTurns, DEFAULT_MAX_TURNS);
  assert.equal(d.boat, undefined, 'an env-only value was written to config.json');
  assert.ok(d.migrations.includes('claude-max-turns-v2'));
}));

test('a hand-picked limit is left alone, and 40 chosen again after the migration stays 40', () => withHome((dir) => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ authToken: 'tok', claude: { maxTurns: 75 } }));
  assert.equal(loadConfig().claude.maxTurns, 75);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...disk(dir), claude: { maxTurns: 40 } }));
  assert.equal(loadConfig().claude.maxTurns, 40);
  assert.equal(disk(dir).claude.maxTurns, 40);
}));

test('a fresh install never needs the migration', () => withHome((dir) => {
  assert.equal(loadConfig().claude.maxTurns, DEFAULT_MAX_TURNS);
  assert.ok(disk(dir).migrations.includes('claude-max-turns-v2'));
}));
