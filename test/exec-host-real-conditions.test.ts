/**
 * REAL-CONDITIONS tests for the host shell — the edges a careful studio checks before shipping, not just the happy
 * path: empty output, unicode, stderr + non-zero exit, a timeout kill, deep/long paths, a near-cap write, and two
 * commands at once. The rig is the same engine-registered host server the dogfood uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { clampExecLimits } from '../src/core/exec/limits.js';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function hostServer(rootDir: string, limits?: Record<string, number>) {
  const bus = new EventBus();
  const config = { workspaceDir: rootDir, mcpServers: {} } as never;
  const engine = new Engine({
    store: {} as never, bus, vms: { touch() {}, ensureRunning: async () => ({}) } as never,
    approvals: new ApprovalBroker(bus), config, queryFn: (async () => []) as never, boatConfigured: () => false,
  });
  const agent = {
    id: 'dev', name: 'Dev', emoji: '⚒', description: '', systemPrompt: '', model: 'sonnet',
    approval: 'ask', mcpServers: [], vm: { enabled: false, size: 'default', idleStopMinutes: 15 },
    host: { enabled: true, rootDir },
  } as never;
  const out = (engine as never as { buildMcpServers: (a: unknown, j: unknown, act: unknown, r: string) => Record<string, any> })
    .buildMcpServers(agent, { taskId: 'rc' }, { tainted: false }, 'claude');
  return out.host;
}

async function call(srv: any, name: string, args: Record<string, unknown>) {
  const out = await srv.instance._registeredTools[name].handler(args, {});
  return { text: out.content.map((c: any) => c.text).join('\n'), isError: out.isError === true };
}

test('empty output: an empty command result is exit 0 and empty, never a crash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-rc-'));
  const r = await call(hostServer(root), 'shell', { command: 'node -e ""' });
  assert.equal(r.isError, false);
  assert.match(r.text, /exit code: 0/);
});

test('unicode output survives the round trip', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-rc-'));
  const r = await call(hostServer(root), 'shell', { command: 'node -e "process.stdout.write(\'héllo — 日本語\')"' });
  assert.match(r.text, /héllo — 日本語/);
});

test('stderr and a non-zero exit both come back, not swallowed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-rc-'));
  const r = await call(hostServer(root), 'shell', { command: 'node -e "console.error(\'boom\'); process.exit(3)"' });
  assert.match(r.text, /exit code: 3/);
  assert.match(r.text, /boom/, 'the error output is not lost');
});

test('a command that overruns its timeout is killed and reports 124 + timed out', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-rc-'));
  const r = await call(hostServer(root), 'shell', { command: 'node -e "setTimeout(function(){}, 10000)"', timeoutSeconds: 1 });
  assert.match(r.text, /exit code: 124/, 'timeout exit code');
  assert.match(r.text, /timed out/);
});

test('a deep nested path writes and reads back within the root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-rc-'));
  const srv = hostServer(root);
  const p = 'a/b/c/deep.txt';
  const w = await call(srv, 'write_file', { path: p, content: 'deep' });
  assert.equal(w.isError, false, 'nested write is allowed inside the root');
  assert.ok(existsSync(join(root, p)), 'the deep file exists');
  assert.match((await call(srv, 'read_file', { path: p })).text, /deep/);
});

test('a long file name is handled without truncating or erroring', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-rc-'));
  const srv = hostServer(root);
  const name = 'n'.repeat(120) + '.txt';
  const w = await call(srv, 'write_file', { path: name, content: 'long name' });
  assert.equal(w.isError, false);
  assert.equal(readFileSync(join(root, name), 'utf8'), 'long name');
});

test('a near-cap write is kept whole', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-rc-'));
  const srv = hostServer(root);
  const cap = clampExecLimits(undefined).maxWriteChars;
  const content = 'y'.repeat(cap - 10);
  const w = await call(srv, 'write_file', { path: 'big.txt', content });
  assert.equal(w.isError, false, 'a write just under the cap is accepted');
  assert.equal(readFileSync(join(root, 'big.txt'), 'utf8').length, cap - 10, 'every byte is written');
  const too = await call(srv, 'write_file', { path: 'huge.txt', content: 'z'.repeat(cap + 1) });
  assert.equal(too.isError, true, 'a write over the cap is refused, not silently cut');
});

test('two commands at once both run to completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-rc-'));
  const srv = hostServer(root);
  const [a, b] = await Promise.all([
    call(srv, 'shell', { command: 'node -e "setTimeout(function(){},120); process.stdout.write(\'AAA\')"' }),
    call(srv, 'shell', { command: 'node -e "setTimeout(function(){},120); process.stdout.write(\'BBB\')"' }),
  ]);
  assert.match(a.text, /AAA/);
  assert.match(b.text, /BBB/);
});
