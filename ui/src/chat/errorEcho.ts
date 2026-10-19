import type { ChatMessage } from '../../../src/shared/types.js';

/**
 * A failed run leaves two things: the task's error (the red "Run failed" card, with Retry or Continue) and, in the history, a short system line
 * `Error: <the same words>` (the engine writes it so a later reader of the thread sees what happened). While the card is showing, the line right above
 * it says the same thing: leave it out, so the owner reads the error once. When the run is retried the card goes and the history line is shown again.
 * Only the last line, and only when its words are the card's words: an older failure in the same thread keeps its own line.
 */
export function dropErrorEcho(messages: ChatMessage[], error: string | undefined): ChatMessage[] {
  if (!error) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'system') continue;
    if (!m.text.startsWith('Error: ')) return messages;
    const said = m.text.slice('Error: '.length).trim();
    if (said && error.includes(said)) return [...messages.slice(0, i), ...messages.slice(i + 1)];
    return messages;
  }
  return messages;
}
