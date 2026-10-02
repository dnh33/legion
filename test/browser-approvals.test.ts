import test from 'node:test';
import assert from 'node:assert/strict';
import { needsApproval } from '../src/core/approvals.js';
import { taintsRun } from '../src/core/engine.js';
import { BROWSER_TOOLS } from '../src/shared/browser.js';
import type { ApprovalMode } from '../src/shared/types.js';

const MODES: ApprovalMode[] = ['ask', 'auto-edits', 'full'];

test('A1: the browser tools get no generic per-call card in any mode (the module asks its own), but the engine still taints on them', () => {
  for (const t of BROWSER_TOOLS) {
    const name = `mcp__legion_browser__${t}`;
    for (const m of MODES) { assert.equal(needsApproval(m, name), false, `${name} ${m}`); assert.equal(needsApproval(m, name, { capped: true }), false, `${name} ${m} capped`); }
    assert.equal(taintsRun(name), true, `${name} taints the run in the engine too`);
  }
});

test('A2: every other tool decides exactly as before (a table of the existing behaviour)', () => {
  const cases: Array<[string, boolean, boolean, boolean]> = [
    // tool, ask, auto-edits, full
    ['Read', false, false, false], ['Glob', false, false, false], ['WebFetch', false, false, false], ['WebSearch', false, false, false],
    ['Write', true, false, false], ['Edit', true, false, false],
    ['Bash', true, true, false], ['UnknownTool', true, true, false],
    ['mcp__legion__ask', false, false, false], ['mcp__legion_kg__kg_recall', false, false, false], ['mcp__legion_blender__blender_exec', false, false, false],
    ['mcp__someone_else__tool', true, true, false],
    // look-alikes of the browser names are NOT exempt
    ['mcp__legion_browser__browser_open__run', true, true, false], ['mcp__legion_browser__rm', true, true, false], ['mcp__legion_browser__Browser_open', true, true, false],
    ['mcp__legion_browser2__browser_open', true, true, false], ['mcp__evil__legion_browser__browser_open', true, true, false],
  ];
  for (const [tool, ask, auto, full] of cases) assert.deepEqual(MODES.map((m) => needsApproval(m, tool)), [ask, auto, full], tool);
  // capped runs still card the VM tools, as before
  for (const t of ['mcp__legion__vm_exec', 'mcp__legion__vm_claude', 'mcp__legion__vm_desktop']) for (const m of MODES) assert.equal(needsApproval(m, t, { capped: true }), true, t);
  assert.equal(needsApproval('full', 'mcp__legion__vm_exec'), false);
});
