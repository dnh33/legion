/**
 * One-key answers on approval cards. A Blender script and the two Blender downloads are allowed by clicking only, after reading the card.
 *
 * The defect this exists for: the card's own A key skipped those cards, but the thread-wide shortcut in Thread.tsx (A or D with focus on
 * the page, which is where focus is when a card appears) called decide(first, true) for whatever card came first. Pressing A in the
 * Sculptor's thread allowed a Blender script nobody had read. Both paths now read `threadKey`/`clickOnly` from src/shared/approval-keys.ts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { clickOnly, threadKey } from '../src/shared/approval-keys.js';
import { BLENDER_ASSET_TOOL, BLENDER_EXEC_TOOL, GET_BLENDER_TOOL } from '../src/shared/blender.js';

const card = (id: string, toolName: string, input: Record<string, unknown> = {}) => ({ id, toolName, input });
const bash = card('a1', 'Bash', { command: 'ls' });
const script = card('b1', BLENDER_EXEC_TOOL, { script: 'import bpy', mode: 'local' });
const oddScript = card('b2', BLENDER_EXEC_TOOL, { script: 42 });
const getBlender = card('b3', GET_BLENDER_TOOL);
const asset = card('b4', BLENDER_ASSET_TOOL);

test('click-only cards: a Blender script (whatever its input), the Blender download and an asset download; nothing else', () => {
  for (const c of [script, oddScript, getBlender, asset]) assert.equal(clickOnly(c), true, c.toolName);
  for (const t of ['Bash', 'Edit', 'Write', 'mcp__legion__vm_exec', 'mcp__legion_comms__room_create', 'mcp__legion_board__delete', 'mcp__legion_browser__browser_open', 'mcp__legion_blender__blender_inspect']) {
    assert.equal(clickOnly({ toolName: t }), false, t);
  }
});

test('thread-wide A allows an ordinary card and never a click-only one; D denies either; other keys and no card do nothing', () => {
  assert.deepEqual(threadKey(bash, 'a'), { id: 'a1', allow: true });
  assert.deepEqual(threadKey(bash, 'A'), { id: 'a1', allow: true });
  for (const c of [script, oddScript, getBlender, asset]) {
    assert.equal(threadKey(c, 'a'), null, `A must not allow ${c.toolName}`);
    assert.equal(threadKey(c, 'A'), null, `Shift+A must not allow ${c.toolName}`);
    assert.deepEqual(threadKey(c, 'd'), { id: c.id, allow: false });
    assert.deepEqual(threadKey(c, 'D'), { id: c.id, allow: false });
  }
  assert.equal(threadKey(bash, 'x'), null);
  assert.equal(threadKey(bash, 'Enter'), null);
  assert.equal(threadKey(undefined, 'a'), null);
  assert.equal(threadKey(undefined, 'd'), null);
});

test('both key paths read the shared rule: the thread shortcut goes through threadKey, the card through clickOnly', () => {
  const thread = readFileSync(join(process.cwd(), 'ui/src/components/Thread.tsx'), 'utf8');
  assert.match(thread, /const k = threadKey\(taskApprovals\[0\], e\.key\); if \(!k\) return;/);
  assert.match(thread, /void decide\(k\.id, k\.allow\)/);
  // no other decide(…, true) by key in the thread
  assert.doesNotMatch(thread, /decide\(first\.id, true\)/);
  const cardSrc = readFileSync(join(process.cwd(), 'ui/src/components/ApprovalCard.tsx'), 'utf8');
  assert.match(cardSrc, /const noKey = clickOnly\(a\);/);
  assert.match(cardSrc, /if \(!noKey && \(e\.key === 'a' \|\| e\.key === 'A'\)\)/);
});
