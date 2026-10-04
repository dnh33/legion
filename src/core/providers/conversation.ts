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
  // How many calls are still waiting for a result. A COUNT, not a set of names: the bug this missed was a summary row
  // landing BETWEEN a call and its results, and a set-based walk cannot see that because the summary neither matches nor
  // rejects — it just interrupts.
  let open = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'tool') {
      const id = m.tool_call_id;
      // A tool result whose call is not in this request is an orphan and is rejected by the endpoint.
      if (!id || open === 0) {
        return `tool result at message ${i} has no matching tool_call (id ${id ?? 'none'})`;
      }
      open--;
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      if (open > 0) {
        return `message ${i}: assistant opens ${m.tool_calls.length} tool call(s) while ${open} from an earlier call are still unanswered; ` +
          'every call needs its results before the next non-tool row, or the endpoint rejects the whole request';
      }
      open = m.tool_calls.length;
    } else if (open > 0) {
      // A summary row here is the specific failure: it splits a call from its own results. Both the call and the results
      // are individually findable, which is why a name-based walk called this valid.
      return `message ${i}: a ${m.role} row interrupts ${open} unanswered tool call(s); ` +
        'a summary must not be spliced between a tool call and its results';
    }
  }
  // A call still waiting for its result at the end is tolerated (the loop feeds results back), but an assistant that
  // opens with tool_calls as the very first message is not.
  if (msgs[0] && msgs[0].role === 'assistant' && Array.isArray(msgs[0].tool_calls) && msgs[0].tool_calls.length > 0) {
    return 'the conversation opens with an assistant tool call';
  }
  return undefined;
}