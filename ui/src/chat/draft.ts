/** Puts a message that could not be sent back into the input without discarding what was typed meanwhile (the lost text goes first, on its own line). */
export function restoreDraft(current: string, lost: string): string {
  if (!current.trim()) return lost;
  if (current === lost || current.startsWith(lost + '\n')) return current;
  return `${lost}\n${current}`;
}

/** The agent's name as the new-task box says it ("Ask <name> to do something"): cut at 24 characters so the sentence stays on one line in the 40 px box. */
export function placeholderName(name: string | undefined, max = 24): string {
  const n = (name ?? 'Legion').trim() || 'Legion';
  return n.length > max ? `${n.slice(0, max).trimEnd()}…` : n;
}
