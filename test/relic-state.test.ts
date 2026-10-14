/** The big selected mascot asks for you only when ITS OWN agent waits on you, not when another agent does (0.2.7 hands-on test). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentAwaitsOwner } from '../ui/src/mascot/awaiting.js';

test('another agent\'s ask does not make this agent await you; its own does; a question counts', () => {
  const approvals = [{ agentId: 'scout' }];
  assert.equal(agentAwaitsOwner('builder', approvals, []), false);
  assert.equal(agentAwaitsOwner('scout', approvals, []), true);
  assert.equal(agentAwaitsOwner('builder', [], [{ agentId: 'builder' }]), true);
});

test('the big mascot reads the selected agent\'s own asks, never the whole list', () => {
  const src = readFileSync(new URL('../../ui/src/mascot/useRelicState.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('agentAwaitsOwner(s.selectedAgentId'), 'uses the selected agent');
  assert.ok(!/approvals\.length\s*>\s*0/.test(src), 'no "any approval at all"');
});
