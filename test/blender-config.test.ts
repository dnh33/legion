import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultBlenderConfig, normalizeBlender, isLoopbackHost, DEFAULT_ADVANCED, OFFICIAL_MIN_VERSION } from '../src/shared/blender.js';
import { defaultConfig, loadConfig } from '../src/shared/config.js';

test('defaults: off, auto backend, loopback, auto sandbox', () => {
  const d = defaultBlenderConfig();
  assert.equal(d.enabled, false);
  assert.equal(d.backend, 'auto');
  assert.equal(d.host, '127.0.0.1');
  assert.equal(d.sandbox, 'auto');
  assert.equal(d.port, 9876);
  assert.equal(d.entry, undefined);
  assert.equal(OFFICIAL_MIN_VERSION, '5.1.0');
  assert.equal(defaultConfig().blender.enabled, false);
});

test('normalizeBlender never throws and falls back to defaults', () => {
  for (const junk of [undefined, null, 5, 'x', [], { enabled: 'yes', backend: 'nope', port: 'x', sandbox: 7, advanced: 4 }]) {
    const c = normalizeBlender(junk);
    assert.equal(c.enabled, false);
    assert.equal(c.backend, 'auto');
    assert.equal(c.sandbox, 'auto');
    assert.equal(c.port, 9876);
    assert.deepEqual(c.advanced, DEFAULT_ADVANCED);
  }
});

test('the host is loopback only: a script is never sent to another machine', () => {
  assert.equal(normalizeBlender({ host: '10.0.0.5' }).host, '127.0.0.1');
  assert.equal(normalizeBlender({ host: 'evil.example.com' }).host, '127.0.0.1');
  assert.equal(normalizeBlender({ host: 'localhost' }).host, 'localhost');
  assert.equal(normalizeBlender({ host: '::1' }).host, '::1');
  assert.ok(isLoopbackHost('127.0.0.1') && !isLoopbackHost('0.0.0.0') && !isLoopbackHost('127.0.0.1.evil.com'));
});

test('ports, sandbox and backend values are validated', () => {
  assert.equal(normalizeBlender({ port: 80 }).port, 9876);
  assert.equal(normalizeBlender({ port: 70000 }).port, 9876);
  assert.equal(normalizeBlender({ port: 1.5 }).port, 9876);
  assert.equal(normalizeBlender({ port: 9999 }).port, 9999);
  for (const s of ['off', 'vm', 'auto'] as const) assert.equal(normalizeBlender({ sandbox: s }).sandbox, s);
  for (const b of ['auto', 'official', 'community'] as const) assert.equal(normalizeBlender({ backend: b }).backend, b);
  assert.equal(normalizeBlender({ enabled: true }).enabled, true);
  assert.equal(normalizeBlender({ enabled: 1 }).enabled, false);
});

test('download URLs must be https; hashes must be 64 hex characters', () => {
  const c = normalizeBlender({ advanced: { official: { sourceUrl: 'http://x.test/a.zip', sha256: 'abc' }, community: { addonUrl: 'file:///etc/passwd', sha256: 'A'.repeat(64) }, vm: { blenderUrl: 'ftp://x/y' } } });
  assert.equal(c.advanced.official.sourceUrl, DEFAULT_ADVANCED.official.sourceUrl);
  assert.equal(c.advanced.official.sha256, DEFAULT_ADVANCED.official.sha256, 'a malformed hash keeps the default pin');
  assert.equal(normalizeBlender({ advanced: { official: { sha256: '' } } }).advanced.official.sha256, '', 'an explicitly empty hash means no pin');
  assert.equal(c.advanced.community.addonUrl, DEFAULT_ADVANCED.community.addonUrl);
  assert.equal(c.advanced.community.sha256, 'a'.repeat(64));
  assert.equal(c.advanced.vm.blenderUrl, DEFAULT_ADVANCED.vm.blenderUrl);
  assert.equal(normalizeBlender({ advanced: { official: { sourceUrl: 'https://mirror.example/x.zip' } } }).advanced.official.sourceUrl, 'https://mirror.example/x.zip');
});

test('assumption fields are config: tool names, commands, args, timeouts', () => {
  const c = normalizeBlender({ advanced: {
    official: { command: 'node', args: ['a.js', '--port', '{port}'], env: { X: '1', 'bad key': '2' }, tools: { exec: 'run_py', execArg: 'src', inspect: 'bad name!', screenshot: 'shot', docs: 'docs' } },
    community: { commands: { exec: 'run', inspect: 'scene' } },
    vm: { timeoutSeconds: 99999, runCommand: '{blender} -b -P {runner}' },
  } });
  assert.equal(c.advanced.official.command, 'node');
  assert.deepEqual(c.advanced.official.args, ['a.js', '--port', '{port}']);
  assert.deepEqual(c.advanced.official.env, { X: '1' });
  assert.equal(c.advanced.official.tools.exec, 'run_py');
  assert.equal(c.advanced.official.tools.execArg, 'src');
  assert.equal(c.advanced.official.tools.inspect, DEFAULT_ADVANCED.official.tools.inspect, 'a bad name falls back');
  assert.equal(c.advanced.community.commands.exec, 'run');
  assert.equal(c.advanced.community.commands.inspect, 'scene');
  assert.equal(c.advanced.community.commands.screenshot, DEFAULT_ADVANCED.community.commands.screenshot);
  assert.equal(c.advanced.vm.timeoutSeconds, 900);
  assert.equal(c.advanced.vm.runCommand, '{blender} -b -P {runner}');
});

test('entry: kept when well formed, dropped otherwise', () => {
  const ok = normalizeBlender({ entry: { command: 'uv', args: ['run'], env: { A: 'b' }, serverDir: '/x', at: '2026-10-02T00:00:00Z' } });
  assert.equal(ok.entry?.command, 'uv');
  assert.deepEqual(ok.entry?.args, ['run']);
  assert.equal(normalizeBlender({ entry: { command: '' } }).entry, undefined);
  assert.equal(normalizeBlender({ entry: 'uv' }).entry, undefined);
});

test('loadConfig fills the blender section and keeps user edits', () => {
  const home = mkdtempSync(join(tmpdir(), 'legion-bl-cfg-'));
  const prev = process.env.LEGION_HOME;
  process.env.LEGION_HOME = home;
  try {
    const fresh = loadConfig();
    assert.equal(fresh.blender.enabled, false);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ ...fresh, blender: { enabled: true, sandbox: 'vm', host: '8.8.8.8' } }));
    const again = loadConfig();
    assert.equal(again.blender.enabled, true);
    assert.equal(again.blender.sandbox, 'vm');
    assert.equal(again.blender.host, '127.0.0.1');
    assert.equal(again.blender.advanced.official.command, DEFAULT_ADVANCED.official.command);
  } finally { if (prev === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = prev; }
});
