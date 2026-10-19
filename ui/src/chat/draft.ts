/** Puts a message that could not be sent back into the input without discarding what was typed meanwhile (the lost text goes first, on its own line). */
export function restoreDraft(current: string, lost: string): string {
  if (!current.trim()) return lost;
  if (current === lost || current.startsWith(lost + '\n')) return current;
  return `${lost}\n${current}`;
}

/**
 * The box's hint, "Ask <name> to do something" or "Reply to <name>", on ONE line: the name is cut (24 characters at most, then shorter) until the whole sentence fits
 * the room the box has. `fits` measures a sentence; the box is narrow at a large UI scale, and a sentence wrapped into its 40 px height would be cut in half.
 */
export function fitPlaceholder(lead: string, name: string | undefined, tail: string, fits: (s: string) => boolean, max = 24, min = 8): string {
  const n = (name ?? 'Legion').trim() || 'Legion';
  for (let len = Math.min(n.length, max); ; len--) {
    const shown = n.length > len ? `${n.slice(0, len).trimEnd()}…` : n;
    const s = `${lead}${shown}${tail}`;
    if (len <= min || fits(s)) return s;
  }
}
