/** The local embedder's helper process, with a FAKE worker script: spawn, answer, idle exit, restart, failure, and killing only its own child. */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FINDER_MODEL_PIN } from '../src/shared/finder.js';
import { tempDir } from './tmp-cleanup.js';
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

  it('the helper gets a minimal environment, no inherited node options, and the pin in its arguments', async () => {
    process.env.LEGION_TEST_SECRET = 'do-not-pass-me';
    try {
      const files = [{ name: 'a.bin', bytes: 3, sha256: 'ab'.repeat(32) }];
      const m = createLocalModel({ modelDir: '/models/x', id: 'fake', workerPath: FAKE, files });
      made.push(m);
      const seen = await m.embed(['env'], sig()).then(() => '', (e: Error) => e.message);
      assert.ok(seen.startsWith('ENV:'), seen);
      const got = JSON.parse(seen.slice(4)) as { env: string[]; execArgv: string[]; argv: string[] };
      const names = got.env.map((n) => n.toLowerCase()).sort();
      assert.ok(!names.includes('legion_test_secret'), 'your variables are not passed on');
      assert.ok(names.includes('electron_run_as_node') && names.includes('path'), names.join(','));
      // Windows adds its own session defaults (home, user name, windir...) to any new process; none of them is yours to pass on.
      const allowed = new Set(['path', 'systemroot', 'temp', 'tmp', 'electron_run_as_node', 'homedrive', 'homepath', 'logonserver', 'systemdrive', 'userdomain', 'username', 'userprofile', 'windir']);
      assert.deepEqual(names.filter((n) => !allowed.has(n)), [], 'only the allowed names and the Windows session defaults');
      assert.deepEqual(got.execArgv, []);
      assert.equal(got.argv[0], '/models/x');
      assert.deepEqual(JSON.parse(got.argv[1]!), files);
    } finally { delete process.env.LEGION_TEST_SECRET; }
  });

  it('a helper that reports a failed integrity check fails the request, calls onIntegrity once, and the embedder stays off', async () => {
    const why: string[] = [];
    const m = createLocalModel({ modelDir: '/models/x', id: 'fake', workerPath: FAKE, files: [{ name: 'tamper', bytes: 1, sha256: 'a'.repeat(64) }], onIntegrity: (w) => why.push(w) });
    made.push(m);
    await assert.rejects(m.embed(['x'], sig()), /does not match its sha256/);
    assert.deepEqual(why, ['tamper does not match its sha256.']);
    await assert.rejects(m.embed(['y'], sig()), /switched off/);
    assert.equal(why.length, 1);
  });

  it('after a load failure that is not an integrity failure, no new helper is forked until the back-off is over', async () => {
    const dir = tempDir('finder-loadfail-');
    mkdirSync(dir, { recursive: true });
    let t = 1_000_000;
    const logs: string[] = [];
    const m = createLocalModel({ modelDir: dir, id: 'fake', workerPath: FAKE, files: [{ name: 'loadfail', bytes: 1, sha256: 'a'.repeat(64) }], backoffMs: 300_000, now: () => t, log: (l) => logs.push(l) });
    made.push(m);
    const spawns = (): number => (existsSync(join(dir, 'spawns.log')) ? readFileSync(join(dir, 'spawns.log'), 'utf8').split('\n').filter(Boolean).length : 0);
    await assert.rejects(m.embed(['x'], sig()), /out of memory/);
    assert.equal(spawns(), 1);
    for (let i = 0; i < 5; i++) await assert.rejects(m.embed(['y'], sig()), /not tried again yet/);
    assert.equal(spawns(), 1, 'five calls inside the back-off forked nothing');
    assert.equal(logs.length, 1, 'one log line');
    t += 300_001;
    await assert.rejects(m.embed(['z'], sig()), /out of memory/);
    assert.equal(spawns(), 2, 'after the back-off one new helper is tried');
  });

  it('a worker script that does not exist fails the request, not the caller', async () => {
    const m = createLocalModel({ modelDir: '/m', id: 'x', workerPath: fileURLToPath(new URL('./no-such-worker.js', import.meta.url)) });
    made.push(m);
    await assert.rejects(m.embed(['x'], sig()), /stopped|could not start/);
  });
});


describe('the real helper script checks every pinned file before it loads anything', () => {
  const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
  /** A folder with all seven pinned names and small contents, and a pin that matches them. No model is needed: the check comes first. */
  function folder(): { dir: string; files: { name: string; bytes: number; sha256: string }[] } {
    const dir = tempDir('finder-real-worker-');
    mkdirSync(dir, { recursive: true });
    const files = FINDER_MODEL_PIN.files.map((f) => {
      const body = Buffer.from('content of ' + f.name);
      writeFileSync(join(dir, f.name), body);
      return { name: f.name, bytes: body.length, sha256: sha(body) };
    });
    return { dir, files };
  }
  const run = async (dir: string, files: { name: string; bytes: number; sha256: string }[]): Promise<{ error: string; why: string[] }> => {
    const why: string[] = [];
    const m = createLocalModel({ modelDir: dir, id: 'real', files, timeoutMs: 20_000, onIntegrity: (w) => why.push(w) });
    made.push(m);
    const error = await m.embed(['hello'], sig(), 'query').then(() => '', (e: Error) => e.message);
    return { error, why };
  };

  it('a file with the right size and a wrong hash is refused, and the text names the file', async () => {
    const { dir, files } = folder();
    const name = 'ort-wasm-simd-threaded.mjs';
    const orig = files.find((f) => f.name === name)!;
    writeFileSync(join(dir, name), Buffer.from('X'.repeat(orig.bytes)));
    const r = await run(dir, files);
    assert.match(r.error, /ort-wasm-simd-threaded\.mjs does not match its sha256/);
    assert.equal(r.why.length, 1);
  });

  it('a file with the wrong size, and a missing file, are refused', async () => {
    const a = folder();
    writeFileSync(join(a.dir, 'tokenizer.json'), 'longer than before, by a lot');
    assert.match((await run(a.dir, a.files)).error, /tokenizer\.json has the wrong size/);
    const b = folder();
    rmSync(join(b.dir, 'tokenizer_config.json'));
    assert.match((await run(b.dir, b.files)).error, /tokenizer_config\.json is missing/);
  });

  it('a pin that leaves out a file the worker needs is refused', async () => {
    const { dir, files } = folder();
    const r = await run(dir, files.filter((f) => f.name !== 'tokenizers.min.mjs'));
    assert.match(r.error, /tokenizers\.min\.mjs is not in the pin/);
    assert.equal(r.why.length, 1);
  });

  it('no pin at all is refused', async () => {
    const { dir } = folder();
    const r = await run(dir, []);
    assert.match(r.error, /cannot be checked/);
  });
});
