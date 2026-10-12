import test from 'node:test';
import assert from 'node:assert/strict';
import { needsApproval, isLegionTool } from '../src/core/approvals.js';
import { taintsRun } from '../src/core/engine.js';
import { buildHostToolsServer, resolveWithin } from '../src/core/exec/host-tools.js';
import { DirectHostBackend } from '../src/core/exec/direct-host.js';

const NAMES = ['mcp__host__shell', 'mcp__host__read_file', 'mcp__host__write_file'];

test('the host tools are NOT Legion tools, so they do not skip the approval card', () => {
  for (const n of NAMES) assert.equal(isLegionTool(n), false, n);
});

test('in ask mode every host tool raises an approval card', () => {
  for (const n of NAMES) assert.equal(needsApproval('ask', n), true, n);
});

test('in auto-edits mode a host shell/write still raises a card (conservative for host access)', () => {
  assert.equal(needsApproval('auto-edits', 'mcp__host__shell'), true);
  assert.equal(needsApproval('auto-edits', 'mcp__host__write_file'), true);
});

test('a full-access agent is honoured: no card in full mode', () => {
  for (const n of NAMES) assert.equal(needsApproval('full', n), false, n);
});

test('every host tool taints the run (it can bring outside content in)', () => {
  for (const n of NAMES) assert.equal(taintsRun(n), true, n);
});

test('read_file/write_file/shell paths stay inside the scope root', () => {
  const root = resolveWithin('/tmp/work', '.');
  assert.ok(root.endsWith('work'));
  // inside is fine
  assert.doesNotThrow(() => resolveWithin('/tmp/work', 'src/a.ts'));
  assert.doesNotThrow(() => resolveWithin('/tmp/work', './src/a.ts'));
  // escaping the root is refused
  assert.throws(() => resolveWithin('/tmp/work', '../outside.txt'), /outside the allowed root/);
  assert.throws(() => resolveWithin('/tmp/work', '/etc/passwd'), /outside the allowed root/);
});

test('the host server builds with the three host tools', () => {
  const srv = buildHostToolsServer({ agentId: 'a', taskId: 't', rootDir: '/tmp/work', backend: new DirectHostBackend() });
  assert.ok(srv, 'server is created');
});
