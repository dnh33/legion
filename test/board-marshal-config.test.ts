/**
 * The Marshal's config as the board holds it (board/store.ts): off by default, the two bounds exactly the
 * loop's own defaults, validated on write, round-tripped through the meta line across a restart, kept by
 * compaction, and never widened by a line written by a build that did not know it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BoardError, BoardStore, MARSHAL_DEFAULTS } from '../src/core/projects/board/store.js';
import type { ProjectRef } from '../src/core/projects/board/store.js';
import { STALL_MS, WAVE_SIZE } from '../src/core/marshal/orchestrator.js';
import { tempDir } from './tmp-cleanup.js';

const P: ProjectRef = { id: 'proj_aaaaaaaaaaaa', members: ['zealot'], status: 'active' };
const fileOf = (dir: string): string => join(dir, `${P.id}.jsonl`);

test('a board that never wrote a config is off, on the loop’s own defaults', () => {
  const s = new BoardStore(tempDir('legion-marshal-cfg1-'));
  assert.deepEqual(s.marshalConfig(P.id), { enabled: false, waveSize: 3, stallMinutes: 8 });
  // the store's defaults and the tested loop's defaults are the SAME numbers, pinned together here
  assert.equal(MARSHAL_DEFAULTS.waveSize, WAVE_SIZE, 'the shipped wave is the loop’s WAVE_SIZE');
  assert.equal(MARSHAL_DEFAULTS.stallMinutes, STALL_MS / 60_000, 'the shipped stall budget is the loop’s STALL_MS');
});

test('the owner’s config round-trips through the meta line, across a restart', () => {
  const dir = tempDir('legion-marshal-cfg2-');
  const s = new BoardStore(dir);
  const written = s.setMarshal(P, { enabled: true, waveSize: 5, stallMinutes: 30 });
  assert.deepEqual(written, { enabled: true, waveSize: 5, stallMinutes: 30 });
  assert.deepEqual(s.marshalConfig(P.id), written, 'the same store reads it back');
  const back = new BoardStore(dir).marshalConfig(P.id);
  assert.deepEqual(back, written, 'a new store over the same log reads it back');
  const meta = readFileSync(fileOf(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.kind === 'meta');
  assert.equal(meta.length, 1, 'one meta line holds it');
  assert.deepEqual(meta[0]!.marshal, written);
  assert.equal(meta[0]!.leader, null, 'the same line carries the leader slot');
});

test('a partial write changes only what was sent', () => {
  const s = new BoardStore(tempDir('legion-marshal-cfg3-'));
  s.setMarshal(P, { enabled: true, waveSize: 5, stallMinutes: 30 });
  assert.deepEqual(s.setMarshal(P, { waveSize: 7 }), { enabled: true, waveSize: 7, stallMinutes: 30 });
  assert.deepEqual(s.setMarshal(P, { enabled: false }), { enabled: false, waveSize: 7, stallMinutes: 30 });
  assert.deepEqual(s.setMarshal(P, { stallMinutes: 1 }), { enabled: false, waveSize: 7, stallMinutes: 1 });
});

test('every bound refuses loudly and writes nothing', () => {
  const s = new BoardStore(tempDir('legion-marshal-cfg4-'));
  s.setMarshal(P, { enabled: true, waveSize: 4, stallMinutes: 15 });
  const before = s.marshalConfig(P.id);
  const bad: Array<[unknown, RegExp]> = [
    [{ waveSize: 0 }, /waveSize must be a whole number between 1 and 10/],
    [{ waveSize: 11 }, /waveSize must be a whole number between 1 and 10/],
    [{ waveSize: 2.5 }, /waveSize must be a whole number/],
    [{ waveSize: '4' }, /waveSize must be a whole number/],
    [{ stallMinutes: 0 }, /stallMinutes must be a whole number between 1 and 240/],
    [{ stallMinutes: 241 }, /stallMinutes must be a whole number between 1 and 240/],
    [{ stallMinutes: Number.NaN }, /stallMinutes must be a whole number/],
    [{ enabled: 'yes' }, /enabled must be true or false/],
    [{}, /give enabled, waveSize or stallMinutes/],
    ['not an object', /must be an object/],
  ];
  for (const [input, msg] of bad) {
    assert.throws(() => s.setMarshal(P, input), (e: unknown) => e instanceof BoardError && e.status === 400 && msg.test(e.message), `refused: ${JSON.stringify(input)}`);
    assert.deepEqual(s.marshalConfig(P.id), before, `nothing changed by ${JSON.stringify(input)}`);
  }
});

test('an archived board refuses the change, like every other owner write', () => {
  const s = new BoardStore(tempDir('legion-marshal-cfg5-'));
  assert.throws(() => s.setMarshal({ ...P, status: 'archived' }, { enabled: true }), (e: unknown) => e instanceof BoardError && e.status === 409);
  assert.equal(s.marshalConfig(P.id).enabled, false);
});

test('compaction keeps the config — with a leader and without one', () => {
  const dir = tempDir('legion-marshal-cfg6-');
  const s = new BoardStore(dir);
  const item = s.create(P, { title: 'ship it' });
  s.setMarshal(P, { enabled: true, waveSize: 6, stallMinutes: 45 });
  const compact = (): Array<Record<string, unknown>> => {
    // one sidecar write each: past the compaction threshold the log is rewritten as one snapshot per item
    for (let n = 0; n < 220; n++) s.setSidecar(P.id, item.id, { dispatch: { n } });
    return readFileSync(fileOf(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  let meta = compact().filter((r) => r.kind === 'meta');
  assert.equal(meta.length, 1, 'the config alone is enough to write the meta line');
  assert.deepEqual(meta[0]!.marshal, { enabled: true, waveSize: 6, stallMinutes: 45 }, 'and the config survived the rewrite');
  assert.equal(meta[0]!.leader, null, 'with the leader slot still open');
  assert.deepEqual(new BoardStore(dir).marshalConfig(P.id), { enabled: true, waveSize: 6, stallMinutes: 45 });

  s.setLeader(P, 'zealot');
  meta = compact().filter((r) => r.kind === 'meta');
  assert.equal(meta.length, 1, 'still one line, never two');
  assert.deepEqual(meta[0]!.marshal, { enabled: true, waveSize: 6, stallMinutes: 45 }, 'the config did not cost the config');
  assert.equal(meta[0]!.leader, 'zealot', 'and the leader survived with it');
  const back = new BoardStore(dir);
  assert.deepEqual(back.marshalConfig(P.id), { enabled: true, waveSize: 6, stallMinutes: 45 });
  assert.equal(back.leaderOf(P), 'zealot');
});

test('compaction of an untouched board writes items only: no meta line for state that is all defaults', () => {
  const dir = tempDir('legion-marshal-cfg6b-');
  const s = new BoardStore(dir);
  const item = s.create(P, { title: 'ship it' });
  for (let n = 0; n < 220; n++) s.setSidecar(P.id, item.id, { dispatch: { n } });
  const lines = readFileSync(fileOf(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.ok(lines.length > 1 && lines.every((r) => r.kind === 'item'), 'nothing but the snapshot: no leader and all-default config carry nothing');
  assert.ok(!lines.some((r) => r.kind === 'meta'), 'and no meta line at all');
  assert.deepEqual(new BoardStore(dir).marshalConfig(P.id), { enabled: false, waveSize: 3, stallMinutes: 8 });
});

test('writing the leader cannot drop the config, and a line from an older build cannot switch the loop on', () => {
  const dir = tempDir('legion-marshal-cfg7-');
  const s = new BoardStore(dir);
  s.setMarshal(P, { enabled: true, waveSize: 2, stallMinutes: 90 });
  s.setLeader(P, 'zealot');
  assert.deepEqual(new BoardStore(dir).marshalConfig(P.id), { enabled: true, waveSize: 2, stallMinutes: 90 }, 'the leader write carried the config along');
  // a line written by a build that never knew the Marshal: no `marshal` key, so nothing about it changes
  appendFileSync(fileOf(dir), JSON.stringify({ v: 1, kind: 'meta', at: 'now', leader: null }) + '\n');
  assert.deepEqual(new BoardStore(dir).marshalConfig(P.id), { enabled: true, waveSize: 2, stallMinutes: 90 }, 'an older line leaves the config alone');
  // a damaged line: the unreadable fields fall back, and `enabled` only ever reads as a real boolean
  appendFileSync(fileOf(dir), JSON.stringify({ v: 1, kind: 'meta', at: 'now', leader: null, marshal: { enabled: 'yes', waveSize: 99, stallMinutes: 0 } }) + '\n');
  assert.deepEqual(new BoardStore(dir).marshalConfig(P.id), { enabled: false, waveSize: 3, stallMinutes: 8 }, 'a damaged config falls back to the defaults, never to on');
});
