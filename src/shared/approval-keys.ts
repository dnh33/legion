/**
 * Which approval cards may be answered by one key, and what a key pressed anywhere in a thread does.
 *
 * A Blender script, the managed Blender download and a Blender asset download are allowed by clicking Allow, after reading the card: no
 * one-key Allow. Both key paths (the focused card's own handler and the thread-wide shortcut) read this one rule, so they cannot drift
 * apart. Deny by key stays available everywhere: denying is always safe.
 */
import type { ApprovalRequest } from './types.js';
import { BLENDER_ASSET_TOOL, BLENDER_EXEC_TOOL, GET_BLENDER_TOOL } from './blender.js';

type Card = Pick<ApprovalRequest, 'toolName'>;

/** True when the card must be allowed by a click. Every blender_exec card counts, whatever its input looks like. */
export const clickOnly = (a: Card): boolean => a.toolName === BLENDER_EXEC_TOOL || a.toolName === GET_BLENDER_TOOL || a.toolName === BLENDER_ASSET_TOOL;

/**
 * The thread-wide shortcut: A or D answers the first pending card of the open task when focus is not in a field or on a card.
 * A on a click-only card does nothing (it does not move on to the next card either); D denies it.
 */
export function threadKey(first: (Card & Pick<ApprovalRequest, 'id'>) | undefined, key: string): { id: string; allow: boolean } | null {
  if (!first) return null;
  if (key === 'd' || key === 'D') return { id: first.id, allow: false };
  if ((key === 'a' || key === 'A') && !clickOnly(first)) return { id: first.id, allow: true };
  return null;
}
