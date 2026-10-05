/**
 * The context meter in the working row. Pure, so the core test suite can check it.
 *
 * The context in use after a model response is what that response was sent: new input plus what came from the cache
 * (read) plus what was just written to it. Output tokens are not counted: they join the context on the next turn.
 */
export function contextTokensOf(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const total = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  return total > 0 ? Math.round(total) : undefined;
}

/** "context 84k" (tokens only: Claude's window is not reliably known here, so there is no percentage). */
export function contextLabel(tokens: number): string {
  return tokens < 1000 ? `context ${Math.round(tokens)}` : `context ${Math.round(tokens / 1000)}k`;
}
