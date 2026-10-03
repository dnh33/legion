/** The default-on feature switch and the shape of the new code (controls C1, C17). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, loadConfig, normalizeExperimental, normalizeFeatures } from '../src/shared/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const read = (p: string) => readFileSync(join(repo, p), 'utf8');
const walk = (d: string): string[] => readdirSync(join(repo, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

test('C1 the board is ON by default; only the literal false turns it off', () => {
  assert.equal(defaultConfig().features.projectBoard, true);
  for (const v of [true, 'false', 'FALSE', 0, null, undefined, {}, [], 'no', 1, 'off']) assert.equal(normalizeFeatures({ projectBoard: v }).projectBoard, true, JSON.stringify(v));
  assert.equal(normalizeFeatures({ projectBoard: false }).projectBoard, false);
  for (const v of [undefined, null, 'x', 5, [], { other: false }]) assert.equal(normalizeFeatures(v).projectBoard, true, `features = ${JSON.stringify(v)}`);
});

test('C1 migration: the old experimental.projectBoard key is ignored (no error, no effect, either value); a later features value wins', () => {
  assert.deepEqual(normalizeExperimental({ projectBoard: true }), { providers: false });
  assert.deepEqual(normalizeExperimental({ projectBoard: false, providers: true }), { providers: true });
  const home = mkdtempSync(join(tmpdir(), 'legion-board-flag-'));
  const prev = process.env.LEGION_HOME;
  process.env.LEGION_HOME = home;
  try {
    const load = (cfg: unknown) => { writeFileSync(join(home, 'config.json'), JSON.stringify(cfg)); return loadConfig(); };
    assert.equal(load({ experimental: { projectBoard: true } }).features.projectBoard, true);
    assert.equal(load({ experimental: { projectBoard: false } }).features.projectBoard, true, 'an old false does not turn the board off');
    assert.equal(load({}).features.projectBoard, true);
    assert.equal(load({ features: { projectBoard: false }, experimental: { projectBoard: true } }).features.projectBoard, false);
    assert.equal(load({ features: { projectBoard: 'false' } }).features.projectBoard, true);
    assert.ok(!('projectBoard' in (load({ experimental: { projectBoard: true } }).experimental as object)), 'the old key is not kept in the experimental block');
  } finally { if (prev === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = prev; }
});

test('C1 the core builds the store and module only behind the switch; nothing else builds them; the harness mirrors it', () => {
  for (const f of ['src/bin/legion-core.ts', 'scripts/harness/core-entry.mjs']) {
    const core = read(f);
    assert.match(core, /config\.features\.projectBoard \? new BoardStore\(/, f);
    assert.match(core, /board \? \[createBoardModule\(/, f);
  }
  assert.match(read('src/bin/legion-core.ts'), /\.\.\.\(board \? \{ board \} : \{\}\)/);
  const users = walk('src').filter((f) => /\.ts$/.test(f) && !f.includes(join('projects', 'board')) && /new BoardStore\(|createBoardModule\(/.test(read(f)));
  assert.deepEqual(users, [join('src', 'bin', 'legion-core.ts')]);
});

test('C1 nothing writes the switch: no route, setting or UI code mentions it', () => {
  const files = [...walk('src'), ...walk('ui/src')].filter((f) => /\.(ts|tsx)$/.test(f));
  const mentions = files.filter((f) => /projectBoard/.test(read(f))).sort();
  assert.deepEqual(mentions, [join('src', 'bin', 'legion-core.ts'), join('src', 'shared', 'config.ts')]);
  const settings = read('src/core/settings.ts');
  assert.ok(!/experimental|features/.test(settings), 'the settings service never touches experimental or features');
  assert.ok(!/features/.test(read('src/core/server.ts')), 'no server route touches features');
});

test('C17 the new core files start no process and open no network connection', () => {
  const files = walk(join('src', 'core', 'projects', 'board')).concat(['src/shared/board.ts']);
  for (const f of files) {
    const s = read(f);
    assert.ok(!/child_process|\bspawn\(|\bexec\(|\bexecFile|\bfetch\(|node:http|node:https|node:net|WebSocket|XMLHttpRequest/.test(s), `${f} must not start processes or use the network`);
  }
});
