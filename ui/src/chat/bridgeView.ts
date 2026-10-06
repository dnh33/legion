/**
 * How an agent-to-agent bridge call (mcp__legion__ask / tell) reads to a person. Pure, so the core suite can check it without React.
 * ToolChip, MessageView and WorkingRow draw what these return.
 */

/** The bridge verb of a tool name ("mcp__legion__ask" -> "ask"), or the name unchanged when it is not a bridge tool. */
export const bridgeVerb = (toolName?: string) => (toolName ?? '').replace(/^mcp__legion__/, '');

/** The readable result text of an ask, recovered from the JSON the tool returned (or from an older core's clipped JSON). */
export function bridgeResult(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try { const o = JSON.parse(raw) as Record<string, unknown>; if (typeof o.result === 'string') return o.result; } catch { /* plain or clipped JSON */ }
  // Older cores clipped the JSON mid-string; recover the readable result text.
  const m = /"result"\s*:\s*"([\s\S]*)$/.exec(raw);
  if (m) return m[1]!.replace(/"\s*}\s*$/, '').replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return raw;
}

/** What the expanded chip says about the call's outcome. `tone` picks the styling: error lines are drawn in the danger colour. */
export interface BridgeOutcome { tone: 'ok' | 'error' | 'pending' | 'note'; text: string; heading?: string; taskId?: string }

/**
 * Errors the core raises after the message was accepted for the other agent: a cancel, or the task deleted under it, also for a
 * queued message that never ran (bridge.ts cancelFor, forget, drain). Every other
 * "Error: …" from ask/tell comes from a check that runs before anything is delivered (unknown agent, depth, hop, rate, model).
 */
const AFTER_SEND = new Set(['Cancelled', 'The target task was deleted', 'The target task no longer exists']);

/** "<X> could not finish: <reason>", with the bare status words the core uses turned into a sentence. */
export function couldNotFinish(name: string, reason: string | undefined): string {
  const r = (reason ?? '').trim();
  const plain = !r || /^cancell?ed$/i.test(r) ? 'the task was cancelled.' : /^gone$/i.test(r) ? 'the task no longer exists.' : /^error$/i.test(r) ? 'the task stopped with an error.' : r;
  return `${name} could not finish: ${plain}`;
}

/**
 * The outcome line of an ask or tell call.
 * @param raw the tool result text as stored (undefined while the call has not come back)
 * @param target the other agent's display name
 * @param live whether the calling task is still queued or running
 */
export function bridgeOutcome(kind: 'ask' | 'tell', raw: string | undefined, target: string, live: boolean): BridgeOutcome {
  if (raw === undefined || raw === '') {
    if (!live) return { tone: 'note', text: 'No result was recorded for this call.' };
    return { tone: 'pending', text: kind === 'ask' ? `Waiting for ${target}\u2026` : `Sending to ${target}\u2026` };
  }
  let parsed: Record<string, unknown> | undefined;
  try { const v: unknown = JSON.parse(raw); if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>; } catch { parsed = undefined; }
  const taskId = typeof parsed?.taskId === 'string' ? parsed.taskId : undefined;
  // Legion's tool writes "Error: <reason>" with isError (src/core/agent-tools.ts); Claude Code may hand an MCP error back
  // wrapped in <tool_use_error> tags (not documented either way, PC check AB1), so read both forms.
  const bare = raw.trim().replace(/^<tool_use_error>([\s\S]*)<\/tool_use_error>$/, '$1').trim();
  const err = /^Error:\s*([\s\S]*)$/.exec(bare)?.[1]?.trim();
  if (kind === 'tell') {
    // a tell that was delivered always returns its task id; anything else is a refusal
    if (taskId) return { tone: 'note', text: `Sent. ${target}\u2019s reply will arrive in this task.`, taskId };
    return { tone: 'error', text: `Not sent: ${err ?? raw}` };
  }
  if (err !== undefined) return { tone: 'error', text: AFTER_SEND.has(err) ? couldNotFinish(target, err) : `Not sent: ${err}` };
  if (parsed) {
    const status = typeof parsed.status === 'string' ? parsed.status : undefined;
    const result = typeof parsed.result === 'string' ? parsed.result : undefined;
    if (result === undefined && typeof parsed.note === 'string') {
      // the ask stopped waiting; the other agent's task runs on (bridge.ts: "… Timed out after 600s.")
      const secs = /Timed out after (\d+)\s*s/.exec(parsed.note)?.[1];
      return { tone: 'note', text: secs ? `Still working after ${secs} s; ${target} keeps going.` : `Still working; ${target} keeps going.`, taskId };
    }
    if (status === 'error' || status === 'cancelled') return { tone: 'error', text: couldNotFinish(target, result ?? status), taskId };
  }
  const res = bridgeResult(raw);
  return res ? { tone: 'ok', heading: 'Result', text: res, taskId } : { tone: 'note', text: 'No result was recorded for this call.', taskId };
}

/**
 * A `tell` reply that reports the other agent's run failed rather than answered. Decided by `outcome`, the token Legion
 * writes into the reply header ("[Reply from X · task t · failed]"), never by the body: an answer is free text and may
 * itself start with "(error)". Old replies without the token read as ordinary replies. The body's own "(failed) "
 * marker (kept for the model) is dropped from the shown reason.
 */
export function replyFailure(body: string, name: string, outcome?: string): { text: string } | null {
  if (!outcome || !/^(failed|error|cancelled|gone)$/.test(outcome)) return null;
  const reason = body.trim().replace(/^\((?:failed|error|cancelled|gone)\)\s*/, '').trim();
  return { text: couldNotFinish(name, reason || outcome) };
}

/** The `agent` argument of a stored ask/tell call (the stored call is clipped at 500 characters, so a long message breaks the JSON). */
export function bridgeAgentRef(callText: string): string | undefined {
  try { const o = JSON.parse(callText) as { agent?: unknown }; if (typeof o.agent === 'string') return o.agent; } catch { /* clipped */ }
  return /"agent"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(callText)?.[1];
}

/** The agent an ask in this task is still waiting on: the latest ask call with no result yet (its `agent` argument as written). */
export function pendingAskAgent(messages: readonly { role: string; toolName?: string; toolUseId?: string; resultFor?: string; text: string }[] | undefined): string | undefined {
  if (!messages) return undefined;
  const answered = new Set<string>();
  for (const m of messages) if (m.resultFor) answered.add(m.resultFor);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'tool' || m.resultFor || bridgeVerb(m.toolName) !== 'ask') continue;
    if (m.toolUseId && answered.has(m.toolUseId)) return undefined;
    return bridgeAgentRef(m.text);
  }
  return undefined;
}

/** The tool part of the working row: a pending ask names the agent it waits on; every other tool shows its name as before. */
export function workingToolLabel(tool: string, askTarget: string | undefined): string {
  return bridgeVerb(tool) === 'ask' ? `Waiting on ${askTarget ?? 'another agent'}` : tool;
}
