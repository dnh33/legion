import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  const home = cleanupTemp('legion-bl-cfg-');
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

test('mode migration: pre-change configs (legacy sandbox key only) derive the mode and write no mode key', async () => {
  const { effectiveMode, modeFromSandbox, mirrorSandbox } = await import('../src/shared/blender.js');
  for (const [legacy, want] of [['auto', 'auto'], ['off', 'live'], ['vm', 'vm']] as const) {
    const c = normalizeBlender({ enabled: true, sandbox: legacy });
    assert.equal(effectiveMode(c), want);
    assert.equal(c.mode, undefined);
    assert.equal(c.sandbox, legacy);
    assert.equal('mode' in c, false);
    assert.equal(modeFromSandbox(legacy), want);
  }
  assert.equal(effectiveMode(normalizeBlender({})), 'auto');
  assert.equal(effectiveMode(normalizeBlender({ sandbox: 'junk' })), 'auto');
  // the legacy `off` is an alias of live, never of local
  assert.notEqual(effectiveMode(normalizeBlender({ sandbox: 'off' })), 'local');
});

test('mode migration: a valid mode wins over the legacy key; an invalid one is ignored; the legacy key mirrors it', async () => {
  const { mirrorSandbox } = await import('../src/shared/blender.js');
  const c = normalizeBlender({ mode: 'local', sandbox: 'vm' });
  assert.equal(c.mode, 'local');
  assert.equal(c.sandbox, 'auto');
  assert.equal(normalizeBlender({ mode: 'live', sandbox: 'auto' }).sandbox, 'off');
  assert.equal(normalizeBlender({ mode: 'vm' }).sandbox, 'vm');
  assert.equal(normalizeBlender({ mode: 'auto' }).sandbox, 'auto');
  const bad = normalizeBlender({ mode: 'off', sandbox: 'vm' });
  assert.equal(bad.mode, undefined);
  assert.equal(bad.sandbox, 'vm');
  assert.equal(normalizeBlender({ mode: 'nope' }).mode, undefined);
  assert.deepEqual((['auto', 'local', 'vm', 'live'] as const).map(mirrorSandbox), ['auto', 'auto', 'vm', 'off']);
});

test('advanced.local: defaults and clamps', () => {
  assert.deepEqual(defaultBlenderConfig().advanced.local, { timeoutSeconds: 120, maxTaskBytes: 500 * 1024 * 1024, maxOutputBytes: 4 * 1024 * 1024, extraWriteDirs: [], guard: 'block', args: [] });
  const t = (x: unknown) => normalizeBlender({ advanced: { local: { timeoutSeconds: x } } }).advanced.local.timeoutSeconds;
  assert.equal(t(1), 10);
  assert.equal(t(5000), 900);
  assert.equal(t(45.4), 45);
  assert.equal(t('x'), 120);
  assert.equal(t(NaN), 120);
  const l = normalizeBlender({ advanced: { local: { guard: 'log', extraWriteDirs: ['D:\\x'], args: ['--x'], maxOutputBytes: 'big', maxTaskBytes: -5 } } }).advanced.local;
  assert.equal(l.guard, 'log');
  assert.deepEqual(l.extraWriteDirs, ['D:\\x']);
  assert.deepEqual(l.args, ['--x']);
  assert.equal(l.maxOutputBytes, 4 * 1024 * 1024);
  assert.ok(l.maxTaskBytes > 0);
  assert.equal(normalizeBlender({ advanced: { local: { guard: 'off', args: [1] } } }).advanced.local.guard, 'block');
  assert.deepEqual(normalizeBlender({ advanced: { local: { args: [1] } } }).advanced.local.args, []);
});

test('C21: the community add-on is pinned by default (a 40-hex commit in the URL, a 64-hex sha256), and the TODO OWNER PC marker stays next to the value', async () => {
  const { COMMUNITY_PIN_URL, COMMUNITY_PIN_SHA256 } = await import('../src/shared/blender.js');
  const c = defaultBlenderConfig().advanced.community;
  assert.equal(c.addonUrl, 'https://raw.githubusercontent.com/ahujasid/mcp-for-blender/91cd735cc09fc75551de3347ebc7afdd69f3492e/addon.py');
  assert.equal(c.sha256, 'eb0facf69781a30e69792532087d8d41c6a14fcd323353250abe7988ee297fa5');
  assert.match(c.addonUrl, /\/[0-9a-f]{40}\/addon\.py$/);
  assert.match(c.sha256, /^[0-9a-f]{64}$/);
  assert.equal(COMMUNITY_PIN_URL, c.addonUrl);
  assert.equal(COMMUNITY_PIN_SHA256, c.sha256);
  assert.equal(normalizeBlender({}).advanced.community.sha256, c.sha256);
  const src = readFileSync(new URL('../../src/shared/blender.ts', import.meta.url), 'utf8');
  assert.match(src, /TODO OWNER PC/);
});

test('C21: an old stored default (moving branch, no hash) moves to the pin; a user\'s own address or an explicit empty hash is left alone and never gets the pin\'s hash', () => {
  const OLD = 'https://raw.githubusercontent.com/ahujasid/blender-mcp/main/addon.py';
  const pin = defaultBlenderConfig().advanced.community;
  assert.deepEqual(pick(normalizeBlender({ advanced: { community: { addonUrl: OLD, sha256: '' } } })), { addonUrl: pin.addonUrl, sha256: pin.sha256 });
  assert.deepEqual(pick(normalizeBlender({ advanced: { community: { addonUrl: OLD } } })), { addonUrl: pin.addonUrl, sha256: pin.sha256 });
  // the user's own address, no hash: trust on first use, not the pinned hash of a different file
  assert.deepEqual(pick(normalizeBlender({ advanced: { community: { addonUrl: 'https://example.org/addon.py' } } })), { addonUrl: 'https://example.org/addon.py', sha256: '' });
  // the user's own hash for the old address is theirs
  assert.deepEqual(pick(normalizeBlender({ advanced: { community: { addonUrl: OLD, sha256: 'a'.repeat(64) } } })), { addonUrl: OLD, sha256: 'a'.repeat(64) });
  // the pinned address with an explicit empty hash stays unpinned (the user chose trust on first use); with junk it gets the pin back
  assert.equal(normalizeBlender({ advanced: { community: { addonUrl: pin.addonUrl, sha256: '' } } }).advanced.community.sha256, '');
  assert.equal(normalizeBlender({ advanced: { community: { addonUrl: pin.addonUrl, sha256: 'xyz' } } }).advanced.community.sha256, pin.sha256);
});
const pick = (c: ReturnType<typeof normalizeBlender>) => ({ addonUrl: c.advanced.community.addonUrl, sha256: c.advanced.community.sha256 });

test('blender.baseDir: an absolute folder is kept; a relative or malformed one is dropped (defaults apply)', () => {
  assert.equal(normalizeBlender({ baseDir: 'D:\\blender' }).baseDir, 'D:\\blender');
  assert.equal(normalizeBlender({ baseDir: 'D:/blender' }).baseDir, 'D:/blender');
  assert.equal(normalizeBlender({ baseDir: '/mnt/blender' }).baseDir, '/mnt/blender');
  assert.equal(normalizeBlender({ baseDir: '  D:\\blender  ' }).baseDir, 'D:\\blender', 'surrounding spaces are trimmed');
  assert.equal(normalizeBlender({ baseDir: 'blender' }).baseDir, undefined, 'a relative path would resolve against different working directories');
  assert.equal(normalizeBlender({ baseDir: '' }).baseDir, undefined);
  assert.equal(normalizeBlender({ baseDir: '   ' }).baseDir, undefined);
  assert.equal(normalizeBlender({ baseDir: 5 }).baseDir, undefined);
  assert.equal(normalizeBlender({ baseDir: 'C:\\blender' + String.fromCharCode(10) }).baseDir, undefined, 'control characters are refused');
});
