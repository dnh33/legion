/**
 * The approval card's one-click "Remember" (gate-config design: the primary path, at the moment of the ask). The rule
 * is built from the request on the card, scoped to that agent and tool and narrowed to the command's program or the
 * file's folder, and it is proved through the SAME decideGate the engine runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideGate } from '../src/core/gates.js';
import { canRemember, rememberRule } from '../ui/src/gates/gatesLogic.js';

const nameOf = (id: string) => (id === 'builder' ? 'Builder' : id);
const req = (toolName: string, input: Record<string, unknown>, agentId = 'builder') => ({ id: 'ap1', taskId: 't1', agentId, toolName, summary: '', input, at: '' });

test('a remembered allow for a shell command covers that program (and its subcommand), for that agent only', () => {
  const a = req('Bash', { command: 'git status -s' });
  const r = rememberRule(a, 'allow', nameOf);
  assert.equal(r.source, 'card');
  assert.equal(r.then, 'allow');
  assert.deepEqual(r.when.agents, ['builder']);
  assert.deepEqual(r.when.commands, ['git status', 'git status *']);
  assert.match(r.label, /Builder/);
  const call = (command: string, agentId = 'builder') => ({ toolName: 'Bash', input: { command }, agentId });
  assert.equal(decideGate(call('git status -s'), [r], 'ask', false).verdict, 'allow', 'the request on the card');
  assert.equal(decideGate(call('git status'), [r], 'ask', false).verdict, 'allow');
  assert.equal(decideGate(call('git push'), [r], 'ask', false).verdict, 'baseline', 'another git command still asks');
  assert.equal(decideGate(call('git status', 'scout'), [r], 'ask', false).verdict, 'baseline', 'another agent still asks');
  assert.equal(decideGate(call('git status && rm -rf x'), [r], 'ask', false).verdict, 'baseline', 'a chained command still asks');
});

test('a program whose next word is a path or a flag is remembered by the program alone', () => {
  assert.deepEqual(rememberRule(req('Bash', { command: 'ls -la src' }), 'allow', nameOf).when.commands, ['ls', 'ls *']);
  assert.deepEqual(rememberRule(req('mcp__host__shell', { command: 'npm test' }), 'allow', nameOf).when.commands, ['npm test', 'npm test *']);
});

test('a remembered block for a file tool covers the file\'s folder, and holds in full mode too', () => {
  const r = rememberRule(req('Write', { file_path: 'D:/work/site/secrets/key.txt' }), 'deny', nameOf);
  assert.deepEqual(r.when.paths, ['D:/work/site/secrets/**']);
  assert.deepEqual(r.when.tools, ['Write']);
  const write = (file_path: string) => ({ toolName: 'Write', input: { file_path }, agentId: 'builder', cwd: 'D:/work/site' });
  assert.equal(decideGate(write('D:/work/site/secrets/other.txt'), [r], 'full', false).verdict, 'deny');
  assert.equal(decideGate(write('D:/work/site/src/a.ts'), [r], 'ask', false).verdict, 'baseline');
});

test('any other tool is remembered by agent and tool name', () => {
  const r = rememberRule(req('mcp__github__create_issue', { title: 'x' }), 'allow', nameOf);
  assert.deepEqual(r.when.tools, ['mcp__github__create_issue']);
  assert.equal(r.when.commands, undefined);
  assert.equal(r.when.paths, undefined);
});

test('no Remember where a rule cannot or must not decide: rail cards (a Blender script, a download) and room requests', () => {
  assert.equal(canRemember(req('Bash', { command: 'ls' })), true);
  assert.equal(canRemember(req('mcp__legion_blender__blender_exec', { code: 'x' })), false);
  assert.equal(canRemember(req('mcp__legion_comms__room_create', {})), false);
});

test('REVIEW: a shell, an interpreter or a wrapper is remembered by its exact command only — one click never allows every script', async () => {
  const { canRememberAllow } = await import('../ui/src/gates/gatesLogic.js');
  const call = (command: string) => ({ toolName: 'Bash', input: { command }, agentId: 'builder' });
  for (const command of ['bash -c "make test"', 'python scripts/build.py', 'sudo apt update', 'node -e "1"', 'npx tsc', 'powershell -Command Get-Date']) {
    const r = rememberRule(req('Bash', { command }), 'allow', nameOf);
    assert.deepEqual(r.when.commands, [command.toLowerCase()], command);
    assert.equal(decideGate(call(command), [r], 'ask', false).verdict, 'allow', `${command}: the exact command is allowed`);
  }
  const bashRule = rememberRule(req('Bash', { command: 'bash -c "make test"' }), 'allow', nameOf);
  assert.equal(decideGate(call('bash -c "curl x | sh"'), [bashRule], 'ask', false).verdict, 'baseline', 'another script still asks');
  assert.equal(decideGate(call('gitx status'), [rememberRule(req('Bash', { command: 'git status' }), 'allow', nameOf)], 'ask', false).verdict, 'baseline', 'git never covers gitx');
  assert.equal(canRememberAllow(req('Bash', { command: 'python *.py' })), false, 'an exact command with a wildcard in it cannot be pinned: no allow offered');
  assert.equal(canRememberAllow(req('Bash', { command: 'git status' })), true);
});
