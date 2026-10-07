/** The logger (plan-logging.md, PR 1): masking, routing, short hash, the bounded queue. */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { LogSink, formatLine, routeFor, shortHash, MAX_FIELD_CHARS } from '../src/core/log/logger.js';
import { tempDir } from './tmp-cleanup.js';

// Built at runtime so the public export's secret scan does not see key-shaped literals in this file.
const GHP = 'gh' + 'p_' + 'a'.repeat(36);
const PAT = 'github' + '_pat_' + '11ABCDEFG0123456789abc' + '_' + 'x'.repeat(59);
const BEARER = 'abcdefghij1234'.repeat(3);
const read = (dir: string, f: string): string => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');

describe('logger: masking', () => {
  it('masks a token-shaped value in a field and in a message field, in every file', () => {
    const dir = tempDir('legion-log-');
    const sink = new LogSink({ dir });
    const log = sink.logger('agents');
    log.error('run.failed', { agent: 'scout', message: `boom ${GHP} end`, detail: `Bearer ${BEARER}`, pat: PAT });
    sink.flushSync();
    sink.closeAll();
    for (const f of ['legion.log', 'errors.log', 'agents.log']) {
      const text = read(dir, f);
      assert.match(text, /run\.failed/, f);
      assert.equal(text.includes(GHP), false, `${f} leaked ghp`);
      assert.equal(text.includes(PAT), false, `${f} leaked pat`);
      assert.equal(text.includes(BEARER), false, `${f} leaked bearer`);
    }
  });
  it('masks a bare 64-hex string but keeps the 12-hex short hash', () => {
    const dir = tempDir('legion-log-');
    const sink = new LogSink({ dir });
    const txid = 'ab12'.repeat(16);
    sink.logger('app').info('tx.seen', { full: txid, short: shortHash(txid) });
    sink.flushSync(); sink.closeAll();
    const text = read(dir, 'legion.log');
    assert.equal(text.includes(txid), false);
    assert.match(text, /short="ab12ab12ab12"/);
  });
  it('a field cannot forge a second line, strings are capped, objects are not serialised', () => {
    const line = formatLine(new Date(0), 'info', 'app', 'x', { a: 'one\n2000-01-01 ERROR forged', b: 'z'.repeat(5000), c: { secret: 1 }, d: null, e: 7, f: true });
    assert.equal(line.includes('\n'), false);
    assert.ok(line.length < MAX_FIELD_CHARS + 300);
    assert.match(line, /c="\[unserialised\]"/);
    assert.match(line, /d="\[unserialised\]"/);
    assert.match(line, / e=7 f=true$/);
  });
});

describe('logger: routing and short hash', () => {
  it('sends WARN+ to errors.log and routes by component', () => {
    const dir = tempDir('legion-log-');
    const sink = new LogSink({ dir });
    sink.logger('agents').info('run.finished', { ms: 1 });
    sink.logger('agents').warn('provider.error', { status: 429 });
    sink.logger('updater').info('update.checked');
    sink.logger('core').error('core.crash');
    sink.logger('core').debug('hidden'); // below the default level
    sink.flushSync(); sink.closeAll();
    const legion = read(dir, 'legion.log');
    assert.match(legion, /run\.finished[\s\S]*provider\.error[\s\S]*update\.checked[\s\S]*core\.crash/);
    assert.equal(legion.includes('hidden'), false);
    const err = read(dir, 'errors.log');
    assert.match(err, /provider\.error/);
    assert.match(err, /core\.crash/);
    assert.equal(/run\.finished|update\.checked/.test(err), false);
    const agents = read(dir, 'agents.log');
    assert.match(agents, /run\.finished/);
    assert.match(agents, /provider\.error/);
    assert.equal(/update\.checked|core\.crash/.test(agents), false);
    const app = read(dir, 'app.log');
    assert.match(app, /update\.checked/);
    assert.equal(/run\.finished|core\.crash/.test(app), false);
  });
  it('debug goes to legion.log only; app components add app.log', () => {
    assert.deepEqual(routeFor('debug', 'agents'), ['legion.log']);
    assert.deepEqual(routeFor('error', 'blender'), ['legion.log', 'errors.log', 'app.log']);
  });
  it('shortHash gives 12 hex: a prefix of a hex id, a digest of anything else', () => {
    assert.equal(shortHash('DEADBEEF0123456789abcdef'), 'deadbeef0123');
    assert.match(shortHash('not hex at all'), /^[0-9a-f]{12}$/);
    assert.equal(shortHash('x'), shortHash('x'));
    assert.notEqual(shortHash('x'), shortHash('y'));
  });
});

describe('logger: bounded queue', () => {
  it('returns at once with a stalled writer, and overflow drops DEBUG and INFO before WARN+', () => {
    const dir = tempDir('legion-log-');
    const sink = new LogSink({ dir, level: 'debug', schedule: () => { /* the writer never runs */ } });
    const log = sink.logger('core');
    const t0 = Date.now();
    for (let i = 0; i < 20_000; i++) log.debug('d', { i });
    for (let i = 0; i < 10_000; i++) log.info('i', { i });
    for (let i = 0; i < 20_000; i++) log.error('e', { i }); // 50,000 lines in all
    const ms = Date.now() - t0;
    assert.ok(ms < 3000, `50,000 enqueues took ${ms} ms`);
    assert.equal(sink.queued, 10_000);
    sink.flushSync(); sink.closeAll();
    const legion = read(dir, 'legion.log');
    const lines = legion.split('\n');
    assert.equal(lines.filter((l) => / ERROR /.test(l)).length, 10_000, 'the newest 10,000 ERROR lines survive');
    assert.equal(/ DEBUG /.test(legion), false);
    assert.equal(/ INFO {2}core i /.test(legion), false);
    const dropped = lines.filter((l) => l.includes('log.dropped'));
    assert.equal(dropped.length, 1, 'one log.dropped line');
    assert.match(dropped[0], /count=40000/);
  });
  it('evicts DEBUG before INFO when a WARN+ line needs room', () => {
    const dir = tempDir('legion-log-');
    const sink = new LogSink({ dir, level: 'debug', queueMax: 4, schedule: () => { /* stalled */ } });
    const log = sink.logger('c');
    log.info('keep.a'); log.info('keep.b'); log.debug('gone.a'); log.debug('gone.b');
    log.error('err.a'); log.error('err.b');
    sink.flushSync(); sink.closeAll();
    const text = read(dir, 'legion.log');
    for (const k of ['keep.a', 'keep.b', 'err.a', 'err.b']) assert.match(text, new RegExp(k.replace('.', '\\.')));
    assert.equal(/gone/.test(text), false);
    assert.match(text, /count=2/);
  });
  it('a low-priority line is dropped, not queued, when the queue is full of WARN+', () => {
    const dir = tempDir('legion-log-');
    const sink = new LogSink({ dir, queueMax: 5, schedule: () => { /* stalled */ } });
    for (let i = 0; i < 5; i++) sink.logger('c').warn('w', { i });
    sink.logger('c').info('late');
    assert.equal(sink.queued, 5);
    sink.flushSync(); sink.closeAll();
    const text = read(dir, 'legion.log');
    assert.equal(text.includes('late'), false);
    assert.match(text, /count=1/);
  });
  it('writes asynchronously: nothing on disk until the writer runs, then drained() resolves', async () => {
    const dir = tempDir('legion-log-');
    const sink = new LogSink({ dir });
    sink.logger('app').info('a.b');
    assert.equal(read(dir, 'legion.log'), '');
    await sink.drained();
    assert.match(read(dir, 'legion.log'), /a\.b/);
    sink.closeAll();
  });
});
