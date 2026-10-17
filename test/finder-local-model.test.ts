/** The local embedder's helper process, with a FAKE worker script: spawn, answer, idle exit, restart, failure, and killing only its own child. */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createLocalModel } from '../src/core/armory/finder/local-model.js';
import type { LocalEmbedder } from '../src/core/armory/finder/local-model.js';

const FAKE = fileURLToPath(new URL('./finder-fake-worker.js', import.meta.url));
const made: LocalEmbedder[] = [];
const mk = (over: { idleMs?: number; timeoutMs?: number } = {}): LocalEmbedder => {
  const m = createLocalModel({ modelDir: '/models/x', id: 'fake', workerPath: FAKE, ...over });
  made.push(m);
  return m;
};
const sig = (): AbortSignal => new AbortController().signal;
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)); }
};

// Whatever a test leaves running is stopped through its own handle, never by image name.
after(() => { for (const m of made) m.dispose(); });

describe('local model helper process', () => {
  it('starts on the first request and answers one Float32Array per text, with the kind passed through', async () => {
    const m = mk();
    assert.equal(m.running(), false, 'nothing runs before a request');
    const q = await m.embed(['hello'], sig(), 'query');
    assert.equal(q.length, 1);
    assert.ok(q[0] instanceof Float32Array);
    assert.equal(q[0]![3], 1, 'the query kind reached the worker');
    const p = await m.embed(['a', 'bb'], sig(), 'passage');
    assert.equal(p.length, 2);
    assert.equal(p[0]![3], 0);
    assert.equal(m.running(), true);
    assert.ok(m.pid() !== undefined && alive(m.pid()!));
  });

  it('answers an empty list without starting anything', async () => {
    const m = mk();
    assert.deepEqual(await m.embed([], sig()), []);
    assert.equal(m.running(), false);
  });

  it('stops after the idle time and starts a new one on the next request', async () => {
    const m = mk({ idleMs: 150 });
    await m.embed(['one'], sig());
    const first = m.pid()!;
    await until(() => !m.running());
    await until(() => !alive(first));
    await m.embed(['two'], sig());
    assert.equal(m.running(), true);
    assert.notEqual(m.pid(), first, 'a new process');
    assert.equal(alive(first), false);
  });

  it('a busy helper is not stopped by the idle timer', async () => {
    const m = mk({ idleMs: 100, timeoutMs: 1500 });
    const slow = m.embed(['hang'], sig());
    slow.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(m.running(), true, 'still waiting for its answer, so not idle');
    await assert.rejects(slow, /too long/);
    assert.equal(m.running(), false, 'a stuck helper is stopped once its request times out');
    assert.equal((await m.embed(['again'], sig())).length, 1, 'and the next request starts a fresh one');
  });

  it('a crash fails the waiting request, and the next request restarts', async () => {
    const m = mk();
    await m.embed(['warm'], sig());
    const first = m.pid()!;
    await assert.rejects(m.embed(['crash'], sig()), /stopped/);
    await until(() => !alive(first));
    const again = await m.embed(['back'], sig());
    assert.equal(again.length, 1);
    assert.notEqual(m.pid(), first);
  });

  it('an error from the worker rejects that request only', async () => {
    const m = mk();
    await assert.rejects(m.embed(['fail'], sig()), /the model said no/);
    assert.equal((await m.embed(['fine'], sig())).length, 1, 'the same process still works');
  });

  it('a request that is not answered in time rejects', async () => {
    const m = mk({ timeoutMs: 200 });
    await assert.rejects(m.embed(['hang'], sig()), /too long/);
  });

  it('an aborted signal rejects at once, and a late answer is ignored', async () => {
    const m = mk();
    const ac = new AbortController();
    const p = m.embed(['hang'], ac.signal);
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, /Cancelled/);
    assert.equal((await m.embed(['ok'], sig())).length, 1);
    await assert.rejects(m.embed(['x'], (() => { const a = new AbortController(); a.abort(); return a.signal; })()), /Cancelled/);
  });

  it('dispose kills the child it started and refuses later requests', async () => {
    const m = mk();
    await m.embed(['x'], sig());
    const pid = m.pid()!;
    m.dispose();
    await until(() => !alive(pid));
    assert.equal(m.running(), false);
    await assert.rejects(m.embed(['y'], sig()), /switched off/);
  });

  it('stop kills the child but a later request starts a new one', async () => {
    const m = mk();
    await m.embed(['x'], sig());
    const pid = m.pid()!;
    m.stop();
    await until(() => !alive(pid));
    assert.equal((await m.embed(['y'], sig())).length, 1);
  });

  it('a worker script that does not exist fails the request, not the caller', async () => {
    const m = createLocalModel({ modelDir: '/m', id: 'x', workerPath: fileURLToPath(new URL('./no-such-worker.js', import.meta.url)) });
    made.push(m);
    await assert.rejects(m.embed(['x'], sig()), /stopped|could not start/);
  });
});
