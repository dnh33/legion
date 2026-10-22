import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPermission, mapPlan, mapToolCall } from '../src/core/acp/map.js';

// Wire shapes: ACP tool-calls and agent-plan pages (camelCase); what Hermes really sends: acp_adapter/tools.py, permissions.py, edit_approval.py.

test('execute with rawInput.command is a Bash call with input.command', () => {
  const t = mapToolCall({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'List files', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } })!;
  assert.equal(t.toolCallId, 'c1');
  assert.equal(t.toolName, 'Bash');
  assert.deepEqual(t.input, { command: 'ls' });
  assert.equal(t.status, 'pending');
  assert.equal(t.title, 'List files');
});

test('Hermes sends known tools without rawInput: the title keeps the call readable, the input stays empty of invented fields', () => {
  const t = mapToolCall({ sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'terminal: ls -la', kind: 'execute', status: 'pending', rawInput: null, locations: [] })!;
  assert.equal(t.toolName, 'Bash');
  assert.equal(t.input.command, undefined);
  assert.equal(t.title, 'terminal: ls -la');
});

test('read, fetch, edit, and other kinds map to Legion tool names; other uses the name field or the title up to the first colon', () => {
  assert.equal(mapToolCall({ toolCallId: 'r', title: 'read_file: a.ts', kind: 'read', locations: [{ path: '/p/a.ts', line: 3 }] })!.toolName, 'Read');
  assert.equal(mapToolCall({ toolCallId: 'r', title: 'read_file: a.ts', kind: 'read', locations: [{ path: '/p/a.ts', line: 3 }] })!.input.file_path, '/p/a.ts');
  const f = mapToolCall({ toolCallId: 'f', title: 'web_extract: x', kind: 'fetch', rawInput: { url: 'https://example.com/a' } })!;
  assert.equal(f.toolName, 'WebFetch');
  assert.equal(f.input.url, 'https://example.com/a');
  assert.equal(mapToolCall({ toolCallId: 'f2', title: 'x', kind: 'fetch', rawInput: { arguments: { url: 'https://example.com/b' } } })!.input.url, 'https://example.com/b');
  const w = mapToolCall({ toolCallId: 'w', title: 'write_file: /p/a.ts', kind: 'edit', locations: [{ path: '/p/a.ts' }] })!;
  assert.equal(w.toolName, 'Write');
  assert.equal(w.input.file_path, '/p/a.ts');
  assert.equal(mapToolCall({ toolCallId: 's', title: 'search_files: needle', kind: 'search' })!.toolName, 'search_files');
  assert.equal(mapToolCall({ toolCallId: 'o', title: 'todo: 3 items', kind: 'other' })!.toolName, 'todo');
  assert.equal(mapToolCall({ toolCallId: 'n', title: 'whatever: text', kind: 'other', name: 'my_tool' })!.toolName, 'my_tool');
  assert.equal(mapToolCall({ toolCallId: 'u', title: 'plain title', kind: 'think' })!.toolName, 'plain title');
  assert.equal(mapToolCall({ toolCallId: 'k', title: 'no kind at all' })!.toolName, 'no kind at all');
});

test('an update with only a status keeps the name and input of its start; text content is carried and clipped', () => {
  const start = mapToolCall({ toolCallId: 'c1', title: 'terminal: ls', kind: 'execute', rawInput: { command: 'ls' } })!;
  const done = mapToolCall({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a.txt\nb.txt' } }] }, start)!;
  assert.equal(done.toolName, 'Bash');
  assert.deepEqual(done.input, { command: 'ls' });
  assert.equal(done.title, 'terminal: ls');
  assert.equal(done.status, 'completed');
  assert.equal(done.text, 'a.txt\nb.txt');
  const big = mapToolCall({ toolCallId: 'c1', content: [{ type: 'content', content: { type: 'text', text: 'x'.repeat(100_000) } }] }, start)!;
  assert.ok(big.text!.length <= 16_500, 'content is clipped');
  // an update for an id that never had a start (a perm-check-N card being closed) does not throw
  const orphan = mapToolCall({ toolCallId: 'perm-check-1', status: 'failed' })!;
  assert.equal(orphan.status, 'failed');
  assert.equal(typeof orphan.toolName, 'string');
  assert.equal(mapToolCall({ title: 'no id' }), undefined);
  assert.equal(mapToolCall('nonsense'), undefined);
});

test('a command permission request (Hermes shape) is a Bash request with the command, title, and every option verbatim', () => {
  const p = mapPermission({
    sessionId: 's', toolCall: { toolCallId: 'perm-check-1', title: 'delete the build folder: rm -rf build', kind: 'execute', status: 'pending', content: [{ type: 'content', content: { type: 'text', text: 'delete the build folder\n$ rm -rf build' } }], rawInput: { command: 'rm -rf build', description: 'delete the build folder' } },
    options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
  })!;
  assert.equal(p.requestId, 'perm-check-1');
  assert.equal(p.toolName, 'Bash');
  assert.equal(p.input.command, 'rm -rf build');
  assert.equal(p.title, 'delete the build folder: rm -rf build');
  assert.deepEqual(p.options, [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }]);
});

test('an edit permission request (Hermes shape) is a Write request with file_path from rawInput.arguments.path and the new text for the card', () => {
  const p = mapPermission({
    sessionId: 's', toolCall: { toolCallId: 'edit-approval-2', title: 'Approve edit: /p/a.ts', kind: 'edit', status: 'pending', content: [{ type: 'diff', path: '/p/a.ts', oldText: 'old', newText: 'new' }], rawInput: { tool: 'write_file', arguments: { path: '/p/a.ts', content: 'new' } } },
    options: [{ optionId: 'allow_once', name: 'Allow edit', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
  })!;
  assert.equal(p.toolName, 'Write');
  assert.equal(p.input.file_path, '/p/a.ts');
  assert.deepEqual(p.diff, { path: '/p/a.ts', oldText: 'old', newText: 'new' });
  // no rawInput: the diff path and then the locations still give the file
  assert.equal(mapPermission({ toolCall: { toolCallId: 'e', kind: 'edit', title: 't', content: [{ type: 'diff', path: '/q/b.ts', newText: 'n' }] }, options: [] })!.input.file_path, '/q/b.ts');
  assert.equal(mapPermission({ toolCall: { toolCallId: 'e', kind: 'edit', title: 't', locations: [{ path: '/q/c.ts' }] }, options: [] })!.input.file_path, '/q/c.ts');
});

test('an unusual kind keeps the raw tool name; a request with no toolCallId or bad options is refused (undefined), never invented', () => {
  const p = mapPermission({ toolCall: { toolCallId: 'x1', title: 'send_message: hi', kind: 'other', rawInput: { to: 'a' } }, options: [{ optionId: 'o', name: 'Ok', kind: 'allow_once' }] })!;
  assert.equal(p.toolName, 'send_message');
  assert.deepEqual(p.input, { to: 'a' });
  assert.equal(mapPermission({ toolCall: { title: 'no id' }, options: [] }), undefined);
  assert.equal(mapPermission({ toolCall: { toolCallId: 'x' }, options: 'no' }), undefined);
  assert.deepEqual(mapPermission({ toolCall: { toolCallId: 'x', title: 't' }, options: [{ optionId: 'a' }, { optionId: 'b', name: 'B', kind: 'allow_once' }] })!.options, [{ optionId: 'b', name: 'B', kind: 'allow_once' }], 'a malformed option is dropped');
});

test('plan entries become todo items (priority dropped); entries without text are skipped; the list replaces the old one', () => {
  assert.deepEqual(mapPlan([{ content: 'read', priority: 'high', status: 'completed' }, { content: 'fix', priority: 'low', status: 'in_progress' }, { content: 'ship', priority: 'medium', status: 'pending' }, { content: '', status: 'pending' }, { priority: 'low' }, { content: 'odd', status: 'weird' }]),
    [{ content: 'read', status: 'completed' }, { content: 'fix', status: 'in_progress' }, { content: 'ship', status: 'pending' }, { content: 'odd', status: 'pending' }]);
  assert.deepEqual(mapPlan('nope'), []);
});
