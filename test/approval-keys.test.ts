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
import { ARM_MS, clickOnly, threadKey } from '../src/shared/approval-keys.js';
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
  assert.deepEqual(threadKey(bash, 'a', true, true), { id: 'a1', allow: true });
  assert.deepEqual(threadKey(bash, 'A', true, true), { id: 'a1', allow: true });
  for (const c of [script, oddScript, getBlender, asset]) {
    assert.equal(threadKey(c, 'a', true, true), null, `A must not allow ${c.toolName}`);
    assert.equal(threadKey(c, 'A', true, true), null, `Shift+A must not allow ${c.toolName}`);
    assert.deepEqual(threadKey(c, 'd', true, true), { id: c.id, allow: false });
    assert.deepEqual(threadKey(c, 'D', true, true), { id: c.id, allow: false });
  }
  assert.equal(threadKey(bash, 'x', true, true), null);
  assert.equal(threadKey(bash, 'Enter', true, true), null);
  assert.equal(threadKey(undefined, 'a', true, true), null);
  assert.equal(threadKey(undefined, 'd', true, true), null);
});

test('thread-wide A never allows a card that is not fully in view: it reveals the card instead; D still denies', () => {
  // the defect: a stray "a" with focus on the page allowed a card 3,300 px below the visible part of the thread
  assert.deepEqual(threadKey(bash, 'a', false, true), { id: 'a1', reveal: true });
  assert.deepEqual(threadKey(bash, 'A', false, false), { id: 'a1', reveal: true });
  assert.deepEqual(threadKey(bash, 'a', true, true), { id: 'a1', allow: true });
  assert.deepEqual(threadKey(bash, 'd', false, true), { id: 'a1', allow: false });
  // a click-only card is neither allowed nor revealed by A, in view or not
  assert.equal(threadKey(script, 'a', false, true), null);
  assert.equal(threadKey(script, 'a', true, true), null);
});

test('A on a card that only just appeared or was just revealed does nothing: "banana" or a sentence typed on the page allows nothing', () => {
  assert.equal(threadKey(bash, 'a', true, false), null);
  assert.equal(threadKey(bash, 'A', true, false), null);
  // the "d" in "and" is not a deny either
  assert.equal(threadKey(bash, 'd', true, false), null);
  assert.equal(threadKey(bash, 'd', false, false), null);
  assert.ok(ARM_MS >= 800, 'long enough to outlast a typed word');
  // the clock: every key restarts it, so continuous typing never arms A
  const thread = readFileSync(join(process.cwd(), 'ui/src/components/Thread.tsx'), 'utf8');
  // the clock and the arithmetic moved to the shared modules (keyClock, isArmed), so a card's own keys read the same ones: test/card-arming.test.ts
  assert.match(thread, /quietSince = quietBefore\(e, now, e\.key\)/);
  assert.match(thread, /isArmed\(appearedAt\('approval:' \+ a\.id, now\), quietSince, now\)/);
});

test('both key paths read the shared rule: the thread shortcut goes through threadKey, the card through clickOnly', () => {
  const thread = readFileSync(join(process.cwd(), 'ui/src/components/Thread.tsx'), 'utf8');
  // a refused key also tells the card (the same note as its own key): test/card-arming.test.ts checks that wiring
  assert.match(thread, /const k = threadKey\(first, e\.key, cardInView\(first\), armedFor\(first, now, quietSince\)\);\s*if \(!k\) \{ if \(shortcutRefused\(/);
  assert.match(thread, /void decide\(k\.id, k\.allow\)/);
  assert.doesNotMatch(thread, /\.focus\(/, 'a reveal scrolls to the card but never focuses it');
  // no other decide(…, true) by key in the thread
  assert.doesNotMatch(thread, /decide\(first\.id, true\)/);
  const cardSrc = readFileSync(join(process.cwd(), 'ui/src/components/ApprovalCard.tsx'), 'utf8');
  assert.match(cardSrc, /const noKey = clickOnly\(a\);/);
  assert.match(cardSrc, /if \(!noKey && \(e\.key === 'a' \|\| e\.key === 'A'\)\)/);
});

test('a board proposal card may take focus on reveal: no key answers it, and the window shortcut skips anything inside .approval', () => {
  // proposal cards are focusable (the owner ruling: the card on top, focused), so the focus is safe only because nothing on them answers a key
  const proposal = readFileSync(join(process.cwd(), 'ui/src/components/ProposalCards.tsx'), 'utf8');
  assert.doesNotMatch(proposal, /onKeyDown|e\.key === 'a'|e\.key === 'A'/, 'a focused proposal card answers no key');
  assert.match(proposal, /className="approval"/, 'the card carries the .approval class');
  const thread = readFileSync(join(process.cwd(), 'ui/src/components/Thread.tsx'), 'utf8');
  assert.match(thread, /closest\('\.approval, \.question, \.modal'\)/, 'the window shortcut skips a focused .approval card');
});
