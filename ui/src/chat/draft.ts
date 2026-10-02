/** Puts a message that could not be sent back into the input without discarding what was typed meanwhile (the lost text goes first, on its own line). */
export function restoreDraft(current: string, lost: string): string {
  if (!current.trim()) return lost;
  if (current === lost || current.startsWith(lost + '\n')) return current;
  return `${lost}\n${current}`;
}
