/**
 * The stored task as chat messages, checked for the shape a provider will actually accept.
 *
 * An OpenAI-compatible endpoint rejects an orphaned `tool` message — one whose assistant `tool_calls` parent is not in
 * the request — and the failure arrives mid-stream, so it looks like a network problem rather than a bad conversation.
 * This walks the produced array the way the slice is supposed to have been cut, and reports the first break.
 */
export function firstConversationBreak(
  msgs: readonly { role: string; content?: string | null; tool_call_id?: string; tool_calls?: unknown }[],
): string | undefined {
  const answered = new Set<string>();
  for (const m of msgs) {
    if (m.role === 'tool') {
      const id = m.tool_call_id;
      // A tool result whose call is not in this request is an orphan and is rejected by the endpoint.
      if (!id || !answered.has(id)) {
        return `tool result at message ${msgs.indexOf(m)} has no matching tool_call (id ${id ?? 'none'})`;
      }
      answered.delete(id);
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls as { id?: string }[]) if (c?.id) answered.add(c.id);
    }
  }
  // A call still waiting for its result at the end is tolerated (the loop feeds results back), but an assistant that
  // opens with tool_calls as the very first message is not.
  if (msgs[0] && msgs[0].role === 'assistant' && Array.isArray(msgs[0].tool_calls) && msgs[0].tool_calls.length > 0) {
    return 'the conversation opens with an assistant tool call';
  }
  return undefined;
}