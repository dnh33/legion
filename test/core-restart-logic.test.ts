/** The core restarts itself once after an unexpected stop: the crash tracker (3 in 5 minutes), the decision, the window state, the switch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CRASH_LIMIT, CRASH_WINDOW_MS, CoreRestartState, CrashTracker, RESTART_DELAY_MS, SingleFlight,
  decideRestart, exitLine, readRestartSwitch, restartEnabled, withRestartEnabled, writeRestartSwitch, type RestartFacts,
} from '../src/electron/core-restart-logic.js';

const facts = (over: Partial<RestartFacts> = {}): RestartFacts => ({ intended: false, quitting: false, updating: false, sessionEnding: false, enabled: true, count: 1, ...over });

test('limits: 3 crashes in 5 minutes, a 1 second wait', () => {
  assert.equal(CRASH_LIMIT, 3);
  assert.equal(CRASH_WINDOW_MS, 300_000);
  assert.equal(RESTART_DELAY_MS, 1000);
});

test('tracker: counts crashes inside the window', () => {
  let t = 1_000_000;
  const k = new CrashTracker(() => t);
  assert.equal(k.register(), 1);
  t += 60_000;
  assert.equal(k.register(), 2);
  t += 3 * 60_000 + 59_000; // 4m59s after the first
  assert.equal(k.register(), 3);
});

test('tracker: a crash older than 5 minutes no longer counts', () => {
  let t = 0;
  const k = new CrashTracker(() => t);
  k.register();
  t = 60_000; k.register();
  t = CRASH_WINDOW_MS + 1; // the first is now 5m00.001s old
  assert.equal(k.register(), 2, 'the first fell out, the second and the new one count');
  t = CRASH_WINDOW_MS + 60_001;
  assert.equal(k.register(), 2, 'the second fell out too');
});

test('tracker: a crash exactly 5 minutes old still counts (older than the window drops, as the reference does)', () => {
  let t = 0;
  const k = new CrashTracker(() => t);
  k.register();
  t = CRASH_WINDOW_MS;
  assert.equal(k.register(), 2);
});

test('tracker: reset forgets every crash', () => {
  const k = new CrashTracker(() => 5);
  k.register(); k.register();
  k.reset();
  assert.equal(k.count(), 0);
  assert.equal(k.register(), 1);
});

test('decide: the first and second crash restart, the third stops at the limit', () => {
  assert.equal(decideRestart(facts({ count: 1 })).action, 'restart');
  assert.equal(decideRestart(facts({ count: 2 })).action, 'restart');
  const third = decideRestart(facts({ count: 3 }));
  assert.equal(third.action, 'stop-at-limit');
  assert.match(third.log, /not restarting: limit/);
  assert.equal(decideRestart(facts({ count: 4 })).action, 'stop-at-limit');
});

test('decide: an intended stop is ignored, and says why', () => {
  const d = decideRestart(facts({ intended: true }));
  assert.equal(d.action, 'ignore');
  assert.match(d.log, /not restarting: intended stop/);
});

test('decide: quitting is ignored', () => {
  const d = decideRestart(facts({ quitting: true }));
  assert.equal(d.action, 'ignore');
  assert.match(d.log, /not restarting: quitting/);
});

test('decide: a session end (logoff, shutdown) is ignored', () => {
  const d = decideRestart(facts({ sessionEnding: true }));
  assert.equal(d.action, 'ignore');
  assert.match(d.log, /not restarting: session ending/);
});

test('decide: an update that is applying or swapping is ignored', () => {
  const d = decideRestart(facts({ updating: true }));
  assert.equal(d.action, 'ignore');
  assert.match(d.log, /not restarting: update/);
});

test('decide: with the switch off nothing restarts, even at the limit', () => {
  const d = decideRestart(facts({ enabled: false }));
  assert.equal(d.action, 'ignore');
  assert.match(d.log, /not restarting: switched off/);
  assert.equal(decideRestart(facts({ enabled: false, count: 9 })).action, 'ignore');
});

test('decide: an intended stop wins over everything else', () => {
  assert.equal(decideRestart(facts({ intended: true, count: 9, enabled: false })).action, 'ignore');
  assert.match(decideRestart(facts({ intended: true, quitting: true })).log, /intended stop/);
});

test('decide: restart logs the count', () => {
  assert.match(decideRestart(facts({ count: 2 })).log, /restarting \(crash 2 of 3 in 5 minutes\)/);
});

test('exitLine: code, signal and the count in the window', () => {
  assert.equal(exitLine(1, null, 2), 'Legion Core exited unexpectedly: code 1, signal none, 2 in the last 5 minutes');
  assert.equal(exitLine(null, 'SIGKILL', 1), 'Legion Core exited unexpectedly: code none, signal SIGKILL, 1 in the last 5 minutes');
});

test('window state: the restart notice is handed out once', () => {
  const s = new CoreRestartState();
  assert.deepEqual(s.take(), { restarted: false, stopped: null });
  s.noteRestarted();
  assert.deepEqual(s.take(), { restarted: true, stopped: null });
  assert.deepEqual(s.take(), { restarted: false, stopped: null }, 'a second read finds nothing');
});

test('window state: stopped stays until the person restarts the core', () => {
  const s = new CoreRestartState();
  s.noteStopped('limit');
  assert.deepEqual(s.take(), { restarted: false, stopped: 'limit' });
  assert.deepEqual(s.take(), { restarted: false, stopped: 'limit' });
  s.clearStopped();
  assert.deepEqual(s.take(), { restarted: false, stopped: null });
});

test('window state: a restart that failed says so, not "limit"', () => {
  const s = new CoreRestartState();
  s.noteStopped('failed');
  assert.deepEqual(s.take(), { restarted: false, stopped: 'failed' });
});

test('window state: a stop replaces a pending restart notice', () => {
  const s = new CoreRestartState();
  s.noteRestarted(); s.noteStopped('limit');
  assert.deepEqual(s.take(), { restarted: false, stopped: 'limit' });
});

test('switch: on by default, only a real false turns it off', () => {
  assert.equal(restartEnabled(null), true);
  assert.equal(restartEnabled('not json'), true);
  assert.equal(restartEnabled('{}'), true);
  assert.equal(restartEnabled('{"restartCoreOnCrash":"false"}'), true);
  assert.equal(restartEnabled('{"restartCoreOnCrash":0}'), true);
  assert.equal(restartEnabled('[]'), true);
  assert.equal(restartEnabled('{"restartCoreOnCrash":true}'), true);
  assert.equal(restartEnabled('{"restartCoreOnCrash":false}'), false);
});

test('switch: writing keeps the other keys and survives a broken file', () => {
  assert.deepEqual(JSON.parse(withRestartEnabled(null, false)), { restartCoreOnCrash: false });
  assert.deepEqual(JSON.parse(withRestartEnabled('{"other":1,"restartCoreOnCrash":false}', true)), { other: 1, restartCoreOnCrash: true });
  assert.deepEqual(JSON.parse(withRestartEnabled('not json', false)), { restartCoreOnCrash: false });
  assert.deepEqual(JSON.parse(withRestartEnabled('[1]', false)), { restartCoreOnCrash: false });
  assert.equal(restartEnabled(withRestartEnabled(null, false)), false);
  assert.equal(restartEnabled(withRestartEnabled(withRestartEnabled(null, false), true)), true);
});

// L4: the switch file is read and written with care
test('switch file: a missing file is on; a file that is locked or unreadable means do not restart', () => {
  const missing = (): string => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
  assert.equal(readRestartSwitch('x', { read: missing }), true);
  for (const code of ['EBUSY', 'EACCES', 'EPERM', 'EISDIR']) {
    const locked = (): string => { throw Object.assign(new Error('locked'), { code }); };
    assert.equal(readRestartSwitch('x', { read: locked }), false, code);
  }
  assert.equal(readRestartSwitch('x', { read: () => '{"restartCoreOnCrash":false}' }), false);
  assert.equal(readRestartSwitch('x', { read: () => '{}' }), true);
});

test('switch file: the write goes through a temp file and a rename, keeps other keys, and never overwrites a file it could not read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-sw-'));
  try {
    const f = join(dir, 'app-settings.json');
    writeRestartSwitch(f, false);
    assert.equal(readRestartSwitch(f), false);
    writeFileSync(f, '{"other":1,"restartCoreOnCrash":false}');
    writeRestartSwitch(f, true);
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { other: 1, restartCoreOnCrash: true });
    assert.deepEqual(readdirSync(dir), ['app-settings.json'], 'no temp file left behind');
    // the rename is the only write to the real name
    const writes: string[] = [];
    const renames: Array<[string, string]> = [];
    writeRestartSwitch(f, false, { read: () => '{}', write: (p) => { writes.push(p); }, rename: (a, b) => { renames.push([a, b]); }, remove: () => undefined });
    assert.equal(writes.length, 1);
    assert.notEqual(writes[0], f, 'the content is written to a temp file first');
    assert.deepEqual(renames, [[writes[0]!, f]]);
    // a read that fails with EBUSY: throw, write nothing
    const w2: string[] = [];
    assert.throws(() => writeRestartSwitch(f, true, { read: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }, write: (p) => { w2.push(p); }, rename: () => undefined, remove: () => undefined }), /EBUSY|busy/);
    assert.deepEqual(w2, []);
    // a rename that fails: the temp file is removed and the error reaches the caller
    const removed: string[] = [];
    assert.throws(() => writeRestartSwitch(f, true, { read: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }, write: () => undefined, rename: () => { throw new Error('locked'); }, remove: (p) => { removed.push(p); } }), /locked/);
    assert.equal(removed.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// M2: one restart at a time
test('single flight: a second caller shares the restart that is running; a new one starts after it ends', async () => {
  const sf = new SingleFlight<string | null>();
  assert.equal(sf.busy, false);
  let starts = 0;
  let release!: (v: string | null) => void;
  const gate = new Promise<string | null>((r) => { release = r; });
  const a = sf.run(() => { starts++; return gate; });
  assert.equal(sf.busy, true);
  const b = sf.run(() => { starts++; return Promise.resolve('second'); });
  assert.equal(starts, 1);
  release('ok');
  assert.equal(await a, 'ok');
  assert.equal(await b, 'ok');
  assert.equal(sf.busy, false);
  assert.equal(await sf.run(() => { starts++; return Promise.resolve('again'); }), 'again');
  assert.equal(starts, 2);
});

test('single flight: a restart that throws frees the slot', async () => {
  const sf = new SingleFlight<string | null>();
  await assert.rejects(sf.run(() => Promise.reject(new Error('boom'))), /boom/);
  assert.equal(sf.busy, false);
  assert.equal(await sf.run(() => Promise.resolve(null)), null);
});
