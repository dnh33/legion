/**
 * DOGFOOD — the real-host end-to-end proof for the agent shell. This drives the tools the ENGINE registers (via
 * buildMcpServers) and asserts they actually do work on THIS machine: a real command runs and its output returns, a
 * real file is written and read back, a real non-zero exit code comes back, and the scope + approval gates hold. This
 * is the gap the kodawari audit named ("unit-tested but not proven on the real host").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.js';
import { ApprovalBroker, needsApproval } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A minimal Engine, then the host server it registers for a host-enabled agent.
function hostServer(rootDir: string) {
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
    .buildMcpServers(agent, { taskId: 'dogfood' }, { tainted: false }, 'claude');
  return out.host;
}

async function call(srv: any, name: string, args: Record<string, unknown>) {
  const out = await srv.instance._registeredTools[name].handler(args, {});
  return { text: out.content.map((c: any) => c.text).join('\n'), isError: out.isError === true };
}

test('DOGFOOD: the engine-registered shell tool really runs a command on this host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-dogfood-'));
  const srv = hostServer(root);
  assert.ok(srv, 'the engine registered the host server for a host-enabled agent');
  const r = await call(srv, 'shell', { command: 'echo hello-dogfood' });
  assert.equal(r.isError, false);
  assert.match(r.text, /hello-dogfood/, 'a real command ran and its output came back');
  assert.match(r.text, /exit code: 0/);
});

test('DOGFOOD: write_file writes a real file and read_file reads it back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-dogfood-'));
  const srv = hostServer(root);
  const w = await call(srv, 'write_file', { path: 'note.txt', content: 'the dogfood content' });
  assert.equal(w.isError, false);
  assert.ok(existsSync(join(root, 'note.txt')), 'the file is really on disk');
  assert.equal(readFileSync(join(root, 'note.txt'), 'utf8'), 'the dogfood content', 'the bytes are really written');
  const r = await call(srv, 'read_file', { path: 'note.txt' });
  assert.equal(r.isError, false);
  assert.match(r.text, /the dogfood content/, 'the read returns the real bytes');
});

test('DOGFOOD: a failing command reports its real exit code, never faked to 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-dogfood-'));
  const srv = hostServer(root);
  const r = await call(srv, 'shell', { command: 'node -e "process.exit(7)"' });
  assert.match(r.text, /exit code: 7/, 'the real non-zero exit code comes back');
});

test('DOGFOOD: big shell output spills to a file on disk, every character kept', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-dogfood-'));
  const srv = hostServer(root);
  const r = await call(srv, 'shell', { command: 'node -e "process.stdout.write(\'X\'.repeat(50000)+\'END\')"' });
  assert.match(r.text, /the full output is in/, 'the window points at the spill file');
  const spill = readdirSync(join(root, '.legion-output'));
  assert.ok(spill.length >= 1, 'a spill file exists on disk');
  assert.match(readFileSync(join(root, '.legion-output', spill[0]!), 'utf8'), /END$/, 'the full output is preserved');
});

test('DOGFOOD: out-of-scope paths are refused, and the shell call still needs a card', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-dogfood-'));
  const srv = hostServer(root);
  const bad = await call(srv, 'write_file', { path: '../escape.txt', content: 'x' });
  assert.equal(bad.isError, true, 'a path outside the scope root is refused');
  assert.equal(needsApproval('ask', 'mcp__host__shell'), true, 'the shell call needs an approval card before it runs');
});
