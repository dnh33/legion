/**
 * S5b — the live defect: a bot set to full access still pops a "Needs your OK" card.
 *
 * "Needs your OK" is the header of EVERY approval card (`ui/src/components/ApprovalCard.tsx:49`), so the owner's
 * symptom means exactly one thing: an agent with `approval: 'full'` produced an `approval.requested` event it
 * should not have.
 *
 * THIS FILE DRIVES THE REAL CODE. It calls the actual `BlenderGuard` and the actual `needsApproval`. It does NOT
 * re-implement the engine's decision — a test that mirrors the logic under test proves nothing, because it only
 * proves the mirror agrees with itself. (The first draft of this file did exactly that and was discarded.)
 *
 * The rule being tested, stated once:
 *
 *   An UNCAPPED, UI-started, full-access run must produce ZERO cards.
 *
 * Cards a full agent may legitimately produce are asserted too, so a future "fix" cannot quietly delete a control
 * the owner chose on purpose.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { decideGuard, guardAsk, needsApproval, stricterMode } from '../src/core/approvals.js';
import type { ApprovalMode } from '../src/shared/types.js';
import { GOOD_SCRIPT, agent as blenderAgent, connectTools, rig as blenderRig } from './blender-helpers.js';

// ------------------------------------------------------- the shared helper every guard must call

test('S5b-F: decideGuard — full never cards, every other mode does', () => {
  assert.equal(decideGuard('full').needsCard, false);
  assert.equal(decideGuard('auto-edits').needsCard, true);
  assert.equal(decideGuard('ask').needsCard, true);
  assert.equal(decideGuard('full').mode, 'full');
});

test('S5b-G: guardAsk — a ceiling beats a full agent (confused deputy survives the fix)', async () => {
  let asked = 0;
  const ok = await guardAsk({
    ceiling: 'ask', agentId: 'a1', fallbackMode: 'full',
    ask: async () => { asked++; return true; },
  });
  assert.equal(asked, 1, 'a capped run must still ask even though the agent is full');
  assert.equal(ok, true);
  // an auto-edits ceiling also tightens full
  asked = 0;
  await guardAsk({ ceiling: 'auto-edits', agentId: 'a1', fallbackMode: 'full', ask: async () => { asked++; return true; } });
  assert.equal(asked, 1, 'auto-edits ceiling must ask');
  // a `full` ceiling does not loosen anything
  asked = 0;
  await guardAsk({ ceiling: 'full', agentId: 'a1', fallbackMode: 'ask', ask: async () => { asked++; return true; } });
  assert.equal(asked, 1, 'a full ceiling must not loosen an ask agent');
});

test('S5b-H: guardAsk — the live store read beats the snapshot taken at run start', async () => {
  // The owner ruling: promoting an agent to full mid-task stops its cards on the NEXT call.
  let asked = 0;
  const ask = async (): Promise<boolean> => { asked++; return true; };
  // store says ask, the snapshot said full (promoted down mid-task): the store wins, so it asks
  await guardAsk({ modeOf: () => 'ask', agentId: 'a1', fallbackMode: 'full', ask });
  assert.equal(asked, 1, 'a demotion mid-task must be honoured immediately');
  // store says full, the snapshot said ask (promoted up mid-task): no card
  await guardAsk({ modeOf: () => 'full', agentId: 'a1', fallbackMode: 'ask', ask });
  assert.equal(asked, 1, 'a promotion mid-task must stop the cards immediately');
  // no store reachable: fall back to the snapshot
  await guardAsk({ agentId: 'a1', fallbackMode: 'full', ask });
  assert.equal(asked, 1, 'without a store the snapshot decides, and a full snapshot does not card');
  await guardAsk({ agentId: 'a1', fallbackMode: 'ask', ask });
  assert.equal(asked, 2, 'without a store an ask snapshot still cards');
});

test('S5b-I: guardAsk — a denied card in a capped run is still a denial (not silently allowed)', async () => {
  const allowed = await guardAsk({
    ceiling: 'ask', agentId: 'a1', fallbackMode: 'full', ask: async () => false,
  });
  assert.equal(allowed, false, 'the owner saying no must stay a no');
});

// ---------------------------------------------------------------------------- the generic path (REAL function)

test('S5b-A: needsApproval returns false for full on every tool it knows (real function, not a mirror)', () => {
  const tools = [
    'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch',
    'mcp__legion__ask', 'mcp__legion__vm_exec', 'mcp__legion__vm_claude', 'mcp__legion__vm_desktop',
    'mcp__github__create_issue', 'mcp__legion_kg__kg_recall', 'mcp__legion_board__board_add',
    'SomeToolLegionHasNeverHeardOf',
  ];
  for (const t of tools) {
    assert.equal(needsApproval('full', t), false, `${t} must not card in full`);
    assert.equal(needsApproval('full', t, { capped: false }), false, `${t} capped:false`);
  }
  // the tracker's suspect is genuinely innocent — but the other modes are unchanged and must stay so
  assert.equal(needsApproval('ask', 'Bash'), true);
  assert.equal(needsApproval('auto-edits', 'Bash'), true);
  assert.equal(needsApproval('ask', 'Write'), true);
  assert.equal(needsApproval('auto-edits', 'Write'), false);
});

test('S5b-B: the confused-deputy cap is real and must survive the fix (real function)', () => {
  const eff = (m: ApprovalMode, c?: ApprovalMode): ApprovalMode => (c ? stricterMode(m, c) : m);
  assert.equal(eff('full', 'ask'), 'ask', 'a cap tightens full down to ask');
  assert.equal(needsApproval(eff('full', 'ask'), 'Bash', { capped: true }), true);
  for (const t of ['mcp__legion__vm_exec', 'mcp__legion__vm_claude', 'mcp__legion__vm_desktop']) {
    assert.equal(needsApproval(eff('full', 'ask'), t, { capped: true }), true, t);
  }
  assert.equal(needsApproval(eff('full'), 'Bash', { capped: false }), false, 'uncapped full stays clear');
});

// ------------------------------------------------------------------ SEAM 1: Blender exec (REAL BlenderGuard)

test('S5b-C: SEAM blender_exec — a FULL-access agent still gets a card (this is the defect)', async () => {
  const r = blenderRig();
  try {
    const t = await connectTools(r, blenderAgent('sculptor', { approval: 'full' }), r.job);
    try {
      const res = await t.call('blender_exec', { script: GOOD_SCRIPT, mode: 'sandbox' });
      assert.equal(res.isError, false, `sandbox script should run in full mode: ${res.text}`);
      assert.equal(
        r.cards.length, 0,
        `DEFECT: blender_exec asked for ${r.cards.length} card(s) from a FULL agent: ${JSON.stringify(r.cards.map((c) => c.toolName))}`,
      );
    } finally { await t.client.close(); }
  } finally { rmSync(r.dataDir, { recursive: true, force: true }); }
});

test('S5b-D: SEAM blender_exec — ask and auto-edits keep their card (must NOT regress)', async () => {
  for (const mode of ['ask', 'auto-edits'] as const) {
    const r = blenderRig();
    try {
      const t = await connectTools(r, blenderAgent('sculptor', { approval: mode }), r.job);
      try {
        const res = await t.call('blender_exec', { script: GOOD_SCRIPT, mode: 'sandbox' });
        assert.equal(res.isError, false, `${mode}: the card was answered, so it should run`);
        assert.equal(r.cards.length, 1, `${mode}: exactly one card, got ${r.cards.length}`);
        assert.equal(r.cards[0]!.toolName, 'mcp__legion_blender__blender_exec');
      } finally { await t.client.close(); }
    } finally { rmSync(r.dataDir, { recursive: true, force: true }); }
  }
});

// --------------------------------------------------------------------- the no-record-no-run rule (guard.ts)

test('S5b-E: a full-mode Blender run still writes its audit record (no record, no run — fix must not weaken it)', async () => {
  // This is why a card may be skipped in full mode: the record is written regardless. If skipping the card also
  // skipped the record, an unrecorded script would run on the owner's machine.
  const r = blenderRig();
  try {
    const t = await connectTools(r, blenderAgent('sculptor', { approval: 'full' }), r.job);
    try {
      const res = await t.call('blender_exec', { script: GOOD_SCRIPT, mode: 'sandbox' });
      assert.equal(res.isError, false, res.text);
      const records = r.audit.entries() as Array<{ decision: string }>;
      assert.ok(records.some((x) => x.decision === 'completed'),
        `a full-mode run must still write its audit record; got ${JSON.stringify(records.map((x) => x.decision))}`);
    } finally { await t.client.close(); }
  } finally { rmSync(r.dataDir, { recursive: true, force: true }); }
});