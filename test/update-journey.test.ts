/** H2: the update journey model. One step table, one event shape, one fold: the window, the panel and the logs all read the same thing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JOURNEY_STEPS, foldJourney, journeyLine, newUpdateId, parseJourneyJsonl, parseJourneyLine, type JourneyEvent, type JourneyStepId } from '../src/core/updater/journey.js';

const ev = (step: JourneyStepId, state: JourneyEvent['state'], over: Partial<JourneyEvent> = {}): JourneyEvent => ({ at: '2026-10-15T10:00:00.000Z', id: 'ab12cd34', step, state, proc: 'helper', from: '0.3.1', to: '0.3.2', ...over });

test('H2: the journey has the ten named steps in order, then failed and rolled back, each with where it runs', () => {
  assert.deepEqual(JOURNEY_STEPS.map((s) => `${s.n}:${s.id}:${s.where}`), [
    '1:checking:app', '2:downloading:app', '3:verifying:app', '4:ready:app', '5:closing:app', '6:preparing:helper', '7:installing:helper',
    '8:starting:helper', '9:health:helper', '10:done:new-app', 'x:failed:any', 'y:rolled-back:helper',
  ]);
  assert.deepEqual(JOURNEY_STEPS.filter((s) => s.fullOnly).map((s) => s.id), ['preparing'], 'only Preparing is for full updates');
  for (const s of JOURNEY_STEPS) assert.ok(s.label.length > 2 && !/[—–]/.test(s.label), `${s.id} has plain words`);
});

test('H2: an update id is 8 hex characters and differs each time', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newUpdateId()));
  assert.equal(ids.size, 50);
  for (const i of ids) assert.match(i, /^[0-9a-f]{8}$/);
});

test('H2: a step line carries the step, the id, the versions and the process, and reads back the same', () => {
  const e = ev('installing', 'start', { note: 'a "quoted" note\nwith a newline', pct: 40, kind: 'full' });
  const line = journeyLine(e);
  assert.equal(line.includes('\n'), false, 'one line');
  assert.match(line, /^journey step=installing state=start id=ab12cd34 from=0.3.1 to=0.3.2 proc=helper/);
  assert.deepEqual(parseJourneyLine(`[${e.at}] ${line}`), { ...e, note: 'a "quoted" note\nwith a newline' });
  assert.equal(parseJourneyLine('[2026-10-15T10:00:00.000Z] apply 0.3.1 -> 0.3.2'), null);
  assert.equal(parseJourneyLine('journey step=nonsense state=start id=ab12cd34 from=a to=b proc=helper'), null, 'an unknown step is not a journey line');
});

test('H2: the jsonl reader skips lines that are not events', () => {
  const text = [JSON.stringify(ev('closing', 'start')), 'not json', JSON.stringify({ step: 'closing' }), JSON.stringify(ev('closing', 'done')), ''].join('\n');
  assert.deepEqual(parseJourneyJsonl(text).map((e) => e.state), ['start', 'done']);
});

test('H2: fold of a full update in progress: earlier steps checked, the current one active, the rest pending', () => {
  const v = foldJourney([
    ev('checking', 'done', { proc: 'core', kind: 'full' }), ev('downloading', 'start', { proc: 'core' }), ev('downloading', 'done', { proc: 'core' }),
    ev('verifying', 'done', { proc: 'core' }), ev('ready', 'done', { proc: 'core' }), ev('closing', 'start', { proc: 'app' }), ev('closing', 'done'),
    ev('preparing', 'start', { pct: 35 }),
  ])!;
  assert.equal(v.id, 'ab12cd34'); assert.equal(v.from, '0.3.1'); assert.equal(v.to, '0.3.2'); assert.equal(v.kind, 'full');
  const st = Object.fromEntries(v.steps.map((s) => [s.id, s.state]));
  assert.deepEqual(st, { checking: 'done', downloading: 'done', verifying: 'done', ready: 'done', closing: 'done', preparing: 'active', installing: 'pending', starting: 'pending', health: 'pending', done: 'pending' });
  assert.equal(v.current, 'preparing'); assert.equal(v.pct, 35); assert.equal(v.result, 'running');
});

test('H2: steps with no event of their own are checked once a later step is under way, and Preparing is skipped for a code update', () => {
  const v = foldJourney([ev('closing', 'done', { kind: 'code' }), ev('installing', 'start')])!;
  const st = Object.fromEntries(v.steps.map((s) => [s.id, s.state]));
  assert.equal(st.checking, 'done'); assert.equal(st.ready, 'done'); assert.equal(st.preparing, 'skipped'); assert.equal(st.installing, 'active'); assert.equal(st.health, 'pending');
  assert.equal(v.steps.find((s) => s.id === 'preparing')?.state, 'skipped');
});

test('H2: a finished journey is ok; a failed one names the step it failed in and why; a rolled back one says so', () => {
  const ok = foldJourney([ev('health', 'start'), ev('health', 'done'), ev('done', 'done', { proc: 'new-app' })])!;
  assert.equal(ok.result, 'ok'); assert.equal(ok.current, undefined); assert.ok(ok.steps.every((s) => s.state === 'done' || s.state === 'skipped'));
  const failed = foldJourney([ev('closing', 'start'), ev('failed', 'done', { during: 'closing', note: 'the app did not exit in time' })])!;
  assert.equal(failed.result, 'failed'); assert.equal(failed.reason, 'the app did not exit in time'); assert.equal(failed.failedAt, 'closing');
  assert.equal(failed.steps.find((s) => s.id === 'closing')?.state, 'failed');
  const back = foldJourney([ev('health', 'start'), ev('rolled-back', 'done', { during: 'health', note: 'it did not report healthy' })])!;
  assert.equal(back.result, 'rolled-back'); assert.equal(back.reason, 'it did not report healthy');
});

test('H2: fold reads the newest journey by default, or the one asked for, and ignores the others', () => {
  const a = ev('closing', 'done', { id: 'aaaaaaaa', to: '0.3.2' });
  const b = ev('closing', 'start', { id: 'bbbbbbbb', to: '0.3.3', at: '2026-10-15T11:00:00.000Z' });
  assert.equal(foldJourney([a, b])!.id, 'bbbbbbbb');
  assert.equal(foldJourney([a, b], 'aaaaaaaa')!.to, '0.3.2');
  assert.equal(foldJourney([]), null);
  assert.equal(foldJourney([a], 'zzzzzzzz'), null);
});

test('H2: every step has a time once it has an event, and the journey has a start and an end', () => {
  const v = foldJourney([ev('closing', 'start', { at: '2026-10-15T10:00:01.000Z' }), ev('closing', 'done', { at: '2026-10-15T10:00:04.000Z' }), ev('done', 'done', { at: '2026-10-15T10:00:30.000Z', proc: 'new-app' })])!;
  const c = v.steps.find((s) => s.id === 'closing')!;
  assert.equal(c.startedAt, '2026-10-15T10:00:01.000Z'); assert.equal(c.at, '2026-10-15T10:00:04.000Z');
  assert.equal(v.startedAt, '2026-10-15T10:00:01.000Z'); assert.equal(v.endedAt, '2026-10-15T10:00:30.000Z');
});
