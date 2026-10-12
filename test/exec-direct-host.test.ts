import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectHostBackend } from '../src/core/exec/direct-host.js';
import { validateEnv } from '../src/core/exec/types.js';

const backend = new DirectHostBackend();

test('execute runs a command and returns its output and exit 0', async () => {
  const r = await backend.execute({ cmd: 'echo hello-host' });
  assert.equal(r.exit_code, 0);
  assert.match(r.output, /hello-host/);
  assert.equal(r.timedOut, undefined);
});

test('execute reports a non-zero exit code, never faking 0', async () => {
  const r = await backend.execute({ cmd: 'node -e "process.exit(3)"' });
  assert.equal(r.exit_code, 3);
});

test('a timeout group-kills the command and reports exit 124 + timedOut', async () => {
  const r = await backend.execute({ cmd: 'node -e "setTimeout(function(){}, 10000)"', timeoutMs: 200 });
  assert.equal(r.exit_code, 124);
  assert.equal(r.timedOut, true);
});

test('a missing cwd throws rather than running somewhere else', async () => {
  await assert.rejects(
    () => backend.execute({ cmd: 'echo nope', cwd: 'X:/definitely/not/a/real/dir-xyz' }),
    /ENOENT|not a directory|Failed to start|cwd|no such/i,
  );
});

test('cancel kills the run and reports 130', async () => {
  const ac = new AbortController();
  const p = backend.execute({ cmd: 'node -e "setTimeout(function(){}, 10000)"', signal: ac.signal });
  setTimeout(() => ac.abort(), 150);
  const r = await p;
  assert.equal(r.exit_code, 130);
});

test('validateEnv rejects a bad key, a NUL value and an oversized entry', () => {
  assert.throws(() => validateEnv({ 'BAD-KEY': 'x' }), /Invalid environment key/);
  assert.throws(() => validateEnv({ GOOD_KEY: 'a\0b' }), /NUL/);
  assert.throws(() => validateEnv({ K: 'x'.repeat(40_000) }), /too long/);
  assert.deepEqual(validateEnv({ OK_KEY: 'v' }), { OK_KEY: 'v' });
});

test('the backend declares its capabilities', () => {
  const c = backend.capabilities();
  assert.equal(c.shell, true);
  assert.equal(c.remote, false);
  assert.equal(backend.name, 'direct-host');
});
