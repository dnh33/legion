/**
 * The update-in-progress marker: one update at a time, and never while another one is live. A marker left by a dead updater is
 * reclaimed (its pid is dead, or its pid was recycled and the recorded start time no longer matches). Every I/O call is mocked through
 * MarkerDeps — these tests never touch a real filesystem.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKER_FILE_NAME, endUpdate, isUpdateInProgress, judgeMarker, parseMarker, tryBeginUpdate, type MarkerDeps, type UpdateMarker } from '../src/core/updater/update-marker.js';

const PATH = '/legion/.update/' + MARKER_FILE_NAME;
const NOW = 1_760_000_000_000;
const OWN_START = 1_759_990_000_000;

interface Fake {
  deps: MarkerDeps;
  files: Map<string, string>;
  /** pid -> its process start time, or null when the platform will not say; absent = the pid is dead. */
  procs: Map<number, number | null>;
  logs: string[];
  creates: number;
  removes: number;
}

function fake(init: {
  files?: Record<string, string>;
  procs?: Record<number, number | null>;
  /** return true to make the exclusive create fail with EACCES instead of creating */
  createFails?: (world: Fake, attempt: number) => boolean;
  /** runs after a successful create — used to slip another process's marker in */
  afterCreate?: (world: Fake, attempt: number) => void;
} = {}): Fake {
  const files = new Map(Object.entries(init.files ?? {}));
  const procs = new Map<number, number | null>();
  for (const [pid, start] of Object.entries(init.procs ?? {})) procs.set(Number(pid), start);
  procs.set(process.pid, OWN_START);
  const world: Fake = {
    files, procs, logs: [], creates: 0, removes: 0,
    deps: {
      markerPath: PATH,
      now: () => NOW,
      isPidAlive: (pid) => procs.has(pid),
      getPidStartTime: (pid) => procs.get(pid) ?? null,
      createExclusive: (path, content) => {
        world.creates++;
        if (init.createFails?.(world, world.creates)) throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
        if (files.has(path)) throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
        files.set(path, content);
        init.afterCreate?.(world, world.creates);
      },
      read: (path) => files.get(path) ?? null,
      remove: (path) => { world.removes++; files.delete(path); },
      log: (msg) => { world.logs.push(msg); },
    },
  };
  return world;
}

const marker = (over: Partial<UpdateMarker> = {}): UpdateMarker => ({ pid: 4242, startTimeMs: 555, fromVersion: '1.0.0', toVersion: '1.1.0', startedAt: 999, ...over });
const seed = (text: string | UpdateMarker): Record<string, string> => ({ [PATH]: typeof text === 'string' ? text : JSON.stringify(text) });
const written = (world: Fake): UpdateMarker => JSON.parse(world.files.get(PATH) ?? 'null') as UpdateMarker;

test('tryBeginUpdate: the marker is created exclusively, recording this process, its start time and the versions', () => {
  assert.equal(MARKER_FILE_NAME, 'update-in-progress.json', 'the marker lives at <install>/.update/update-in-progress.json');
  const w = fake();
  const res = tryBeginUpdate(w.deps, { fromVersion: '1.0.0', toVersion: '1.1.0' });
  assert.deepEqual(res, { ok: true });
  const m = written(w);
  assert.equal(m.pid, process.pid);
  assert.equal(m.startTimeMs, OWN_START);
  assert.equal(m.fromVersion, '1.0.0');
  assert.equal(m.toVersion, '1.1.0');
  assert.equal(m.startedAt, NOW);
  assert.equal(w.creates, 1, 'one exclusive create: nothing was read or removed first');
  assert.equal(w.removes, 0);
});

test('tryBeginUpdate: a live marker (pid alive, start time matching) refuses with in-progress and is left alone', () => {
  const w = fake({ files: seed(marker()), procs: { 4242: 555 } });
  const res = tryBeginUpdate(w.deps, { fromVersion: '1.0.0', toVersion: '1.1.0' });
  if (res.ok) assert.fail('the begin must be refused');
  assert.equal(res.reason, 'in-progress');
  assert.match(res.message, /already in progress/);
  assert.equal(w.creates, 1, 'only the losing exclusive create');
  assert.equal(w.removes, 0, 'a live marker is never removed');
  assert.deepEqual(written(w), marker(), 'the owner keeps its marker');
});

test('tryBeginUpdate: a stale marker (the pid is dead) is reclaimed', () => {
  const w = fake({ files: seed(marker()), procs: {} }); // 4242 absent = dead
  const res = tryBeginUpdate(w.deps, { fromVersion: '1.0.0', toVersion: '1.1.0' });
  assert.deepEqual(res, { ok: true });
  assert.equal(w.removes, 1, 'the dead marker is removed');
  assert.equal(w.creates, 2, 'the exclusive create is retried after the reclaim');
  assert.equal(written(w).pid, process.pid);
  assert.equal(written(w).fromVersion, '1.0.0');
});

test('tryBeginUpdate: a stale marker (pid reused: the start time differs) is reclaimed', () => {
  const w = fake({ files: seed(marker({ startTimeMs: 555 })), procs: { 4242: 777 } }); // alive, but not the process that wrote the marker
  const res = tryBeginUpdate(w.deps, { fromVersion: '1.0.0', toVersion: '1.1.0' });
  assert.deepEqual(res, { ok: true });
  assert.equal(w.removes, 1);
  assert.equal(written(w).pid, process.pid);
});

test('tryBeginUpdate: a live marker whose start time cannot be read still refuses (fail-safe)', () => {
  const w = fake({ files: seed(marker()), procs: { 4242: null } });
  const res = tryBeginUpdate(w.deps, { fromVersion: '1.0.0', toVersion: '1.1.0' });
  if (res.ok) assert.fail('an uncertain marker must not be reclaimed');
  assert.equal(res.reason, 'in-progress');
  assert.equal(w.removes, 0);
  assert.deepEqual(written(w), marker());
});

test('tryBeginUpdate: a marker file that is not readable as a marker is reclaimed like a stale one', () => {
  const w = fake({ files: seed('not json') });
  const res = tryBeginUpdate(w.deps, { fromVersion: '1.0.0', toVersion: '1.1.0' });
  assert.deepEqual(res, { ok: true });
  assert.equal(w.removes, 1);
  assert.equal(written(w).pid, process.pid);
});

test('tryBeginUpdate: when another process takes the marker during the reclaim, begin fails instead of running two updates', () => {
  const foreign = marker({ pid: 5252, startTimeMs: 888 });
  const w = fake({
    files: seed(marker()),
    procs: { 5252: 888 }, // the stale 4242 marker; the intruder is alive
    afterCreate: (world, attempt) => { if (attempt === 2) world.files.set(PATH, JSON.stringify(foreign)); },
  });
  const res = tryBeginUpdate(w.deps, { fromVersion: '1.0.0', toVersion: '1.1.0' });
  if (res.ok) assert.fail('begin must fail once the marker is not ours');
  assert.equal(res.reason, 'error');
  assert.match(res.message, /taken by another process/);
  assert.deepEqual(written(w), foreign, 'the winning process keeps its marker');
});

test('tryBeginUpdate: a create that fails for any other reason reports an error', () => {
  const w = fake({ createFails: () => true });
  const res = tryBeginUpdate(w.deps, { fromVersion: '1.0.0', toVersion: '1.1.0' });
  if (res.ok) assert.fail('begin must fail');
  assert.equal(res.reason, 'error');
  assert.match(res.message, /could not create/);
});

test('endUpdate: the marker is removed; a missing marker is not an error', () => {
  const w = fake({ files: seed(marker()), procs: { 4242: 555 } });
  endUpdate(w.deps);
  assert.equal(w.files.has(PATH), false);
  assert.equal(w.removes, 1);
  assert.doesNotThrow(() => endUpdate(fake().deps), 'nothing on disk: nothing to remove');
});

test('isUpdateInProgress: no marker file means no update', () => {
  assert.deepEqual(isUpdateInProgress(fake().deps), { inProgress: false });
});

test('isUpdateInProgress: a live marker reports the update in progress with its marker', () => {
  const w = fake({ files: seed(marker()), procs: { 4242: 555 } });
  assert.deepEqual(isUpdateInProgress(w.deps), { inProgress: true, marker: marker() });
});

test('isUpdateInProgress: a stale marker is not in progress and is flagged stale', () => {
  const w = fake({ files: seed(marker()), procs: {} });
  assert.deepEqual(isUpdateInProgress(w.deps), { inProgress: false, marker: marker(), stale: true });
});

test('isUpdateInProgress: a marker file that parses as nothing is stale (safe to reclaim), never in progress', () => {
  assert.deepEqual(isUpdateInProgress(fake({ files: seed('not json') }).deps), { inProgress: false, stale: true });
});

test('judgeMarker: every verdict — none, live, alive-but-unverifiable, dead pid, recycled pid', () => {
  const m = marker();
  assert.deepEqual(judgeMarker(null, { pidAlive: false, pidStartTimeMs: null }), { status: 'none' });
  assert.deepEqual(judgeMarker(m, { pidAlive: true, pidStartTimeMs: 555 }), { status: 'active', marker: m });
  assert.deepEqual(judgeMarker(m, { pidAlive: true, pidStartTimeMs: null }), { status: 'active', marker: m }, 'alive but its start time cannot be read: stay active');
  assert.deepEqual(judgeMarker(m, { pidAlive: false, pidStartTimeMs: null }), { status: 'stale', marker: m, reason: 'dead-pid' });
  assert.deepEqual(judgeMarker(m, { pidAlive: true, pidStartTimeMs: 777 }), { status: 'stale', marker: m, reason: 'pid-reuse' });
});

test('parseMarker: only a complete, well-typed marker parses', () => {
  assert.deepEqual(parseMarker(JSON.stringify(marker())), marker());
  assert.equal(parseMarker(null), null);
  assert.equal(parseMarker('not json'), null);
  assert.equal(parseMarker('[]'), null);
  assert.equal(parseMarker('null'), null);
  assert.equal(parseMarker(JSON.stringify({ ...marker(), pid: 0 })), null);
  assert.equal(parseMarker(JSON.stringify({ ...marker(), pid: -5 })), null);
  assert.equal(parseMarker(JSON.stringify({ ...marker(), pid: 1.5 })), null);
  assert.equal(parseMarker(JSON.stringify({ ...marker(), startTimeMs: 'x' })), null);
  assert.equal(parseMarker(JSON.stringify({ ...marker(), startedAt: Number.NaN })), null);
  assert.equal(parseMarker(JSON.stringify({ ...marker(), fromVersion: 3 })), null);
  assert.equal(parseMarker(JSON.stringify({ ...marker(), toVersion: undefined })), null);
  assert.deepEqual(parseMarker(JSON.stringify({ ...marker(), extra: 'ignored' })), marker(), 'extra fields are tolerated');
});
