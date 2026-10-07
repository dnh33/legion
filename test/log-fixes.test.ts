/** Review fixes for the logger (PR #37): leak, failed rotation, file modes, redaction of every line, cap order. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { LogSink, ROTATE_RETRY_MS } from '../src/core/log/logger.js';
import { clearRegisteredSecrets, registerSecret } from '../src/core/log/redact.js';
import { installStreamWrappers } from '../src/core/log/stream-wrap.js';
import { tempDir } from './tmp-cleanup.js';

// Built at runtime so the public export's secret scan does not see key-shaped literals in this file.
const GHP = 'gh' + 'p_' + 'a'.repeat(36);
const read = (dir: string, f: string): string => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');

afterEach(() => clearRegisteredSecrets());

describe('queue memory', () => {
  it('20,000 lines through a draining sink leave the eviction lists small', () => {
    const dir = tempDir('legion-log-');
    const sink = new LogSink({ dir });
    const log = sink.logger('core');
    for (let i = 0; i < 20_000; i++) {
      log.info('i', { i });
      if (i % 500 === 499) sink.flushSync();
    }
    sink.flushSync();
    assert.equal(sink.queued, 0);
    assert.ok(sink.lowListLength < 2500, `list holds ${sink.lowListLength}`);
    sink.closeAll();
  });
});

describe('failed rotation', () => {
  it('loses no backup and does not retry on every line; retries after the back-off', () => {
    const dir = tempDir('legion-log-');
    mkdirSync(dir, { recursive: true });
    for (const n of [1, 2, 3]) writeFileSync(join(dir, `legion.log.${n}`), `backup${n}\n`);
    writeFileSync(join(dir, 'legion.log'), 'x'.repeat(300));
    let clock = 1_000_000;
    let attempts = 0;
    const sink = new LogSink({ dir, rotateBytes: 300, rotateKeep: 3, now: () => new Date(clock), rename: () => { attempts++; throw new Error('EBUSY'); } });
    for (let i = 0; i < 50; i++) sink.logger('core').info('line', { i });
    sink.flushSync();
    assert.equal(attempts, 1, 'one failed attempt, no retry storm');
    for (const n of [1, 2, 3]) assert.equal(read(dir, `legion.log.${n}`), `backup${n}\n`, `backup ${n} intact`);
    clock += ROTATE_RETRY_MS + 1;
    for (let i = 0; i < 5; i++) sink.logger('core').info('line', { i });
    sink.flushSync();
    assert.equal(attempts, 2, 'retried once after the back-off');
    sink.closeAll();
  });
});

describe('file modes', { skip: process.platform === 'win32' }, () => {
  it('creates the folder 0700 and the files 0600', () => {
    const dir = join(tempDir('legion-log-'), 'logs');
    const sink = new LogSink({ dir });
    sink.logger('core').error('x');
    sink.flushSync(); sink.closeAll();
    assert.equal(statSync(dir).mode & 0o077, 0);
    assert.equal(statSync(join(dir, 'legion.log')).mode & 0o077, 0);
  });
});

describe('redaction of every line', () => {
  it('the log.dropped line goes through the redactor too', () => {
    const dir = tempDir('legion-log-');
    registerSecret('log.dropped'); // an exact value that appears in that line only
    const sink = new LogSink({ dir, queueMax: 1, schedule: () => { /* stalled */ } });
    sink.logger('c').warn('a'); sink.logger('c').warn('b');
    sink.flushSync(); sink.closeAll();
    const text = read(dir, 'legion.log');
    assert.equal(text.includes('log.dropped'), false);
    assert.match(text, /\[redacted-secret\]/);
  });
  it('a token that straddles the 2,000-character cap is fully masked', () => {
    const dir = tempDir('legion-log-');
    const sink = new LogSink({ dir });
    sink.logger('c').info('e', { v: 'x'.repeat(1989) + ' ' + GHP });
    sink.flushSync(); sink.closeAll();
    const text = read(dir, 'legion.log');
    assert.equal(text.includes('gh' + 'p_'), false);
    assert.match(text, /\[truncated\]/);
  });
});

describe('stream wrapper encodings', () => {
  it('a Buffer written with an encoding argument is decoded as utf8, not corrupted', () => {
    const got: string[] = [];
    const s = { write: (c: unknown) => { got.push(typeof c === 'string' ? c : Buffer.from(c as Uint8Array).toString('utf8')); return true; } };
    const restore = installStreamWrappers([s as never]);
    (s.write as (c: unknown, e?: unknown) => boolean)(Buffer.from('hello world'), 'hex');
    restore();
    assert.deepEqual(got, ['hello world']);
  });
});

describe('file permissions', () => {
  it('creates the log folder 0700 and the files 0600 on POSIX', { skip: process.platform === 'win32' ? 'POSIX modes only' : false }, () => {
    const dir = join(tempDir('legion-log-mode-'), 'logs');
    const sink = new LogSink({ dir });
    sink.logger('core').warn('mode', { n: 1 });
    sink.flushSync();
    sink.closeAll();
    assert.equal(statSync(dir).mode & 0o777, 0o700, 'folder');
    for (const f of ['legion.log', 'errors.log']) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
  });
});
