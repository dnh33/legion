import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlights } from '../ui/src/projects/board/loadFlight.js';

/** A run the test steps by hand: each call waits for `release`. Data is the call number, so a stale read shows. */
function harness() {
  const calls: Array<{ key: string; release: (fail?: Error) => void }> = [];
  const told: unknown[] = [];
  const flights = createFlights(
    (key) => new Promise<void>((resolve, reject) => { calls.push({ key, release: (fail) => (fail ? reject(fail) : resolve()) }); }),
    (e) => told.push(e),
  );
  return { calls, told, flights };
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test('a request made while a load is in flight is answered by a SECOND load that starts after the first ends', async () => {
  const h = harness();
  const first = h.flights.load('p1');
  const second = h.flights.load('p1'); // arrives mid-flight: it must not be served by the load already running
  assert.equal(h.calls.length, 1);
  let secondDone = false; void second.then(() => { secondDone = true; });
  h.calls[0]!.release(); await tick();
  assert.equal((await first).ok, true);
  assert.equal(h.calls.length, 2, 'exactly one more load starts when the first ends');
  assert.equal(secondDone, false, 'the late request waits for the second load, not the first');
  h.calls[1]!.release();
  assert.deepEqual(await second, { ok: true, told: false });
});

test('many requests during one flight share exactly one trailing load', async () => {
  const h = harness();
  const a = h.flights.load('p1');
  const b = h.flights.load('p1'), c = h.flights.load('p1'), d = h.flights.load('p1');
  h.calls[0]!.release(); await a; await tick();
  assert.equal(h.calls.length, 2);
  h.calls[1]!.release();
  await Promise.all([b, c, d]);
  await tick();
  assert.equal(h.calls.length, 2, 'no third load');
});

test('with nothing in flight a request starts a load at once; other keys do not wait for each other', async () => {
  const h = harness();
  void h.flights.load('p1'); void h.flights.load('p2');
  assert.deepEqual(h.calls.map((c) => c.key), ['p1', 'p2']);
});

test('after a flight ends a new request starts a fresh load (no trailing leftovers)', async () => {
  const h = harness();
  const a = h.flights.load('p1'); h.calls[0]!.release(); await a;
  void h.flights.load('p1');
  assert.equal(h.calls.length, 2);
});

test('a failed flight tells ONCE when any caller was loud, and the result says it was told', async () => {
  const h = harness();
  const quiet = h.flights.load('p1', { quiet: true });
  const loud = h.flights.load('p1'); // a non-quiet joiner makes the NEXT flight loud, this one stays quiet
  h.calls[0]!.release(new Error('boom')); await tick();
  assert.deepEqual(await quiet, { ok: false, told: false });
  h.calls[1]!.release(new Error('boom2'));
  assert.deepEqual(await loud, { ok: false, told: true });
  assert.equal(h.told.length, 1);
});

test('several loud callers sharing one failed flight make ONE toast, and a quiet caller sharing it does not silence it', async () => {
  const h = harness();
  const first = h.flights.load('p1', { quiet: true });
  const loudA = h.flights.load('p1'), quietB = h.flights.load('p1', { quiet: true }), loudC = h.flights.load('p1');
  h.calls[0]!.release(); await first; await tick();
  h.calls[1]!.release(new Error('boom'));
  const rs = await Promise.all([loudA, quietB, loudC]);
  assert.deepEqual(rs.map((r) => r.told), [true, true, true], 'one flight, one toast, all callers told it was shown');
  assert.equal(h.told.length, 1);
});

test('a quiet failed flight tells nobody and says so (the caller owns the message)', async () => {
  const h = harness();
  const q = h.flights.load('p1', { quiet: true });
  h.calls[0]!.release(new Error('x'));
  assert.deepEqual(await q, { ok: false, told: false });
  assert.equal(h.told.length, 0);
});
