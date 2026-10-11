/**
 * State preflight: the data safety net that runs BEFORE an update touches any file. Backs up the user data into a
 * timestamped folder inside .update/ and FAILS CLOSED: any copy error or a run over 30 s returns ok:false and the
 * caller must cancel the update. Every I/O call is injected, so these tests use no real filesystem.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { BACKUP_ENTRIES, runPreflight, type PreflightDeps } from '../src/core/updater/state-preflight.js';

const DATA = 'DATA';
const BAK = join('.update', 'backup-1700000000000');

/** A virtual data dir recording every copy, mkdir and log. `clock` drives the 30 s deadline; `throwOn` makes a copy throw. */
function rig(opts: { files?: readonly string[]; clock?: () => number; throwOn?: (src: string) => string | null } = {}) {
  const present = new Set<string>();
  for (const n of opts.files ?? []) present.add(join(DATA, n));
  const copies: Array<{ src: string; dst: string }> = [];
  const made: string[] = [];
  const logs: string[] = [];
  const deps: PreflightDeps = {
    dataDir: DATA,
    backupDir: BAK,
    copyFile: (src, dst) => { const msg = opts.throwOn?.(src) ?? null; if (msg) throw new Error(msg); copies.push({ src, dst }); present.add(dst); },
    mkdir: (p) => { made.push(p); present.add(p); },
    exists: (p) => present.has(p),
    now: opts.clock ?? (() => 1700000000000),
    log: (m) => { logs.push(m); },
  };
  return { deps, copies, made, logs };
}

test('preflight: backs up every existing data entry into the backup folder, and creates that folder first', () => {
  const r = rig({ files: ['state.db', 'state.json', 'config.json', 'projects.json'] });
  const res = runPreflight(r.deps);
  assert.equal(res.ok, true);
  assert.deepEqual(r.made, [BAK], 'the backup folder is created before anything is copied');
  assert.deepEqual(r.copies, [
    { src: join(DATA, 'state.db'), dst: join(BAK, 'state.db') },
    { src: join(DATA, 'state.json'), dst: join(BAK, 'state.json') },
    { src: join(DATA, 'config.json'), dst: join(BAK, 'config.json') },
    { src: join(DATA, 'projects.json'), dst: join(BAK, 'projects.json') },
  ]);
  assert.deepEqual([...BACKUP_ENTRIES], ['state.db', 'state.json', 'config.json', 'projects.json', 'messages'], 'the backed-up set is fixed and complete');
});

test('preflight: a missing entry is skipped silently', () => {
  const r = rig({ files: ['config.json'] });
  const res = runPreflight(r.deps);
  assert.equal(res.ok, true);
  assert.deepEqual(r.copies, [{ src: join(DATA, 'config.json'), dst: join(BAK, 'config.json') }]);
  assert.deepEqual(res.backedUp, ['config.json']);
  assert.ok(r.logs.every((l) => !/missing|error|fail/i.test(l)), `a missing file is not an error: ${r.logs.join(' | ')}`);
});

test('preflight: backedUp records exactly what was copied, including the messages directory', () => {
  const r = rig({ files: ['state.json', 'config.json', 'messages'] });
  const res = runPreflight(r.deps);
  assert.equal(res.ok, true);
  assert.deepEqual(res.backedUp, ['state.json', 'config.json', 'messages']);
  assert.deepEqual(r.copies.map((c) => c.dst), [join(BAK, 'state.json'), join(BAK, 'config.json'), join(BAK, 'messages')]);
});

test('preflight: fail closed when a copy throws — the caller must cancel the update', () => {
  const r = rig({
    files: ['state.db', 'state.json', 'config.json', 'projects.json', 'messages'],
    throwOn: (src) => (src === join(DATA, 'projects.json') ? 'EPERM: locked' : null),
  });
  const res = runPreflight(r.deps);
  if (res.ok) assert.fail('expected ok:false when a backup copy throws');
  assert.match(res.error, /EPERM/);
  assert.deepEqual(res.backedUp, ['state.db', 'state.json', 'config.json'], 'what was copied before the failure is still reported');
  assert.equal(r.copies.length, 3, 'copying stops at the failure');
});

test('preflight: a run over 30 seconds fails closed and copies nothing more', () => {
  let t = 0;
  const clock = () => { const v = t; t += 20_000; return v; };
  const r = rig({ files: ['state.db', 'state.json', 'config.json', 'projects.json'], clock });
  const res = runPreflight(r.deps);
  if (res.ok) assert.fail('expected ok:false when the 30 s deadline is exceeded');
  assert.match(res.error, /timed out/i);
  assert.equal(r.copies.length, 1, 'the deadline is checked before every copy');
  assert.deepEqual(res.backedUp, ['state.db']);
});
