/** The digest's hold (spec 3.2, decisions-log "Allow hold length"): pure, in memory, nothing sent until the countdown ends or Send now. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BLENDER_EXEC_TOOL } from '../src/shared/blender.js';
import { createHold, digestKey, holdMs, HOLD_MS, HOLD_IRREVERSIBLE_MS } from '../ui/src/projects/hold.js';

const okSend = () => { const calls: number[] = []; return { calls, send: async () => { calls.push(1); return { ok: true as const }; } }; };
const flush = () => new Promise<void>((r) => setImmediate(r));

test('hold length: 5 s for any Allow, 10 s when the ask is irreversible and certain', () => {
  assert.equal(HOLD_MS, 5000);
  assert.equal(HOLD_IRREVERSIBLE_MS, 10000);
  assert.equal(holdMs({ level: 1, certain: true }), 5000);
  assert.equal(holdMs({ level: 2, certain: true }), 5000);
  assert.equal(holdMs({ level: 3, certain: true }), 10000);
  assert.equal(holdMs({ level: 3, certain: false }), 5000, 'an unknown ask gets no inline Allow at all; the hold never gets shorter than 5 s');
  assert.equal(holdMs(undefined), 5000);
});

test('nothing is sent while counting; the countdown ends in one send', async () => {
  const s = okSend();
  const h = createHold({ totalMs: 5000, send: s.send });
  h.tick(4999);
  await flush();
  assert.equal(s.calls.length, 0);
  assert.equal(h.view().phase, 'counting');
  assert.equal(h.view().leftMs, 1);
  h.tick(1);
  await flush();
  assert.equal(s.calls.length, 1);
  assert.equal(h.view().phase, 'sent');
  h.tick(10_000); h.sendNow();
  await flush();
  assert.equal(s.calls.length, 1, 'sent exactly once');
});

test('Send now sends at once, once', async () => {
  const s = okSend();
  const h = createHold({ totalMs: 10_000, send: s.send });
  h.sendNow(); h.sendNow();
  await flush();
  assert.equal(s.calls.length, 1);
  assert.equal(h.view().phase, 'sent');
});

test('Undo before zero: nothing is ever sent', async () => {
  const s = okSend();
  const h = createHold({ totalMs: 5000, send: s.send });
  h.tick(3000); h.undo();
  h.tick(10_000); h.sendNow();
  await flush();
  assert.equal(s.calls.length, 0);
  assert.equal(h.view().phase, 'undone');
});

test('a pointer that rests under the click does not freeze the countdown; once it has left, coming back pauses', () => {
  const h = createHold({ totalMs: 5000, send: okSend().send });
  h.tick(1000);
  assert.equal(h.view().leftMs, 4000, 'resting pointer: still counting');
  h.pointerEnter(); h.tick(1000);
  assert.equal(h.view().leftMs, 3000);
  h.pointerLeave(); h.tick(1000);
  assert.equal(h.view().leftMs, 2000);
  h.pointerEnter();
  assert.equal(h.view().paused, true);
  h.tick(5000);
  assert.equal(h.view().leftMs, 2000, 'paused by hover');
  h.pointerLeave(); h.tick(500);
  assert.equal(h.view().leftMs, 1500, 'resumes');
});

test('keyboard focus (focus-visible) pauses; losing it resumes', () => {
  const h = createHold({ totalMs: 5000, send: okSend().send });
  h.focus(true); h.tick(2000);
  assert.equal(h.view().leftMs, 5000);
  assert.equal(h.view().paused, true);
  h.focus(false); h.tick(2000);
  assert.equal(h.view().leftMs, 3000);
});

test('dispose (the row left the page, or the window reloaded): never sends', async () => {
  const s = okSend();
  const h = createHold({ totalMs: 1000, send: s.send });
  h.dispose();
  h.tick(5000); h.sendNow();
  await flush();
  assert.equal(s.calls.length, 0);
  assert.equal(h.view().phase, 'disposed');
});

test('the core refusing (the ask was already settled) ends as refused with its reason', async () => {
  const h = createHold({ totalMs: 1000, send: async () => ({ ok: false as const, reason: 'This approval was already denied after 10 min.' }) });
  h.tick(1000);
  await flush();
  assert.equal(h.view().phase, 'refused');
  assert.equal(h.view().reason, 'This approval was already denied after 10 min.');
});

test('a send that throws ends as refused, never as sent', async () => {
  const h = createHold({ totalMs: 1000, send: async () => { throw new Error('offline'); } });
  h.tick(1000);
  await flush();
  assert.equal(h.view().phase, 'refused');
});

test('onChange reports every change', () => {
  const seen: string[] = [];
  const h = createHold({ totalMs: 2000, send: okSend().send, onChange: (v) => seen.push(`${v.phase}:${v.leftMs}`) });
  h.tick(500); h.undo();
  assert.deepEqual(seen, ['counting:1500', 'undone:1500']);
});

test('hold.ts keeps nothing outside memory and talks to no network', () => {
  const src = readFileSync(new URL('../../ui/src/projects/hold.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const word of ['localStorage', 'sessionStorage', 'indexedDB', 'sendBeacon', 'fetch(', 'XMLHttpRequest', 'api.']) assert.ok(!src.includes(word), `hold.ts must not use ${word}`);
});

/* ---------- keys ---------- */
const normal = { id: 'a1', toolName: 'Bash', level: 2, certain: true };
const risky = { id: 'a2', toolName: 'Bash', level: 3, certain: true };

test('A on a normal ask allows when the keyboard has been quiet', () => {
  const r = digestKey(normal, 'a', true, 1000, {});
  assert.deepEqual(r.action, { kind: 'allow', id: 'a1' });
});

test('A when not armed does nothing', () => {
  assert.equal(digestKey(normal, 'a', false, 1000, {}).action, null);
});

test('A on an irreversible ask arms; the second A within 2 s allows', () => {
  const first = digestKey(risky, 'a', true, 1000, {});
  assert.deepEqual(first.action, { kind: 'arm', id: 'a2' });
  const second = digestKey(risky, 'a', true, 2500, first.state);
  assert.deepEqual(second.action, { kind: 'allow', id: 'a2' });
  assert.deepEqual(second.state, {}, 'the arm is used up');
});

test('a second A after 2 s only arms again; another key or another ask clears the arm', () => {
  const first = digestKey(risky, 'a', true, 1000, {});
  assert.deepEqual(digestKey(risky, 'a', true, 3001, first.state).action, { kind: 'arm', id: 'a2' });
  const other = digestKey(risky, 'x', true, 1500, first.state);
  assert.equal(other.action, null);
  assert.deepEqual(digestKey(risky, 'a', true, 1600, other.state).action, { kind: 'arm', id: 'a2' });
  const elsewhere = digestKey({ ...risky, id: 'a3' }, 'a', true, 1600, first.state);
  assert.deepEqual(elsewhere.action, { kind: 'arm', id: 'a3' });
});

test('D denies when the keyboard is quiet, and never on a stray key', () => {
  assert.deepEqual(digestKey(normal, 'd', true, 0, {}).action, { kind: 'deny', id: 'a1' });
  assert.equal(digestKey(normal, 'd', false, 0, {}).action, null);
});

test('A on a click-only card (Blender) never allows or arms', () => {
  const blender = { id: 'b1', toolName: BLENDER_EXEC_TOOL, level: 2, certain: true };
  assert.equal(digestKey(blender, 'a', true, 0, {}).action, null);
});

test('A on an unknown ask never allows or arms (the row offers Open only)', () => {
  assert.equal(digestKey({ id: 'u', toolName: 'Mystery', level: 3, certain: false }, 'a', true, 0, {}).action, null);
});

test('a held key (auto-repeat) never arms and never confirms an irreversible ask', () => {
  const first = digestKey(risky, 'a', true, 1000, {});
  assert.deepEqual(first.action, { kind: 'arm', id: 'a2' });
  const rep = digestKey(risky, 'a', true, 1100, first.state, true);
  assert.equal(rep.action, null, 'a repeat is not the second A');
  assert.deepEqual(rep.state, first.state, 'and it leaves the arm as it was');
  assert.equal(digestKey(risky, 'a', true, 1000, {}, true).action, null, 'a repeat cannot arm either');
  assert.equal(digestKey(normal, 'a', true, 1000, {}, true).action, null, 'nor allow a normal ask');
  assert.equal(digestKey(normal, 'd', true, 1000, {}, true).action, null, 'nor deny');
});
