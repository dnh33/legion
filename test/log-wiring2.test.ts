/** Logging wired in, review round: cap cut, early errors, end(), key blocks, encodings, Clear, core.log rotation. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { LogSink } from '../src/core/log/logger.js';
import { rotateRawLog } from '../src/core/log/rotate-file.js';
import { installStreamWrappers } from '../src/core/log/stream-wrap.js';
import { tempDir } from './tmp-cleanup.js';

// Built at runtime so the public export's secret scan does not see key-shaped literals in this file.
const GHP = 'gh' + 'p_' + 'c'.repeat(36);
const GHP2 = 'gh' + 'p_' + 'd'.repeat(36);
const src = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

type W = (c: unknown, e?: unknown, cb?: unknown) => boolean;
function fake(): { chunks: string[]; write: W } {
  const s = { chunks: [] as string[], write: (() => true) as W };
  s.write = (c, e, cb) => {
    s.chunks.push(typeof c === 'string' ? c : Buffer.from(c as Uint8Array).toString('utf8'));
    const f = [e, cb].find((x) => typeof x === 'function') as (() => void) | undefined;
    f?.();
    return true;
  };
  return s;
}

test('a single line over the cap is redacted before it is cut: the reviewer probe gives no piece of the token', () => {
  const out = fake();
  const restore = installStreamWrappers([out as never], { flushMs: 60_000, onExit: false });
  out.write('a'.repeat(7999) + ' ' + GHP + ' ' + 'b'.repeat(235));
  restore();
  const text = out.chunks.join('');
  assert.equal(text.includes('gh' + 'p_'), false);
  assert.equal(text.includes('c'.repeat(8)), false);
  assert.match(text, /\[redacted-token\]/);
  assert.ok(text.length > 8000, 'the rest of the line is still written');
});

test('end(chunk) is redacted too, and flushes the tail', () => {
  const out = fake() as ReturnType<typeof fake> & { end: (c?: unknown) => void; ended: number };
  out.ended = 0;
  out.end = () => { out.ended++; };
  const restore = installStreamWrappers([out as never], { flushMs: 60_000, onExit: false });
  out.write('held ' + GHP2 + ' ');
  out.end('last ' + GHP);
  assert.equal(out.ended, 1);
  assert.equal(out.chunks.join('').includes('gh' + 'p_'), false);
  assert.match(out.chunks.join(''), /last \[redacted-token\]/);
  restore();
});

test('a private key split across two writes at a newline is masked as a whole block', async () => {
  const out = fake();
  const restore = installStreamWrappers([out as never], { flushMs: 5, onExit: false });
  const begin = '-----BEGIN ' + 'PRIVATE KEY-----';
  const end = '-----END ' + 'PRIVATE KEY-----';
  out.write(`before\n${begin}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n`);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(out.chunks.join('').includes('MIIEvQ'), false, 'the open block is held, not written');
  out.write(`KcwggSjAgEAAoIBAQC7\n${end}\nafter\n`);
  restore();
  const text = out.chunks.join('');
  assert.equal(text.includes('MIIEvQ') || text.includes('KcwggSj'), false);
  assert.match(text, /before\n/);
  assert.match(text, /after\n/);
});

test('a string written with the hex encoding is decoded before it is redacted', () => {
  const out = fake();
  const restore = installStreamWrappers([out as never], { flushMs: 60_000, onExit: false });
  out.write(Buffer.from(`x ${GHP}\n`).toString('hex'), 'hex');
  restore();
  assert.match(out.chunks.join(''), /^x \[redacted-token\]\n$/);
});

const installUrl = 'file:///' + fileURLToPath(new URL('../src/core/log/install.js', import.meta.url)).replace(/\\/g, '/');
for (const [name, body] of [
  ['an early throw', "setTimeout(() => { throw new Error('boom ' + process.argv[1]); }, 0);"],
  ['an early rejection', "Promise.reject(new Error('boom ' + process.argv[1]));"],
] as const) {
  test(`${name} that carries a token is printed masked and exits 1`, () => {
    const code = `import(${JSON.stringify(installUrl)}).then(() => { ${body} });`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, GHP], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 1, r.stderr);
    assert.equal((r.stderr + r.stdout).includes('gh' + 'p_'), false, r.stderr);
    assert.match(r.stderr, /process\.(uncaughtException|unhandledRejection) .*boom \[redacted-token\]/);
  });
}

test('Clear logs drops lines queued before the clear', () => {
  const dir = tempDir('legion-log-');
  const sink = new LogSink({ dir, schedule: () => { /* stalled */ } });
  sink.logger('c').error('queued.before.clear');
  sink.closeAll();
  sink.clearQueue();
  sink.reopen();
  sink.logger('c').error('after.clear');
  sink.flushSync(); sink.closeAll();
  const text = readFileSync(join(dir, 'legion.log'), 'utf8');
  assert.match(text, /after\.clear/);
  assert.equal(text.includes('queued.before.clear'), false);
});

test('core.log rotation: rename only, over the cap; a failed rename keeps the file and the old copy', () => {
  const dir = tempDir('legion-log-');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'core.log');
  writeFileSync(f, 'x'.repeat(100));
  writeFileSync(f + '.1', 'older');
  assert.equal(rotateRawLog(f, { cap: 1000 }), false, 'under the cap: untouched');
  assert.equal(readFileSync(f, 'utf8').length, 100);
  assert.equal(rotateRawLog(f, { cap: 50, rename: () => { throw new Error('EBUSY'); } }), false);
  assert.equal(readFileSync(f, 'utf8').length, 100, 'nothing lost on a failed rename');
  assert.equal(readFileSync(f + '.1', 'utf8'), 'older');
  assert.equal(rotateRawLog(f, { cap: 50 }), true);
  assert.equal(existsSync(f), false);
  assert.equal(readFileSync(f + '.1', 'utf8').length, 100, 'the old .1 was replaced by the rename');
  assert.match(src('src/electron/main.ts'), /rotateRawLog\(join\(dataDir\(\), 'core\.log'\)\);[^\n]*\n\s*try \{ out = openSync\(join\(dataDir\(\), 'core\.log'\)/);
  assert.equal(/unlink|rmSync|rmdir/.test(src('src/core/log/rotate-file.ts').replace(/\/\*[\s\S]*?\*\//g, '')), false, 'nothing is deleted');
});

test('legion-core.ts registers no late fatal handlers and its log() no longer writes to stderr', () => {
  const core = src('src/bin/legion-core.ts');
  assert.equal(/process\.on\('(uncaughtException|unhandledRejection)'/.test(core), false);
  assert.match(src('src/core/log/install.ts'), /process\.on\('uncaughtException'/);
  assert.match(src('src/core/log/install.ts'), /process\.on\('unhandledRejection'/);
  const logFn = /const log = \(\.\.\.a: unknown\[\]\) => \{[\s\S]*?\n\};/.exec(core)?.[0] ?? '';
  assert.ok(logFn.length > 0);
  assert.equal(/stderr/.test(logFn), false);
});
