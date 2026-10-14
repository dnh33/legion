import test from 'node:test';
import assert from 'node:assert/strict';
import { AWAY_COPY, queueReasonText } from '../src/shared/away-copy.js';

/** Every string the module can produce, functions called with sample values. */
function allStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (typeof node === 'function') out.push(String((node as (...a: unknown[]) => unknown)(4, 4, 'Builder', '07:00')));
  else if (node && typeof node === 'object') for (const v of Object.values(node)) allStrings(v, out);
  return out;
}

test('copy rules: no em or en dash, no "this computer", no outside product names', () => {
  const all = allStrings(AWAY_COPY);
  assert.ok(all.length > 20);
  for (const s of all) {
    assert.ok(!/[—–]/.test(s), `dash in: ${s}`);
    assert.ok(!/this (computer|machine)/i.test(s), `this computer in: ${s}`);
    assert.ok(!/hermes|shipyard|cursor/i.test(s), `outside product in: ${s}`);
    assert.ok(s.trim().length > 0 && s === s.trim(), `empty or untrimmed: "${s}"`);
  }
});

test('every queue reason has a sentence', () => {
  assert.equal(queueReasonText('slot', { running: 4, cap: 4 }), 'Waiting for a free slot (4 of 4 running in all projects)');
  assert.equal(queueReasonText('budget'), 'Waiting for the budget');
  assert.equal(queueReasonText('paused'), 'Waiting: new starts are paused');
  assert.equal(queueReasonText('after', { agentName: 'Builder' }), "Queued after Builder's current run");
});

test('wait lines use the numbers they are given', () => {
  assert.equal(AWAY_COPY.wait.deny(10), 'Auto-denies after 10 min');
  assert.equal(AWAY_COPY.wait.park(3), 'Parks after 3 min');
  assert.equal(AWAY_COPY.wait.quiet('07:00'), 'Waiting: quiet hours until 07:00');
});
