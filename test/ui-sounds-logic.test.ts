import test from 'node:test';
import assert from 'node:assert/strict';
import { CueGate, cueFor, diffSnapshots, type SoundEvent, type SoundCtx, type SoundSnapshot } from '../ui/src/sound/soundLogic.js';

const at = (h: number, m = 0): number => new Date(2026, 9, 14, h, m, 0, 0).getTime();
const ctx = (over: Partial<SoundCtx> = {}, prefs: Partial<SoundCtx['prefs']> = {}): SoundCtx => ({
  now: at(12), focused: true, prefs: { enabled: true, volume: 0.6, pack: 'minimal', queuedCue: false, ...prefs }, ...over,
});
const ev = (...t: SoundEvent['type'][]): SoundEvent[] => t.map((type) => (type === 'switch' ? { type, on: true } : { type })) as SoundEvent[];

test('the cue map: each event has one cue', () => {
  assert.equal(cueFor(ev('ask'), ctx()), 'notification');
  assert.equal(cueFor(ev('run-done'), ctx()), 'complete');
  assert.equal(cueFor(ev('run-failed'), ctx()), 'error');
  assert.equal(cueFor(ev('allow'), ctx()), 'success');
  assert.equal(cueFor(ev('deny'), ctx()), 'cancel');
  assert.equal(cueFor([{ type: 'switch', on: true }], ctx()), 'check');
  assert.equal(cueFor([{ type: 'switch', on: false }], ctx()), 'deselect');
  assert.equal(cueFor([], ctx()), null);
});

test('queued is off by default and plays only when the pack option is on', () => {
  assert.equal(cueFor(ev('run-started'), ctx()), null);
  assert.equal(cueFor(ev('run-started'), ctx({}, { queuedCue: true })), 'queued');
});

test('master off, volume zero and quiet hours silence everything, attention cues too', () => {
  assert.equal(cueFor(ev('ask'), ctx({}, { enabled: false })), null);
  assert.equal(cueFor(ev('run-failed'), ctx({}, { volume: 0 })), null);
  const quiet = { enabled: true, from: '22:00', to: '07:00' };
  assert.equal(cueFor(ev('ask'), ctx({ now: at(23, 30) }, { quiet })), null);
  assert.equal(cueFor(ev('ask'), ctx({ now: at(3) }, { quiet })), null);
  assert.equal(cueFor(ev('ask'), ctx({ now: at(12) }, { quiet })), 'notification');
  assert.equal(cueFor(ev('ask'), ctx({ now: at(23, 30) }, { quiet: { ...quiet, enabled: false } })), 'notification');
});

test('an unfocused window plays the attention cues only, never click feedback', () => {
  const away = ctx({ focused: false });
  assert.equal(cueFor(ev('ask'), away), 'notification');
  assert.equal(cueFor(ev('run-done'), away), 'complete');
  assert.equal(cueFor(ev('run-failed'), away), 'error');
  assert.equal(cueFor(ev('allow'), away), null);
  assert.equal(cueFor(ev('deny'), away), null);
  assert.equal(cueFor(ev('switch'), away), null);
  assert.equal(cueFor(ev('run-started'), ctx({ focused: false }, { queuedCue: true })), null);
});

test('many runs finishing at once coalesce to one cue, and the worst news wins', () => {
  assert.equal(cueFor(ev('run-done', 'run-done', 'run-done', 'run-done'), ctx()), 'complete');
  assert.equal(cueFor(ev('run-done', 'run-failed', 'run-done'), ctx()), 'error');
  assert.equal(cueFor(ev('run-done', 'ask'), ctx()), 'notification');
  assert.equal(cueFor(ev('run-done', 'run-failed', 'ask'), ctx()), 'error');
});

test('the gate rate limits a cue by its cooldown and keeps a short gap between any two', () => {
  const g = new CueGate();
  assert.equal(g.admit('notification', 1000), true);
  assert.equal(g.admit('notification', 1500), false);   // same cue inside its cooldown
  assert.equal(g.admit('complete', 1050), false);       // a different cue right behind it
  assert.equal(g.admit('complete', 1400), true);
  assert.equal(g.admit('notification', 3500), true);    // cooldown over
  assert.equal(g.admit('check', 3510), false);
  assert.equal(g.admit('check', 3700), true);
});

const snap = (over: Partial<SoundSnapshot> = {}): SoundSnapshot => ({ tasks: new Map(), asks: new Set(), ...over });

test('diffing state: the first snapshot is silent, a new ask is one event, the same ask again is none', () => {
  const seen = new Set<string>();
  assert.deepEqual(diffSnapshots(null, snap({ asks: new Set(['a1']), tasks: new Map([['t1', 'running']]) }), seen), []);
  assert.deepEqual(diffSnapshots(snap({ asks: new Set(['a1']) }), snap({ asks: new Set(['a1', 'a2']) }), seen), [{ type: 'ask' }]);
  // a reconnect refresh that drops and re-adds an ask already announced stays silent
  assert.deepEqual(diffSnapshots(snap({ asks: new Set(['a1']) }), snap({ asks: new Set(['a1', 'a2']) }), seen), []);
});

test('diffing state: run status changes become events; history loads and cancels are silent', () => {
  const seen = new Set<string>();
  const prev = snap({ tasks: new Map([['t1', 'running'], ['t2', 'running'], ['t3', 'queued'], ['t4', 'running']]) });
  const next = snap({ tasks: new Map([['t1', 'done'], ['t2', 'error'], ['t3', 'running'], ['t4', 'cancelled'], ['old', 'done']]) });
  assert.deepEqual(diffSnapshots(prev, next, seen), [{ type: 'run-done' }, { type: 'run-failed' }]);
  assert.deepEqual(diffSnapshots(snap(), snap({ tasks: new Map([['n1', 'queued']]) }), seen), [{ type: 'run-started' }]);
  assert.deepEqual(diffSnapshots(snap({ tasks: new Map([['x', 'done']]) }), snap({ tasks: new Map([['x', 'done']]) }), seen), []);
});
