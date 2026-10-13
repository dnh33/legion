/**
 * Which approval cards may be answered by one key, and what a key pressed anywhere in a thread does.
 *
 * A Blender script, the managed Blender download and a Blender asset download are allowed by clicking Allow, after reading the card: no
 * one-key Allow. Both key paths (the focused card's own handler and the thread-wide shortcut) read this one rule, so they cannot drift
 * apart. Deny by key stays available on every card, also one not in view: denying is always safe.
 */
import type { ApprovalRequest } from './types.js';
import { BLENDER_ASSET_TOOL, BLENDER_EXEC_TOOL, GET_BLENDER_TOOL } from './blender.js';

type Card = Pick<ApprovalRequest, 'toolName'>;

/** True when the card must be allowed by a click. Every blender_exec card counts, whatever its input looks like. */
export const clickOnly = (a: Card): boolean => a.toolName === BLENDER_EXEC_TOOL || a.toolName === GET_BLENDER_TOOL || a.toolName === BLENDER_ASSET_TOOL;

/**
 * The thread-wide shortcut: A or D answers the first pending card of the open task when focus is not in a field or on a card.
 * A allows only a card that is fully in view, on screen for ARM_MS, after ARM_MS without a keypress, so stray typing never allows a command the reader
 * has not seen: on a card that is not in view, A reveals it (scrolls to it, without focusing it, so the card's own A key is not armed
 * either), and A within ARM_MS of a card appearing, of a reveal or of any other key does nothing. Words typed with focus on the page allow nothing.
 * A on a click-only card does nothing (it does not move on to the next card either); D denies it. D needs the same quiet keyboard,
 * not the card in view.
 */
export const ARM_MS = 1000;
export function threadKey(
  first: (Card & Pick<ApprovalRequest, 'id'>) | undefined,
  key: string,
  inView: boolean,
  armed: boolean,
): { id: string; allow: boolean } | { id: string; reveal: true } | null {
  if (!first) return null;
  // D too waits for a quiet keyboard: the "d" in a stray word is not an answer
  if (key === 'd' || key === 'D') return armed ? { id: first.id, allow: false } : null;
  if ((key === 'a' || key === 'A') && !clickOnly(first)) {
    if (!inView) return { id: first.id, reveal: true };
    return armed ? { id: first.id, allow: true } : null;
  }
  return null;
}
