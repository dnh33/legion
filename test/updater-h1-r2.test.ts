/** H1 round 2: no runtime copy on a full disk (and no retry loop), Retry always answers, a handoff relaunch waits for the lock. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UPDATE_DIR } from '../src/core/updater/apply.js';
import { planApplySpawn, prepareRuntimeCopy, runtimeCopyDir, shouldPrepare } from '../src/core/updater/runtime-copy.js';
import { RETRY_LATER_LINE, runNoticeChoice } from '../src/core/updater/outcome-notice.js';
import type { NoticeCall } from '../src/core/updater/outcome-notice.js';
import { acquireStartLock } from '../src/electron/instance-logic.js';

function fixture(): { install: string; src: string } {
  const install = cleanupTemp('h1r2-copy-');
  const src = join(install, 'runtime', 'electron');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'electron.exe'), Buffer.alloc(50_000, 7));
  writeFileSync(join(src, 'ffmpeg.dll'), Buffer.alloc(9000, 1));
  return { install, src };
}

test('low disk: no copy is started, nothing is left behind, and the apply falls back to the helper re-exec', async () => {
  const f = fixture();
  const a = { installDir: f.install, srcDir: f.src, exeName: 'electron.exe', freeBytes: () => 10_000, marginBytes: 1000 };
  const r = await prepareRuntimeCopy(a);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.lowDisk === true);
  assert.ok(!r.ok && /not enough free disk space/i.test(r.error));
  assert.ok(!existsSync(runtimeCopyDir(f.install)));
  const left = existsSync(join(f.install, UPDATE_DIR)) ? readdirSync(join(f.install, UPDATE_DIR)) : [];
  assert.deepEqual(left, [], 'no temp folder either');
  const plan = planApplySpawn(a);
  assert.equal(plan.fromCopy, false);
  assert.deepEqual(plan.env, {});
});

test('the check is runtime size plus margin: exactly enough copies, one byte short does not', async () => {
  const f = fixture();
  const need = 59_000 + 1000;
  const short = await prepareRuntimeCopy({ installDir: f.install, srcDir: f.src, exeName: 'electron.exe', freeBytes: () => need - 1, marginBytes: 1000 });
  assert.ok(!short.ok && short.lowDisk === true);
  const ok = await prepareRuntimeCopy({ installDir: f.install, srcDir: f.src, exeName: 'electron.exe', freeBytes: () => need, marginBytes: 1000 });
  assert.ok(ok.ok);
  assert.ok(existsSync(runtimeCopyDir(f.install)));
});

test('a broken free-space probe does not block the copy', async () => {
  const f = fixture();
  const r = await prepareRuntimeCopy({ installDir: f.install, srcDir: f.src, exeName: 'electron.exe', freeBytes: () => { throw new Error('no statfs'); }, marginBytes: 1000 });
  assert.ok(r.ok);
});

test('shouldPrepare: a low-disk result is not retried until another update is staged; a plain failure waits out its delay', () => {
  const g = { preparing: false, retryAt: 0, lowDiskVersion: null as string | null };
  assert.equal(shouldPrepare(g, 1000, '0.3.3'), true);
  assert.equal(shouldPrepare({ ...g, preparing: true }, 1000, '0.3.3'), false);
  assert.equal(shouldPrepare({ ...g, retryAt: 5000 }, 1000, '0.3.3'), false);
  assert.equal(shouldPrepare({ ...g, retryAt: 5000 }, 6000, '0.3.3'), true);
  const low = { ...g, lowDiskVersion: '0.3.3' };
  for (const t of [1000, 10 * 60_000, 24 * 3600_000]) assert.equal(shouldPrepare(low, t, '0.3.3'), false, 'same staged update: never loops');
  assert.equal(shouldPrepare(low, 1000, '0.3.4'), true, 'the next staged update tries again');
});

const rec = (): { calls: string[]; log: string[]; call: (script: Record<string, { status: number; json?: any }>) => NoticeCall } => {
  const calls: string[] = []; const log: string[] = [];
  return { calls, log, call: (script) => async (m, route) => { calls.push(`${m} ${route}`); return script[`${m} ${route}`] ?? { status: 200, json: {} }; } };
};
const notice = { title: 'Legion update', message: 'm', buttons: ['Retry', 'Dismiss'] as ['Retry', 'Dismiss'], rolledBack: false, to: '0.3.3' };

test('Dismiss is logged and acknowledges the record', async () => {
  const r = rec();
  const out = await runNoticeChoice(notice, 1, r.call({}), (l) => r.log.push(l));
  assert.equal(out.kind, 'dismissed');
  assert.deepEqual(r.calls, ['POST /api/update/ack']);
  assert.ok(r.log.some((l) => /dismiss/i.test(l)));
});

test('Retry with an update already known installs at once', async () => {
  const r = rec();
  const out = await runNoticeChoice(notice, 0, r.call({ 'GET /api/update/status': { status: 200, json: { available: { version: '0.3.3' } } } }), (l) => r.log.push(l));
  assert.equal(out.kind, 'installing');
  assert.deepEqual(r.calls, ['POST /api/update/ack', 'GET /api/update/status', 'POST /api/update/install']);
  assert.ok(r.log.some((l) => /retry/i.test(l)));
});

test('Retry with no update known runs a check first, then installs', async () => {
  const r = rec();
  let checked = false;
  const call: NoticeCall = async (m, route) => {
    r.calls.push(`${m} ${route}`);
    if (route === '/api/update/check') { checked = true; return { status: 200, json: {} }; }
    if (route === '/api/update/status') return { status: 200, json: checked ? { available: { version: '0.3.3' } } : {} };
    return { status: 200, json: {} };
  };
  const out = await runNoticeChoice({ ...notice, rolledBack: true }, 0, call, (l) => r.log.push(l));
  assert.equal(out.kind, 'installing');
  assert.deepEqual(r.calls, ['POST /api/update/retry', 'GET /api/update/status', 'POST /api/update/check', 'GET /api/update/status', 'POST /api/update/install']);
});

test('Retry that install refuses says one plain line and logs the reason; it never fails silently', async () => {
  const r = rec();
  const out = await runNoticeChoice(notice, 0, r.call({
    'GET /api/update/status': { status: 200, json: {} },
    'POST /api/update/check': { status: 429, json: { error: 'Checked a moment ago.' } },
    'POST /api/update/install': { status: 409, json: { error: 'There is no verified update to install. Check for updates first.' } },
  }), (l) => r.log.push(l));
  assert.equal(out.kind, 'later');
  assert.equal(out.kind === 'later' && out.line, 'The update will try again when Legion is idle.');
  assert.equal(RETRY_LATER_LINE, 'The update will try again when Legion is idle.');
  assert.ok(r.log.some((l) => /409/.test(l) && /no verified update/.test(l)), r.log.join('|'));
  const none = await runNoticeChoice(notice, 0, async () => undefined, (l) => r.log.push(l));
  assert.equal(none.kind, 'later', 'an unreachable core is also answered, not swallowed');
});

test('a handoff relaunch retries the single-instance lock for up to 5 s; a normal second launch quits at once', async () => {
  let now = 0; const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => { sleeps.push(ms); now += ms; };
  let n = 0;
  assert.equal(await acquireStartLock({ request: () => ++n >= 4, handoff: true, sleep, now: () => now }), true);
  assert.equal(n, 4);
  now = 0; n = 0;
  assert.equal(await acquireStartLock({ request: () => { n++; return false; }, handoff: true, sleep, now: () => now }), false);
  assert.ok(now >= 5000 && now <= 5200, `gave up after about 5 s, not ${now} ms`);
  now = 0; n = 0; sleeps.length = 0;
  assert.equal(await acquireStartLock({ request: () => { n++; return false; }, handoff: false, sleep, now: () => now }), false);
  assert.equal(n, 1); assert.equal(sleeps.length, 0);
  assert.equal(await acquireStartLock({ request: () => true, handoff: false, sleep, now: () => now }), true);
});
