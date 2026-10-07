/** Stream wrappers (plan-logging.md): every chunk is redacted before it reaches stdout or stderr. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installStreamWrappers } from '../src/core/log/stream-wrap.js';

// Built at runtime so the public export's secret scan does not see key-shaped literals in this file.
const GHP = 'gh' + 'p_' + 'b'.repeat(36);

type W = (c: unknown, e?: unknown, cb?: unknown) => boolean;
function fake(): { chunks: string[]; cbs: number; write: W } {
  const s = { chunks: [] as string[], cbs: 0, write: (() => true) as W };
  s.write = (c, _e, cb) => {
    s.chunks.push(typeof c === 'string' ? c : Buffer.from(c as Uint8Array).toString('utf8'));
    const f = [_e, cb].find((x) => typeof x === 'function') as (() => void) | undefined;
    if (f) { s.cbs++; f(); }
    return true;
  };
  return s;
}

describe('installStreamWrappers', () => {
  it('masks a token in string and byte chunks on both streams, and still calls the callback', async () => {
    const out = fake();
    const err = fake();
    const restore = installStreamWrappers([out as never, err as never]);
    out.write(`token ${GHP}\n`);
    let called = 0;
    err.write(Buffer.from(`crash ${GHP}`), undefined, () => { called++; });
    out.write(Buffer.from(`x ${GHP}`), 'utf8');
    restore();
    await new Promise((r) => setImmediate(r));
    for (const c of [...out.chunks, ...err.chunks]) assert.equal(c.includes(GHP), false, c);
    assert.equal(out.chunks.length, 2);
    assert.equal(err.chunks.length, 1);
    assert.equal(called, 1);
    assert.match(out.chunks[0], /^token /);
  });
  it('is idempotent per stream and restore puts the original back', () => {
    const s = fake();
    const original = s.write;
    const r1 = installStreamWrappers([s as never]);
    const wrapped = s.write;
    const r2 = installStreamWrappers([s as never]);
    assert.equal(s.write, wrapped, 'second install does not wrap again');
    r2(); r1();
    assert.equal(s.write, original);
  });
});
