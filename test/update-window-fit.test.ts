/** H2 round 2: the update window fits at any zoom and display scale, a failed update never leaves Legion unstarted, and every outcome has its own plain sentence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitToContent, fitWindow, gateModel, outcomeText, placeInArea, shouldStartLegion, windowModel } from '../src/core/updater/update-window-logic.js';
import { foldJourney, plainReason, type JourneyEvent, type JourneyStepId } from '../src/core/updater/journey.js';

const AREA_1080 = { x: 0, y: 0, width: 1920, height: 1040 };
const AREA_768 = { x: 0, y: 0, width: 1366, height: 728 }; // a 768 px laptop minus the taskbar
const ev = (step: JourneyStepId, state: JourneyEvent['state'], over: Partial<JourneyEvent> = {}): JourneyEvent => ({ at: '2026-10-15T10:00:00.000Z', id: 'ab12cd34', step, state, proc: 'helper', from: '0.3.1', to: '0.3.2', ...over });

test('fit: at 100 percent the window is the content, never under the minimum, never over the work area', () => {
  assert.deepEqual(fitWindow({ contentHeight: 500, zoom: 1, workArea: AREA_1080 }), { width: 480, height: 502 });
  assert.equal(fitWindow({ contentHeight: 200, zoom: 1, workArea: AREA_1080 }).height, 420, 'a short page keeps the minimum');
  assert.equal(fitWindow({ contentHeight: 5000, zoom: 1, workArea: AREA_768 }).height, 728, 'a very long page is clamped to the usable height');
});

test('fit: the window grows with the zoom factor (125 and 150 percent)', () => {
  assert.deepEqual(fitWindow({ contentHeight: 500, zoom: 1.25, workArea: AREA_1080 }), { width: 600, height: 627 });
  assert.deepEqual(fitWindow({ contentHeight: 500, zoom: 1.5, workArea: AREA_1080 }), { width: 720, height: 752 });
  assert.equal(fitWindow({ contentHeight: 100, zoom: 1.5, workArea: AREA_1080 }).height, 630, 'the minimum scales too');
});

test('fit: on a 768 px laptop at any zoom the window is the work area at most (the body scrolls, the buttons stay)', () => {
  for (const zoom of [1, 1.25, 1.5, 2, 3]) {
    const r = fitWindow({ contentHeight: 560, zoom, workArea: AREA_768 });
    assert.ok(r.height <= AREA_768.height && r.width <= AREA_768.width, `zoom ${zoom}: ${r.width}x${r.height}`);
  }
  assert.equal(fitWindow({ contentHeight: 560, zoom: 1.5, workArea: AREA_768 }).height, 728);
});

test('fit: a zoom that is not a number counts as 100 percent, a window is never smaller than 1 px', () => {
  assert.deepEqual(fitWindow({ contentHeight: 500, zoom: Number.NaN, workArea: AREA_1080 }), { width: 480, height: 502 });
  assert.deepEqual(fitWindow({ contentHeight: 500, zoom: 0, workArea: AREA_1080 }), { width: 480, height: 502 });
  assert.ok(fitWindow({ contentHeight: 500, zoom: 1, workArea: { x: 0, y: 0, width: 0, height: 0 } }).height >= 1);
});

test('place: the window keeps its centre, and is pulled back inside the work area', () => {
  assert.deepEqual(placeInArea({ x: 720, y: 285, width: 480, height: 470 }, { width: 480, height: 640 }, AREA_1080), { x: 720, y: 200 });
  assert.deepEqual(placeInArea({ x: 720, y: 600, width: 480, height: 400 }, { width: 720, height: 900 }, AREA_1080), { x: 600, y: 140 }, 'bottom edge inside the area');
  assert.deepEqual(placeInArea({ x: 0, y: 0, width: 480, height: 400 }, { width: 720, height: 900 }, AREA_1080), { x: 0, y: 0 }, 'top-left edge inside the area');
});

test('fit: one function sizes both windows (bounds from the zoom and the work area; says whether it changed anything)', () => {
  let b = { x: 720, y: 285, width: 480, height: 470 };
  const w = { isDestroyed: () => false, getBounds: () => b, setBounds: (n: typeof b) => { b = n; }, webContents: { getZoomFactor: () => 1.5 } };
  assert.equal(fitToContent(w, 560, AREA_768), true);
  assert.ok(b.height <= 728 && b.y >= 0 && b.y + b.height <= 728, JSON.stringify(b));
  assert.equal(b.width, 720);
  assert.equal(fitToContent(w, 560, AREA_768), false, 'the same content again changes nothing');
  assert.equal(fitToContent({ ...w, isDestroyed: () => true }, 560, AREA_768), false);
});

test('start: when the helper did not start Legion again, any way out of a failed window starts it; never after done or an orphan, never when it already did', () => {
  for (const reason of ['user-retry', 'user-closed', 'failed-linger', 'hard-cap'] as const) {
    assert.equal(shouldStartLegion({ result: 'failed', at: 0, started: false }, reason), true, reason);
    assert.equal(shouldStartLegion({ result: 'rolled-back', at: 0, started: false }, reason), true, reason);
    assert.equal(shouldStartLegion({ result: 'failed', at: 0, started: true }, reason), false, `${reason}: the helper already started it`);
  }
  assert.equal(shouldStartLegion({ result: 'ok', at: 0, started: false }, 'done'), false);
  assert.equal(shouldStartLegion(undefined, 'orphan'), false);
  assert.equal(shouldStartLegion({ result: 'failed', at: 0 }, 'user-retry'), false, 'a helper that does not say: never start a second Legion');
});

const failedAt = (during: JourneyStepId, note: string): ReturnType<typeof foldJourney> => foldJourney([ev('closing', 'start'), ev('failed', 'done', { during, note })]);

test('outcome text: each outcome has its own sentence, capitalised, one period, no address, no raw code', () => {
  const t1 = outcomeText({ result: 'failed', reason: 'preflight: disk full', failedAt: 'closing', from: '0.3.1' });
  assert.equal(t1, 'Legion could not back up your data first. Your files are unchanged.');
  const t2 = outcomeText({ result: 'failed', reason: 'the app did not exit in time; nothing was changed', failedAt: 'closing', from: '0.3.1' });
  assert.equal(t2, 'Legion did not close in time. Your files are unchanged.');
  const t3 = outcomeText({ result: 'rolled-back', reason: 'the new build did not report healthy on 127.0.0.1:4747 within 180 s', failedAt: 'health', from: '0.3.1' });
  assert.equal(t3, 'The new version did not start correctly. Legion went back to 0.3.1.');
  const t4 = outcomeText({ result: 'failed', reason: 'something odd happened in the middle', failedAt: 'starting', from: '0.3.1' });
  assert.equal(t4, 'Something odd happened in the middle.', 'no claim about the files when it failed after the swap');
  const t5 = outcomeText({ result: 'failed', reason: 'something odd', from: '0.3.1' });
  assert.equal(t5, 'Something odd.', 'no claim when the step is not known');
  const t6 = outcomeText({ result: 'rolled-back', reason: 'a newer update started before this build was confirmed', from: '' });
  assert.equal(t6, 'A newer update started before this build was confirmed. Legion went back to the previous version.');
  for (const t of [t1, t2, t3, t4, t5, t6]) {
    assert.ok(/^[A-Z]/.test(t), t); assert.ok(!/\.\./.test(t), t); assert.ok(!/\d+\.\d+\.\d+\.\d+|:\d{4}|EBUSY|EPERM|EACCES/.test(t), t); assert.ok(!/\u2014/.test(t), t);
  }
});

test('outcome text: files in use keeps the advice, in the window and in Settings', () => {
  const r = 'files in use: close other Legion windows or tools started in the Legion folder, then try again';
  assert.equal(outcomeText({ result: 'failed', reason: r, failedAt: 'installing', from: '0.3.1' }),
    'Some files were in use. Close other Legion windows or programs using the Legion folder, then press Retry. Your files are unchanged.');
  assert.equal(outcomeText({ result: 'failed', reason: r, failedAt: 'installing', from: '0.3.1' }, 'settings'),
    'Some files were in use. Close other Legion windows or programs using the Legion folder, then try the update again. Your files are unchanged.');
  assert.match(outcomeText({ result: 'failed', reason: 'EBUSY: resource busy, rename C:\\x\\dist', failedAt: 'installing' }), /^Some files were in use\. Close other Legion windows/);
});

test('outcome text: a long reason shows in full (never cut to "ev...."), a reason that ends in dots gets one period', () => {
  const long = 'event '.repeat(60).trim();
  const t = outcomeText({ result: 'failed', reason: long, failedAt: 'starting' });
  assert.ok(t.endsWith('event.') && !t.includes('...') && t.length > 250, t.slice(-40));
  assert.equal(outcomeText({ result: 'failed', reason: 'it stopped...', failedAt: 'starting' }), 'It stopped.');
  assert.equal(outcomeText({ result: 'failed', reason: 'it stopped.', failedAt: 'starting' }), 'It stopped.');
  assert.ok(!plainReason('x '.repeat(200)).includes('...'));
});

test('outcome text: an address, a port and a drive path never reach the person', () => {
  const t = outcomeText({ result: 'failed', reason: 'could not reach http://127.0.0.1:4747/health and C:\\Users\\Danie\\legion\\dist', failedAt: 'starting' });
  assert.ok(!/127\.0\.0\.1|4747|C:\\/.test(t), t);
});

test('window model: the message is the outcome sentence, with the step the journey failed in', () => {
  assert.equal(windowModel(failedAt('closing', 'preflight: disk full'), undefined).message, 'Legion could not back up your data first. Your files are unchanged.');
  const rb = foldJourney([ev('health', 'start'), ev('rolled-back', 'done', { during: 'health', note: 'the new build did not report healthy on 127.0.0.1:4747 within 180 s' })]);
  assert.equal(windowModel(rb, undefined).message, 'The new version did not start correctly. Legion went back to 0.3.1.');
  assert.equal(gateModel(rb, undefined).message, 'The new version did not start correctly. Legion went back to 0.3.1.');
});

test('journey view: the Settings text is made in the core, so About shows the same words as the window', () => {
  const rb = foldJourney([ev('health', 'start'), ev('rolled-back', 'done', { during: 'health', note: 'the new build did not report healthy on 127.0.0.1:4747 within 180 s' })]);
  assert.equal(rb?.message, 'The new version did not start correctly. Legion went back to 0.3.1.');
  const ok = foldJourney([ev('health', 'start'), ev('health', 'done'), ev('done', 'done')]);
  assert.equal(ok?.message, undefined);
});

test('window flags: the Chromium switches the app was started with reach the update window; a normal start passes none, and nothing else is forwarded', async () => {
  const { windowSwitches } = await import('../src/core/updater/main-logic.js');
  assert.deepEqual(windowSwitches(['electron.exe', 'D:\legion', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=9222', '--inspect', '--disable-dev-shm-usage', '--disable-software-rasterizer']), ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--disable-software-rasterizer']);
  assert.deepEqual(windowSwitches(['electron.exe', 'D:\legion']), []);
});
