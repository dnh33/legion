import test from 'node:test';
import assert from 'node:assert/strict';
import { needsApproval, decideGuard, stricterMode, guardAsk } from '../src/core/approvals.js';
import { classifySafe } from '../src/shared/consequence.js';
import { baselineMode } from '../src/core/permission-mode.js';

const cons = (toolName: string, input: Record<string, unknown>) => classifySafe({ kind: 'approval', toolName, input, projectFolders: ['C:/proj'] });

test('Accept edits: edits run, shell and unknown tools ask, reads and Legion tools run', () => {
  assert.equal(needsApproval('auto-edits', 'Write'), false);
  assert.equal(needsApproval('auto-edits', 'Bash'), true);
  assert.equal(needsApproval('auto-edits', 'mcp__other__x'), true);
  assert.equal(needsApproval('auto-edits', 'Read'), false);
  assert.equal(needsApproval('auto-edits', 'mcp__legion_board__list'), false);
});
test('Smart: asks exactly for level 3, and for anything unclassified', () => {
  assert.equal(needsApproval('smart', 'Bash', { consequence: cons('Bash', { command: 'git status' }) }), false);
  assert.equal(needsApproval('smart', 'Bash', { consequence: cons('Bash', { command: 'git push' }) }), true);
  assert.equal(needsApproval('smart', 'Bash', { consequence: cons('Bash', { command: 'echo $(whoami)' }) }), true);
  assert.equal(needsApproval('smart', 'Write', { consequence: cons('Write', { file_path: 'C:/proj/a.txt' }) }), false);
  assert.equal(needsApproval('smart', 'Write', { consequence: cons('Write', { file_path: 'C:/other/a.txt' }) }), true);
  assert.equal(needsApproval('smart', 'mcp__other__x', { consequence: cons('mcp__other__x', {}) }), true);
});
test('Smart with no consequence passed fails closed (asks)', () => {
  assert.equal(needsApproval('smart', 'Bash'), true);
});
test('Smart never cards reads, the task list or Legion tools, as in every other mode', () => {
  for (const t of ['Read', 'Glob', 'TodoWrite', 'mcp__legion_kg__kg_capture']) assert.equal(needsApproval('smart', t), false, t);
});
test('a capped run still cards vm_exec in Smart', () => {
  assert.equal(needsApproval('smart', 'mcp__legion__vm_exec', { capped: true }), true);
});
test('Bypass (full) never cards ordinary tools, but a capped vm_exec still does (existing exception)', () => {
  assert.equal(needsApproval('full', 'Bash'), false);
  assert.equal(needsApproval('full', 'mcp__legion__vm_exec', { capped: true }), true);
});
test('decideGuard: Smart cards a guard unless a level below 3 is given; full never cards', () => {
  assert.equal(decideGuard('smart').needsCard, true);
  assert.equal(decideGuard('smart', { level: 2, tags: [], chip: '', certain: true }).needsCard, false);
  assert.equal(decideGuard('full').needsCard, false);
  assert.equal(decideGuard('auto-edits').needsCard, true);
  assert.equal(decideGuard('smart').mode, 'smart');
});
test('stricterMode orders ask < auto-edits < smart < full and fails closed on junk', () => {
  assert.equal(stricterMode('full', 'smart'), 'smart');
  assert.equal(stricterMode('smart', 'auto-edits'), 'auto-edits');
  assert.equal(stricterMode('full', 'bogus' as never), 'ask');
  assert.equal(stricterMode('bogus' as never, 'full'), 'ask');
});
test('baselineMode is the 0.3.0 mode: own mode, or ask for a follow agent, capped by the ceiling', () => {
  assert.equal(baselineMode({ agentMode: 'full' }), 'full');
  assert.equal(baselineMode({ agentMode: 'full', source: 'project' }), 'ask');
  assert.equal(baselineMode({ agentMode: 'full', ceiling: 'ask' }), 'ask');
});
test('guardAsk: live mode, ceiling and consequence decide whether the card shows', async () => {
  let asked = 0;
  const ask = async () => { asked++; return true; };
  const low = { level: 1 as const, tags: [], chip: '', certain: true };
  await guardAsk({ agentId: 'a', fallbackMode: 'smart', consequence: low, ask });
  assert.equal(asked, 0, 'smart + level 1 runs');
  await guardAsk({ agentId: 'a', fallbackMode: 'smart', ask });
  assert.equal(asked, 1, 'smart + no consequence asks');
  await guardAsk({ agentId: 'a', taskId: 't1', fallbackMode: 'ask', modeOf: (id, t) => (id === 'a' && t === 't1' ? 'full' : undefined), ask });
  assert.equal(asked, 1, 'live full via taskId runs');
  await guardAsk({ agentId: 'a', fallbackMode: 'full', ceiling: 'ask', ask });
  assert.equal(asked, 2, 'ceiling wins');
});
