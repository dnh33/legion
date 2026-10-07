/** Rotation and Clear-logs (plan-logging.md): a log cannot fill a disk, and the folder can be deleted while the writer is up. */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { LogSink, ROTATE_BYTES, LOG_FILES } from '../src/core/log/logger.js';
import { tempDir } from './tmp-cleanup.js';

describe('rotation', () => {
  it('30 MB written leaves at most 4 files per log, each under the cap', () => {
    const dir = tempDir('legion-log-');
    const sink = new LogSink({ dir });
    const log = sink.logger('agents');
    const filler = 'x'.repeat(1990);
    const fields = { f1: filler, f2: filler, f3: filler, f4: filler, f5: filler, f6: filler, f7: filler, f8: filler, f9: filler, f10: filler };
    for (let i = 0; i < 2_000; i++) { // about 40 MB into each of legion.log, errors.log and agents.log
      log.warn('fill', { i, ...fields });
      if (i % 200 === 199) sink.flushSync();
    }
    sink.flushSync(); sink.closeAll();
    const names = readdirSync(dir);
    for (const base of LOG_FILES) {
      const mine = names.filter((n) => n === base || new RegExp(`^${base.replace('.', '\\.')}\\.[1-3]$`).test(n));
      assert.ok(mine.length <= 4, `${base}: ${mine.length} files`);
    }
    assert.equal(names.filter((n) => n.startsWith('legion.log')).length, 4, 'rotation actually happened');
    assert.equal(names.some((n) => /\.[4-9]$/.test(n)), false);
    for (const n of names) assert.ok(statSync(join(dir, n)).size <= ROTATE_BYTES, `${n} over the cap`);
    assert.match(readFileSync(join(dir, 'legion.log'), 'utf8'), /i=1999 /, 'the newest data is in the live file');
  });
  it('a small cap rotates and keeps the configured number of old files', () => {
    const dir = tempDir('legion-log-');
    const sink = new LogSink({ dir, rotateBytes: 400, rotateKeep: 2 });
    for (let i = 0; i < 40; i++) sink.logger('core').info('e', { i });
    sink.flushSync(); sink.closeAll();
    const names = readdirSync(dir).filter((n) => n.startsWith('legion.log')).sort();
    assert.deepEqual(names, ['legion.log', 'legion.log.1', 'legion.log.2']);
  });
});

describe('closeAll / reopen (Clear logs)', () => {
  it('closes every handle, lets the folder be deleted, then reopens and writes again', () => {
    const dir = tempDir('legion-log-');
    const sink = new LogSink({ dir });
    sink.logger('agents').error('before');
    sink.flushSync();
    assert.ok(sink.openHandles >= 3, 'files are open while the writer is up');
    sink.closeAll();
    assert.equal(sink.openHandles, 0);
    rmSync(dir, { recursive: true });
    assert.equal(existsSync(dir), false);
    sink.logger('agents').error('queued.while.closed');
    sink.flushSync(); // closed: writes nothing
    assert.equal(existsSync(dir), false);
    sink.reopen();
    sink.logger('agents').error('after');
    sink.flushSync(); sink.closeAll();
    const text = readFileSync(join(dir, 'legion.log'), 'utf8');
    assert.match(text, /after/);
    assert.match(text, /queued\.while\.closed/);
    assert.equal(text.includes('before'), false);
  });
  it('never throws into the caller when the folder is deleted under an open writer', () => {
    const dir = tempDir('legion-log-');
    const sink = new LogSink({ dir });
    sink.logger('core').error('one'); sink.flushSync();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may refuse: that is the trap */ }
    sink.logger('core').error('two'); sink.flushSync();
    sink.closeAll();
    if (existsSync(join(dir, 'legion.log'))) assert.match(readFileSync(join(dir, 'legion.log'), 'utf8'), /two/);
  });
});
