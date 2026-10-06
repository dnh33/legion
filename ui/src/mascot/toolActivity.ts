/**
 * When a running task last showed tool activity, for the bust's "Executing" (hacking) window. Kept free of React and the
 * store so it can be tested on plain message lists.
 *
 * A denied tool call is not activity. Its call row is stored before the approval card opens, and the denial comes back as a
 * tool result ("The user denied this action.", or the no-one-answered text after the timeout). Counting either would show
 * "Executing" right after Deny, which reads as "it ran anyway". `deniedAt` is the `at` of the newest card denied for this
 * task (the call it was raised for is stored at or before that moment); a result paired with such a call is ignored too.
 */
export interface ToolRow { role: string; at: string; toolUseId?: string; resultFor?: string }

export function lastToolAt(messages: ReadonlyArray<ToolRow> | undefined, deniedAt?: string): string {
  const m = messages && messages.length ? messages[messages.length - 1] : undefined;
  if (!m || m.role !== 'tool') return '';
  if (!deniedAt) return m.at;
  if (m.resultFor) {
    const call = messages!.find((x) => x.role === 'tool' && x.toolUseId === m.resultFor);
    return call && call.at <= deniedAt ? '' : m.at;
  }
  return m.at <= deniedAt ? '' : m.at;
}

/** The denial record after a card is answered: a deny (by the user, or the timeout) remembers that card's `at` for its task. */
export function noteDenial(
  denials: Readonly<Record<string, string>>,
  card: { taskId: string; at: string } | undefined,
  allowed: boolean,
): Record<string, string> {
  if (allowed || !card) return denials as Record<string, string>;
  const prev = denials[card.taskId];
  return prev && prev >= card.at ? (denials as Record<string, string>) : { ...denials, [card.taskId]: card.at };
}

/**
 * The Relic's shared mood right after the user presses Deny. The core moves it off 'hacking' too, but its event arrives over
 * SSE after the card is already gone here, and in that gap the Relic would read "Executing". Same words as the core's note.
 */
export function moodAfterDecision<M extends { mood: string; note?: string; at: number }>(
  mascot: M,
  card: { toolName: string } | undefined,
  allowed: boolean,
  now: number,
): M | { mood: 'thinking'; note: string; at: number } {
  if (allowed || !card || mascot.mood !== 'hacking') return mascot;
  return { mood: 'thinking', note: `${card.toolName} denied`, at: now };
}
