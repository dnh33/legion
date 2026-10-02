/** The experimental flag and the shape of the new code (controls C1, C17). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, normalizeExperimental } from '../src/shared/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const read = (p: string) => readFileSync(join(repo, p), 'utf8');
const walk = (d: string): string[] => readdirSync(join(repo, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

test('C1 default is off and only the literal true turns it on', () => {
  assert.equal(defaultConfig().experimental.projectBoard, false);
  for (const v of ['true', 1, 'yes', null, {}, [], 'TRUE', 0]) assert.equal(normalizeExperimental({ projectBoard: v }).projectBoard, false, JSON.stringify(v));
  assert.equal(normalizeExperimental({ projectBoard: true }).projectBoard, true);
  assert.equal(normalizeExperimental(undefined).projectBoard, false);
  assert.equal(normalizeExperimental({ providers: true }).projectBoard, false, 'the other switch does not turn it on');
  assert.equal(normalizeExperimental({ projectBoard: true }).providers, false, 'and the reverse');
});

test('C1 the core builds the store and module only behind the flag; nothing else builds them', () => {
  const core = read('src/bin/legion-core.ts');
  assert.match(core, /config\.experimental\.projectBoard \? new BoardStore\(/);
  assert.match(core, /board \? \[createBoardModule\(/);
  assert.match(core, /\.\.\.\(board \? \{ board \} : \{\}\)/);
  const users = walk('src').filter((f) => /\.ts$/.test(f) && !f.includes(join('projects', 'board')) && /new BoardStore\(|createBoardModule\(/.test(read(f)));
  assert.deepEqual(users, [join('src', 'bin', 'legion-core.ts')]);
});

test('C1 nothing writes the flag: no route, setting or UI code mentions it', () => {
  const files = [...walk('src'), ...walk('ui/src')].filter((f) => /\.(ts|tsx)$/.test(f));
  const mentions = files.filter((f) => /projectBoard/.test(read(f))).sort();
  assert.deepEqual(mentions, [join('src', 'bin', 'legion-core.ts'), join('src', 'shared', 'config.ts')]);
  const settings = read('src/core/settings.ts');
  assert.ok(!/experimental/.test(settings), 'the settings service never touches experimental');
});

test('C17 the new core files start no process and open no network connection', () => {
  const files = walk(join('src', 'core', 'projects', 'board')).concat(['src/shared/board.ts']);
  for (const f of files) {
    const s = read(f);
    assert.ok(!/child_process|\bspawn\(|\bexec\(|\bexecFile|\bfetch\(|node:http|node:https|node:net|WebSocket|XMLHttpRequest/.test(s), `${f} must not start processes or use the network`);
  }
});
