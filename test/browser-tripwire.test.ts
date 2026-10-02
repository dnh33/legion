/** C18: the browser tool's own rules for where the dangerous capabilities may live. The repo-wide tripwire (bsv-tripwire) still scans these files too. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(fileURLToPath(new URL('../../', import.meta.url)), 'src', 'core', 'browser');
const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => [f, readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')] as const);
const only = (re: RegExp): string[] => files.filter(([, s]) => re.test(s)).map(([f]) => f).sort();

test('C18: WebSocket only in cdp.ts; fetch only in system.ts; DNS only in resolve.ts; no file here spawns a process or opens a socket or listens', () => {
  assert.ok(files.length >= 10);
  assert.deepEqual(only(/\bnew WebSocket\b|\bWebSocket\(/), ['cdp.ts']);
  assert.deepEqual(only(/\bfetch\(/), ['system.ts']);
  assert.deepEqual(only(/node:dns/), ['resolve.ts']);
  assert.deepEqual(only(/node:child_process|\bexecFile?\(|\bexecSync\(|\bspawnSync\(|\bfork\(/), []);
  assert.deepEqual(only(/node:net\b|node:tls|node:dgram|node:http2?\b|node:https\b/), []);
  assert.deepEqual(only(/\.listen\(/), []);
  assert.deepEqual(only(/\.\.\.\s*process\.env|env:\s*process\.env/), [], 'no file hands the whole environment to anything');
  assert.deepEqual(only(/\beval\(|new Function\(/), []);
});

test('C18: the only process this tool starts goes through the shared process port, and CDP is loopback-checked before connecting', () => {
  const sys = files.find(([f]) => f === 'system.ts')![1];
  assert.match(sys, /spawnManaged/);
  const cdp = files.find(([f]) => f === 'cdp.ts')![1];
  assert.ok(cdp.indexOf('isLoopbackWsUrl(url)') > 0 && cdp.indexOf('isLoopbackWsUrl(url)') < cdp.indexOf('new WebSocket'));
});

test('C18: only chromium.ts names a browser debugging switch, only once and only as port 0; no file here binds a host or passes a fixed debugging port', () => {
  assert.deepEqual(only(/remote-debugging/), ['chromium.ts']);
  const chromium = files.find(([f]) => f === 'chromium.ts')![1];
  assert.equal((chromium.match(/remote-debugging/g) ?? []).length, 1);
  assert.match(chromium, /'--remote-debugging-port=0'/);
  assert.deepEqual(only(/--host\b|--bind\b|--remote-debugging-address/), []);
});
