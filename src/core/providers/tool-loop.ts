/**
 * Legion's own tool loop for a model that has no Claude Code tools. It offers only the in-process Legion tool servers of the run
 * (connected over an in-memory transport pair: no socket, no process), and every call goes, in this order, through: the offered-name
 * check, the argument check, taint (noteToolUse), the approval decision (the same one Claude's canUseTool uses), then the tool.
 * The tool's own gates (BSV, Blender, kg, comms) live inside the tool and are not touched here.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { connectExternal } from './external-mcp.js';
import { chatTurn } from './openai-compat.js';
import type { ChatTurnResult } from './openai-compat.js';
import { ProviderHttpError } from './http.js';
import type { HttpLimits, ProviderTarget } from './http.js';
import {
  applyPlan, clipToTokens, CompactionGuard, DEFAULT_CONTEXT_WINDOW, isContextLengthError, isSummaryMessage,
  localFallbackSummary, messagesTokens, needsCompaction, planCompaction, PROTECT_FIRST, renderSummaryRow,
  renderTranscript, sanitizeSummary, summaryPrompt, thresholdTokens, toolsTokens,
} from './compaction.js';
import type { CompactionPlan } from './compaction.js';
import type { ChatMessage, ChatToolSpec, ProviderHost, ProviderRunResult, TokenUsage } from './types.js';

export const MAX_ARG_BYTES = 64 * 1024;
export const MAX_TOOL_RESULT_CHARS = 12_000;
const FN_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const REPEAT_FAIL_LIMIT = 3;

/** Retry state per thread: the cooldown ladder and the anti-thrash breaker. Process-wide, keyed by task. */
export const compactionGuard = new CompactionGuard();

interface Offered { client: Client; remote: string }
export interface ToolSet { offered: Map<string, Offered>; specs: ChatToolSpec[]; close(): Promise<void> }

type Connectable = { connect(t: unknown): Promise<void>; close?(): Promise<void> };

/** Connects a client to each in-process server and lists its tools as `mcp__<server>__<tool>` (the names every Legion module already knows). */
export const MAX_OFFERED_TOOLS = 128;

export async function connectTools(servers: ProviderHost['servers'], notice: (t: string) => void, external: NonNullable<ProviderHost['external']> = {}): Promise<ToolSet> {
  const offered = new Map<string, Offered>();
  const specs: ChatToolSpec[] = [];
  const clients: Client[] = [];
  const servs: Connectable[] = [];
  for (const [serverName, cfg] of Object.entries(servers)) {
    if (cfg?.type !== 'sdk' || !cfg.instance) continue; // only in-process servers; nothing else is ever offered
    try {
      const inst = cfg.instance as unknown as Connectable;
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await inst.connect(st);
      const client = new Client({ name: 'legion-provider-loop', version: '1' });
      await client.connect(ct);
      clients.push(client); servs.push(inst);
      const listed = await client.listTools();
      for (const t of listed.tools) {
        const name = `mcp__${serverName}__${t.name}`;
        if (!FN_NAME.test(name)) { notice(`Tool ${name} is not offered to this model (its name is not allowed).`); continue; }
        offered.set(name, { client, remote: t.name });
        specs.push({ type: 'function', function: { name, description: (t.description ?? '').slice(0, 1000), parameters: t.inputSchema ?? { type: 'object', properties: {} } } });
      }
    } catch (e) {
      notice(`Tools of "${serverName}" are not available in this run: ${e instanceof Error ? e.message.slice(0, 160) : 'could not start'}.`);
    }
  }
  const closers: Array<() => Promise<void>> = [];
  for (const [serverName, cfg] of Object.entries(external)) {
    try {
      const conn = await connectExternal(serverName, cfg);
      closers.push(() => conn.close());
      const listed = await conn.client.listTools();
      for (const t of listed.tools) {
        const name = `mcp__${serverName}__${t.name}`;
        if (!FN_NAME.test(name)) { notice(`Tool ${name.slice(0, 80)} is not offered to this model (its name is not allowed).`); continue; }
        if (specs.length >= MAX_OFFERED_TOOLS) { notice(`More than ${MAX_OFFERED_TOOLS} tools are available; the rest are not offered to this model.`); break; }
        offered.set(name, { client: conn.client, remote: t.name });
        specs.push({ type: 'function', function: { name, description: (t.description ?? '').slice(0, 1000), parameters: t.inputSchema ?? { type: 'object', properties: {} } } });
      }
    } catch (e) {
      notice(`The MCP server "${serverName}" is not available in this run: ${e instanceof Error ? e.message.slice(0, 160) : 'could not start'}.`);
    }
  }
  return {
    offered, specs,
    async close() {
      for (const c of closers) { try { await c(); } catch { /* ignore */ } }
      for (const c of clients) { try { await c.close(); } catch { /* ignore */ } }
      for (const s of servs) { try { await s.close?.(); } catch { /* ignore */ } }
    },
  };
}

/**
 * Why a turn came back with neither text nor tool calls.
 *
 * Reported instead of a flat "empty answer" because these are different faults with different fixes: a reasoning model
 * that spent its whole allowance thinking, a provider that cut the response at its output cap, and a provider that
 * answered in a dialect Legion does not parse all produced the identical sentence, so the owner could not act on it.
 * "Retrying may work" is true and useless, so it is not what this says.
 */
export function emptyAnswerReason(finish: string | undefined, turn: number): string {
  const where = turn > 1 ? ` on turn ${turn}` : '';
  if (finish === 'length') {
    return `The model used its entire output limit${where} without producing an answer — the response was cut before any text arrived. Raise the provider's output limit, or ask for less at once.`;
  }
  if (finish === 'content_filter' || finish === 'safety') {
    return `The provider stopped the response${where} for safety reasons and returned nothing.`;
  }
  if (finish === 'tool_calls') {
    return `The model asked for tools${where} but Legion could not read them. This provider's tool-call format does not match what this build understands.`;
  }
  if (finish === undefined) {
    return `The provider closed the stream${where} without a finish reason and without any text. The stream ended early — retrying usually works, and the provider's own log will say more.`;
  }
  return `The model returned no text and no tool calls${where} (finish reason: ${finish}).`;
}

export interface BuildOptions {
  /** The model's context window in tokens. Absent means the conservative default, which compacts early rather than late. */
  window?: number;
  /** The tool definitions that will travel with the request; they share the window. */
  tools?: ChatToolSpec[];
  /** A summary row produced for this turn. Absent means "compact, but the summary is not written yet". */
  summary?: ChatMessage | null;
  /** Compact even if the conversation looks like it fits: the retry after the provider refused it for size. */
  force?: boolean;
}

/** What the transcript looks like before anything is dropped, and whether it has to be. */
interface Conversation {
  system: ChatMessage;
  /** Every stored row as provider messages, including any summaries already in the transcript. */
  all: ChatMessage[];
  /** The newest summary already stored, or null. Its presence is what turns early-turn protection off. */
  existing: ChatMessage | null;
  /** The rows that come after that summary: the ground a new compaction would have to cover. */
  afterSummary: ChatMessage[];
  plan: CompactionPlan;
  /** False when the whole conversation fits and can be sent as it stands. */
  overBudget: boolean;
}

/**
 * The stored task as chat messages, checked for the shape a provider will actually accept.
 *
 * Built from the whole transcript rather than a blind tail, because a blind tail is what made the oldest half of a
 * conversation disappear with no marker. When the conversation fits it is sent whole; when it does not, it is cut into
 * head + summary + tail. Either way a `tool` result is never separated from its call — an endpoint rejects the entire
 * request over one orphan, and the failure arrives mid-stream looking like a network fault.
 *
 * The current ask is appended last and is never part of what gets summarised: it is the one message whose loss would
 * make the model's answer wrong rather than merely thinner.
 */
export function buildMessages(host: Pick<ProviderHost, 'stored' | 'prompt' | 'systemPrompt'>, opts: BuildOptions = {}): ChatMessage[] {
  return [...conversationFor(host, opts).send, { role: 'user', content: host.prompt }];
}

export interface ConversationView extends Summarisable {
  /** The full request as it would go out: system prompt, then body. */
  send: ChatMessage[];
  /** The body without the system prompt, or with `summary` substituted in. */
  body: ChatMessage[];
  /** The system prompt Legion sends in front of everything. */
  system: ChatMessage;
  /** The summary already stored in this thread, if any. */
  existing: ChatMessage | null;
  /** The rows a new summary would have to cover. */
  middle: ChatMessage[];
}

/**
 * The conversation as it will be sent, without the current ask. Exported for the loop, which appends that itself.
 *
 * `body` is separate from `send` because the plan's indices address the conversation, not the system prompt in front of
 * it, and conflating the two is how a summary ends up one message out of place.
 */
export function conversationFor(host: Pick<ProviderHost, 'stored' | 'prompt' | 'systemPrompt'>, opts: BuildOptions = {}): ConversationView {
  const conv = readConversation(host, opts);
  const body = withSummary(conv, opts.summary ?? conv.existing);
  return { ...conv, body, send: [conv.system, ...body], middle: conv.afterSummary.slice(conv.plan.headEnd, conv.plan.tailStart) };
}

function readConversation(host: Pick<ProviderHost, 'stored' | 'prompt' | 'systemPrompt'>, opts: BuildOptions): Conversation {
  const window = opts.window ?? DEFAULT_CONTEXT_WINDOW;
  const lastUser = lastUserMessageIndex(host.stored);
  const all = toChatMessages(lastUser >= 0 ? host.stored.slice(0, lastUser) : host.stored);
  // The newest stored summary stands in for everything before it. Older summaries are a history of a history: they stay
  // in the JSONL and are not sent, because re-sending them costs window for no information.
  let summaryAt = -1;
  for (let i = all.length - 1; i >= 0; i--) if (isSummaryMessage(all[i]!)) { summaryAt = i; break; }
  const existing = summaryAt >= 0 ? all[summaryAt]! : null;
  const afterSummary = summaryAt >= 0 ? all.slice(summaryAt + 1) : all;
  // Early turns are protected on the first compaction only. After that the summary is the head, and keeping the
  // opening turns as well would re-assert them in every future summary — stale decisions, faithfully repeated.
  const plan = planCompaction(afterSummary, {
    window,
    protectFirst: existing ? 0 : PROTECT_FIRST,
    ...(opts.force ? { force: true } : {}),
    ...(existing ? { summaryTokens: summaryTokensOf(existing) } : {}),
  });
  const system: ChatMessage = { role: 'system', content: host.systemPrompt };
  const tail: ChatMessage = { role: 'user', content: host.prompt };
  return { system, all, existing, afterSummary, plan, overBudget: overBudget(all, afterSummary, plan, existing, system, tail, opts, window) };
}

/**
 * Whether the request as it would be sent is over the window.
 *
 * Measured on the projected send rather than on the raw transcript, so a conversation that only fits *because* a summary
 * is already in it is correctly seen as fitting — otherwise every turn after the first would re-compact, which is the
 * thrash the breaker exists to stop.
 */
function overBudget(all: readonly ChatMessage[], afterSummary: readonly ChatMessage[], plan: CompactionPlan, existing: ChatMessage | null, system: ChatMessage, tail: ChatMessage, opts: BuildOptions, window: number): boolean {
  const tools = toolsTokens(opts.tools ?? []);
  // Measured on the projected send, with the summary this thread already carries — so a conversation that only fits
  // *because* a summary is in it is correctly seen as fitting. Otherwise every turn after the first would re-compact,
  // which is exactly the thrash the breaker exists to stop.
  const conv: Conversation = { system, all: [...all], existing, afterSummary: [...afterSummary], plan, overBudget: true };
  const body = withSummary(conv, existing);
  return needsCompaction([...body, tail], window, tools, opts.force);
}

/** The last stored `user` message: the current ask, which `prompt` replaces. */
function lastUserMessageIndex(stored: ProviderHost['stored']): number {
  for (let i = stored.length - 1; i >= 0; i--) if (stored[i]!.role === 'user') return i;
  return -1;
}

/** Stored rows as provider messages. A tool call whose result never arrived is dropped with the group. */
function toChatMessages(prior: ProviderHost['stored']): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  const open = new Set<string>();
  for (const m of prior) {
    if (m.role === 'user' && m.text) msgs.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant' && m.text) msgs.push({ role: 'assistant', content: m.text });
    // System rows are Legion's own: notices, and the compaction summary. They are carried through as system messages so
    // the summary written into the thread by an earlier turn is found again here.
    else if (m.role === 'system' && m.text) msgs.push({ role: 'system', content: m.text });
    else if (m.role === 'tool' && m.toolName && m.toolUseId && !m.resultFor) {
      let args = '{}';
      try { args = JSON.stringify(JSON.parse(m.text)); } catch { /* clipped when stored: the arguments are not needed again */ }
      msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: m.toolUseId, type: 'function', function: { name: m.toolName, arguments: args } }] });
      open.add(m.toolUseId);
    } else if (m.role === 'tool' && m.resultFor && open.has(m.resultFor)) {
      msgs.push({ role: 'tool', content: m.text, tool_call_id: m.resultFor });
      open.delete(m.resultFor);
    }
  }
  return msgs.filter((m) => !(m.tool_calls && open.has(m.tool_calls[0]!.id)));
}

/** How many tokens the summary already sitting in the transcript claims, so a re-summary is not asked to grow it. */
function summaryTokensOf(summary: ChatMessage): number {
  const head = (summary.content ?? '').split('\n\n')[1] ?? '';
  return messagesTokens([{ role: 'assistant', content: head }]);
}

/**
 * The transcript to hand the summariser: the turns a new summary has to cover, plus the previous summary when there is
 * one.
 *
 * The previous summary goes in rather than being dropped, because a second compaction in the same thread has to fold the
 * new turns into what the first recorded — summarising the same ground from scratch would quietly discard whatever the
 * first pass decided, and that is exactly the decision the owner cannot afford to lose.
 */
export function summariserInput(middle: readonly ChatMessage[], existing: ChatMessage | null): string {
  const prior = existing ? existingSummaryBody(existing) : '';
  const fresh = renderTranscript(middle);
  if (!prior) return fresh;
  return `PREVIOUS SUMMARY OF EARLIER TURNS (fold the new turns into it; keep what is still true, replace what is no longer):\n\n${prior}\n\nNEW TURNS SINCE THAT SUMMARY:\n\n${fresh}`;
}

/** The summary text without the marker header Legion wraps around it. */
function existingSummaryBody(summary: ChatMessage): string {
  const content = summary.content ?? '';
  const split = content.indexOf('\n\n');
  return split >= 0 ? content.slice(split + 2) : content;
}

/**
 * The conversation body: what the plan keeps verbatim, with `summary` between head and tail.
 *
 * Three cases, and the differences are the design rather than incidental:
 *
 *  - over budget WITH a summary: head + summary + tail. The middle is represented, not dropped.
 *  - over budget WITHOUT one: the whole conversation, because a request the provider refuses for size is a visible,
 *    recoverable failure, whereas a silently shortened conversation looks like the model forgot. `compactOnce` is the
 *    only thing that decides this; nothing else calls it with a null summary while over budget.
 *  - under budget, but a summary already exists: the summary plus everything after it. The turns *behind* that summary
 *    are what it stands in for — re-sending them as well would spend the window on history the model has already been
 *    given, and would contradict the summary's own text, which tells the model those turns were compacted away.
 *  - under budget with no summary: everything, untouched.
 */

/** What `withSummary` needs: the two conversation halves and where the cut is. */
interface Summarisable {
  overBudget: boolean;
  /** Every stored row as provider messages, including any summaries already in the transcript. */
  all: ChatMessage[];
  /** The rows after the newest stored summary: the ground a new compaction would have to cover. */
  afterSummary: ChatMessage[];
  plan: CompactionPlan;
}

function withSummary(conv: Summarisable, summary: ChatMessage | null): ChatMessage[] {
  if (summary && isSummaryMessage(summary)) {
    // A summary already in the transcript: the history before it is represented, so it is not sent again.
    return conv.overBudget ? applyPlan(conv.afterSummary, conv.plan, summary) : [summary, ...conv.afterSummary];
  }
  if (!conv.overBudget) return [...conv.all];
  if (!summary) return [...conv.all];
  return applyPlan(conv.afterSummary, conv.plan, summary);
}

const textOf = (r: { content?: unknown }): string => {
  const parts = Array.isArray(r.content) ? r.content : [];
  const out = parts.map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : '[non-text content left out]'));
  return out.join('\n');
};
/**
 * Clip a tool result to `n` characters, keeping the TAIL.
 *
 * The tail, not the head. `agent-tools` truncates a long tool result to its last 12000 chars because the end of a verbose
 * result is where the answer is — the error, the row count, the last line of output. Clipping the head here undid exactly
 * that: a result that had already been trimmed to its most useful 12000 characters was then cut back to its first 12000,
 * which is the part the tool had already decided to throw away. The two limiters disagreed about which end mattered, and
 * the model received the least useful half of what the tool deliberately kept.
 *
 * The marker text names what was dropped, because a truncated result that says nothing about being truncated reads as
 * complete — and a model that trusts an incomplete result draws the wrong conclusion from it.
 */
const clipText = (s: string, n: number): string => {
  if (s.length <= n) return s;
  const tail = s.slice(-n);
  return `[truncated: last ${n} of ${s.length} chars]\n${tail}`;
};

export interface LoopOptions {
  maxTurns: number;
  maxToolCallsPerTurn: number;
  limits?: Partial<HttpLimits>;
  /** Replaces `chatTurn` in tests only. */
  turn?: typeof chatTurn;
  /** The model's context window in tokens. Absent means the conservative default. */
  contextWindow?: number;
}

/** The whole request, not one turn: what a single turn's tool output may add before it is clipped as a group. */
export const MAX_TURN_TOOL_CHARS = 40_000;

/** The share of the window a whole turn's tool output may spend, before the cap applies. */
export const TURN_BUDGET_WINDOW_FRACTION = 0.12;
/** The floor as a share of the window. Window-proportional on purpose: an absolute floor can outweigh the whole compaction threshold. */
export const TURN_BUDGET_FLOOR_FRACTION = 0.05;

/**
 * The character budget for one turn's tool output, derived from the model's context window.
 *
 * The cap is absolute — no turn may add more than MAX_TURN_TOOL_CHARS. The FLOOR is window-proportional and never
 * below one whole tool result: on a large window that keeps a single result from being clipped to nothing (the reason
 * the floor exists), while on a small window it scales down with the window so one turn's output cannot add a
 * multiple of the compaction threshold. The floor is capped first, because the outer `Math.max` would otherwise let a
 * floor larger than the cap defeat the cap.
 */
export function turnToolBudget(contextWindow: number): number {
  const window = Math.max(1, contextWindow);
  const ratio = Math.floor(window * TURN_BUDGET_WINDOW_FRACTION);
  const floor = Math.min(MAX_TURN_TOOL_CHARS, Math.max(MAX_TOOL_RESULT_CHARS, Math.floor(window * TURN_BUDGET_FLOOR_FRACTION)));
  return Math.max(floor, Math.min(MAX_TURN_TOOL_CHARS, ratio));
}

/**
 * The newest share of a conversation a rescue keeps verbatim. The pre-flight plan derives the tail from the window, which on
 * a large-window model can be the entire conversation; a rescue that then has nothing to summarise gives up and the run dies
 * on the provider's own error. Capping the tail by conversation SIZE instead of by window guarantees there is always
 * something to summarise, and it errs toward keeping the recent turns — which is where the work is.
 */
const RESCUE_TAIL_SHARE = 0.4;

/**
 * Compact the conversation as it stands RIGHT NOW, rather than as it stood when the run started.
 *
 * This is the function the pre-flight compaction cannot be. `host.stored` is a snapshot taken before the run, so a plan
 * built from it covers the conversation the model was handed — not the tool output the model has produced since. On a long
 * tool-using run those are the largest and newest turns, and dropping them is exactly the "the model forgot" failure the
 * whole feature exists to prevent.
 *
 * The tail is always kept, so the most recent exchange survives verbatim; what is summarised is the older middle. Returns
 * null when nothing smaller could be produced, which is also "send unchanged" — the transcript is append-only, so a
 * request the provider refuses for size is a visible, recoverable failure, whereas a silently shortened conversation is not.
 */
async function compactMessages(
  turnFn: typeof chatTurn, target: ProviderTarget, model: string, opts: LoopOptions,
  host: ProviderHost, redact: (s: string) => string, live: readonly ChatMessage[], window: number, allowRetry: boolean, hard: boolean,
): Promise<ChatMessage[] | null> {
  const taskId = host.taskId;
  const blocked = compactionGuard.blockedReason(taskId);
  if (blocked) {
    host.onNotice(blocked === 'cooldown'
      ? 'This conversation is over the model\'s context window and Legion is waiting before trying to summarise again. Nothing was lost — the full transcript is still here.'
      : 'Summarising this conversation twice in a row did not make it smaller, so Legion stopped trying for now. Nothing was lost — the full transcript is still here.');
    return null;
  }
  // The system prompt is Legion's, not the conversation's, so it must survive compaction intact.
  const system = live[0]?.role === 'system' ? live[0]! : { role: 'system' as const, content: host.systemPrompt };
  const conv = live.slice(1);
  // Plan against the LIVE conversation, and plan it HARD.
  //
  // The old code called `conversationFor(host)`, which re-read `host.stored` — the PRE-RUN snapshot. That is where the data
  // loss came from: tool results this run produced are not in the snapshot, so a rescue built from it threw away the work the
  // model had just done. Passing `messages` fixes that. `head + summary + tail` follows, so the tail — which IS the work —
  // survives instead of being replaced by the summary alone.
  //
  // `force` + `protectFirst: 0` is what makes the retry actually smaller. Without them the plan protects the opening turns
  // and gives the summary a generous budget, so after a pre-flight compaction — where `messages` is already short — the new
  // summary came out LARGER than the two messages it replaced (measured: 1095 tokens before, 1401 after), the rescue
  // correctly declined, and the run died on the provider's error. A rescue has already had its one chance and its whole
  // purpose is minimum size, so it protects nothing and asks for a short summary.
  let plan = planCompaction(conv, { window, protectFirst: hard ? 0 : PROTECT_FIRST, force: hard });
  // A plan can still leave NO middle, because the tail budget scales with the window and on a large-window model the whole
  // conversation counts as "recent". Measured: window 200k, six messages, tailStart 0 — nothing to summarise, so the rescue
  // gave up and the run died.
  //
  // The rescue's job is to produce SOMETHING smaller, and the provider has already said this request does not fit. So when
  // the plan protects everything, cap the tail to a fixed share of the conversation. This is the one place that overrides the
  // plan, and it is safe because it only moves messages INTO the middle, where they are summarised rather than dropped.
  if (hard && plan.middle.length === 0 && conv.length > 2) {
    // A share of the conversation, not of the window. Deliberately smaller than the plan's own 1.5x slack for keeping a
    // tool group whole: with only a few messages and one multi-call group, a loose cap lets that group claim the entire
    // tail, the middle ends up empty, and the rescue declines. The slack exists to avoid splitting a group by a few tokens;
    // here the provider has already refused, so keeping the group is negotiable and shrinking is not.
    plan = planCompaction(conv, {
      window,
      protectFirst: 0,
      force: true,
      tailBudget: Math.max(1, Math.floor(messagesTokens(conv) * RESCUE_TAIL_SHARE * 0.5)),
    });
  }
  // An empty middle means the cut would replace nothing, so there is nothing to summarise.
  const middle = plan.middle;
  if (middle.length === 0) return null;
  // The NEWEST summary, not the first one found. `readConversation` walks backwards for exactly this reason: after a second
  // compaction inside one run the conversation carries two summary rows, and folding the older one in would replace a
  // summary of a summary — losing everything the newer summary had already absorbed.
  let summaryIdx = -1;
  for (let i = conv.length - 1; i >= 0; i--) if (isSummaryMessage(conv[i]!)) { summaryIdx = i; break; }
  const existing = summaryIdx >= 0 ? conv[summaryIdx]! : null;
  let body = '';
  try {
    const r = await turnFn(target, {
      model,
      messages: [
        { role: 'system', content: summaryPrompt(summariserInput(middle, existing), plan.summaryBudget) },
        { role: 'user', content: 'Produce the summary now.' },
      ],
      tools: [],
      signal: host.signal,
      ...(opts.limits ? { limits: opts.limits } : {}),
      onText: () => undefined,
    });
    body = sanitizeSummary(r.text, redact);
  } catch (e) {
    if (host.cancelled() || (e instanceof ProviderHttpError && e.code === 'aborted')) throw e;
    compactionGuard.noteFailure(taskId);
    host.onNotice('Legion could not summarise this conversation, so it was sent in full. Nothing was lost; if it no longer fits, the task will report the provider\'s own error.');
    return null;
  }
  const usedFallback = body.length < 40;
  const summary = clipToTokens(usedFallback ? localFallbackSummary(middle, plan.summaryBudget) : body, plan.summaryBudget);
  const row = renderSummaryRow(summary, { dropped: middle.length, fallback: usedFallback });
  host.onNotice(row.content ?? '');
  const out: ChatMessage[] = [system, ...applyPlan(conv, plan, row)];
  // Drop a head that ends on unanswered tool calls.
  // The plan protects the first PROTECT_FIRST messages, and on a mid-run refusal that head is
  // [user, assistant(tool_calls)] while the tool RESULTS fall in the middle. What goes out is then an assistant
  // message with tool_calls and no matching tool result — a sequence every OpenAI-compatible endpoint rejects with a
  // 400 that is NOT a context-length error, so the retry dies on it.
  //
  // Dropping the call loses nothing that matters: the summary covers the middle, and the results themselves are in the
  // transcript. What it costs is the model no longer sees its own unanswered request, which is exactly right — the
  // conversation it is being handed is a new one that begins after that work.
  while (out.length > 1) {
    const last = out[out.length - 1]!;
    if (last.role !== 'assistant' || !last.tool_calls?.length) break;
    const answered = last.tool_calls.every((c) => out.some((m) => m.role === 'tool' && m.tool_call_id === c.id));
    if (answered) break;
    out.pop();
  }
  const before = messagesTokens([...conv, { role: 'user', content: host.prompt }]);
  const after = messagesTokens([...out, { role: 'user', content: host.prompt }]);
  compactionGuard.noteCompaction(taskId, after < before, usedFallback);
  // A summary that did not make the request smaller is worse than none: it costs a turn and buys nothing.
  //
  // This is a real limit, not a formality. On a short conversation the summary is LONGER than what it replaces — the
  // template alone is bigger than three short messages — so there is genuinely nothing to gain and returning null is
  // correct. The caller then rethrows the provider's own error, which is the honest outcome: a provider that refuses a
  // request this small is refusing for a reason compaction cannot fix.
  return after < before ? out : null;
}

/**
 * One compaction attempt: summarise the middle, write the summary into the thread, hand back what to send.
 *
 * The ordering here is the whole design. If the summary cannot be produced the conversation goes out UNCHANGED — not
 * truncated, not trimmed — because the transcript is append-only and the request will simply be refused for size, which
 * is a recoverable failure the owner can see, whereas a silently shortened conversation looks like the model forgot.
 * The local fallback exists for the case where we must send something smaller than we were given: it is worse than a real
 * summary and is labelled as such, so the model does not treat extracts as history.
 *
 * Returns null when compaction was refused (cooldown, or the breaker), which is also "send unchanged".
 */
async function compactOnce(
  turnFn: typeof chatTurn, target: ProviderTarget, model: string, opts: LoopOptions,
  host: ProviderHost, redact: (s: string) => string, conv: ReturnType<typeof conversationFor>, force: boolean,
): Promise<{ summary: ChatMessage | null; overBudget: boolean }> {
  const taskId = host.taskId;
  if (conv.middle.length === 0) return { summary: conv.existing, overBudget: conv.overBudget };
  const blocked = compactionGuard.blockedReason(taskId);
  if (blocked && !force) {
    host.onNotice(blocked === 'cooldown'
      ? 'This conversation is over the model\'s context window and Legion is waiting before trying to summarise again. Nothing was lost — the full transcript is still here.'
      : 'Summarising this conversation twice in a row did not make it smaller, so Legion stopped trying for now. Nothing was lost — the full transcript is still here.');
    return { summary: null, overBudget: conv.overBudget };
  }
  let body = '';
  try {
    const r = await turnFn(target, {
      model,
      messages: [
        { role: 'system', content: summaryPrompt(summariserInput(conv.middle, conv.existing), conv.plan.summaryBudget) },
        { role: 'user', content: 'Produce the summary now.' },
      ],
      tools: [],
      signal: host.signal,
      ...(opts.limits ? { limits: opts.limits } : {}),
      onText: () => undefined,
    });
    body = sanitizeSummary(r.text, redact);
  } catch (e) {
    if (host.cancelled() || (e instanceof ProviderHttpError && e.code === 'aborted')) throw e;
    compactionGuard.noteFailure(taskId);
    host.onNotice('Legion could not summarise this conversation, so it was sent in full. Nothing was lost; if it no longer fits, the task will report the provider\'s own error.');
    return { summary: null, overBudget: conv.overBudget };
  }
  const usedFallback = body.length < 40;
  const summary = clipToTokens(usedFallback ? localFallbackSummary(conv.middle, conv.plan.summaryBudget) : body, conv.plan.summaryBudget);
  const row = renderSummaryRow(summary, { dropped: conv.middle.length, fallback: usedFallback });
  // Into the transcript, not just into this request: the next turn has to start from the same summary, and the owner has
  // to be able to read what the model was actually told.
  host.onNotice(row.content ?? '');
  // Effective means the request got smaller. A summary that did not shrink anything would re-trigger the threshold on
  // every following turn, so it counts against the breaker instead of counting as progress.
  const ask: ChatMessage = { role: 'user', content: host.prompt };
  const before = messagesTokens([...conv.all, ask]);
  const after = messagesTokens([...withSummary({ ...conv, overBudget: true }, row), ask]);
  compactionGuard.noteCompaction(taskId, after < before, usedFallback);
  return { summary: row, overBudget: after > thresholdTokens(opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW, toolsTokens([])) };
}

export async function runToolLoop(host: ProviderHost, target: ProviderTarget, model: string, opts: LoopOptions, redact: (s: string) => string): Promise<ProviderRunResult> {
  const turnFn = opts.turn ?? chatTurn;
  const res: ProviderRunResult = { subtype: 'success', isError: false, turns: 0, usageUnknown: false };
  let usage: TokenUsage | undefined;
  const addUsage = (r: ChatTurnResult) => {
    if (r.usage) usage = { inputTokens: (usage?.inputTokens ?? 0) + r.usage.inputTokens, outputTokens: (usage?.outputTokens ?? 0) + r.usage.outputTokens };
    else res.usageUnknown = true;
  };
  const tools = await connectTools(host.servers, host.onNotice, host.external);
  const used = new Set<string>();
  const fails = new Map<string, number>();
  let noticedRefused = false;
  try {
    const window = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    // A pre-flight check, not a rescue: at the threshold the conversation is cut before the request is made.
    //
    // `rescued` is its own flag and must NOT be set by the pre-flight compaction. They answer different questions: one
    // asks "has a summary been produced", the other "has the retry been spent". Sharing a flag looks tidier and is a trap
    // — a pre-flight compaction sets it, so the run can never retry, and the retry is needed precisely when the pre-flight
    // check was wrong and the provider refused a conversation the estimator believed fit. That failure is invisible in
    // testing, where the estimator is usually right, and fatal in production.
    let conv = conversationFor(host, { window, tools: tools.specs });
    let rescued = false;
    let summaryRow = conv.existing;
    if (conv.overBudget) {
      // The summary is passed back in rather than read from `host.stored`, which is a snapshot taken before this run
      // wrote it. Reading the snapshot would find nothing and compact the same ground again on the next turn.
      summaryRow = (await compactOnce(turnFn, target, model, opts, host, redact, conv, false)).summary;
    }
    let messages: ChatMessage[] = [conv.system, ...withSummary(conv, summaryRow), { role: 'user', content: host.prompt }];
    let lastText = '';
    // A whole turn's tool output may add at most this much, via turnToolBudget. Scaled to the window because a fixed
    // number is wrong at both ends: 40k is noise on a 1M-token model, and most of a small model's request. The floor
    // matters as much as the ratio - a budget smaller than ONE result deletes that result, which is worse than any
    // overflow - but the floor must be window-proportional too, or it outweighs the whole compaction threshold on a
    // small model. See turnToolBudget for the shape and the arithmetic at both ends.
    const turnBudget = turnToolBudget(opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
    let spent = 0;
    for (let turn = 1; turn <= opts.maxTurns; turn++) {
      spent = 0;
      if (host.cancelled()) return { ...res, subtype: 'cancelled', usage };
      res.turns = turn;
      let r: ChatTurnResult;
      try {
        r = await turnFn(target, { model, messages, tools: tools.specs, signal: host.signal, limits: opts.limits, onText: host.onDelta });
      } catch (e) {
        // The provider refused the request for size. That is the one error worth a second attempt: compact hard and retry
        // ONCE. Retrying without compacting fails identically, and retrying more than once turns one refusal into a loop
        // the owner pays for.
        if (!isContextLengthError(e) || rescued) throw e;
        rescued = true;
        // The LIVE conversation, not host.stored. On a mid-run refusal the snapshot is missing every tool result this
        // run produced, so compacting from it and retrying restarts the task from the original question — the model is
        // asked again for work it has already done. `messages` holds what actually happened.
        const forced = await compactMessages(turnFn, target, model, opts, host, redact, messages, window, true, true);
        if (!forced) throw e; // nothing smaller to send; the original error is the honest one to report
        messages = forced;
        r = await turnFn(target, { model, messages, tools: tools.specs, signal: host.signal, limits: opts.limits, onText: host.onDelta });
      }
      addUsage(r);
      if (r.toolsRefused && !noticedRefused) { noticedRefused = true; host.onNotice('This model did not accept tools: it can answer, but it cannot use Legion\'s tools.'); }
      const text = redact(r.text).trim();
      if (text) { host.onAssistantText(text); lastText = text; }
      if (r.toolCalls.length === 0) {
        // "Empty answer" used to be the whole message, which is why a real cause reached the owner as a shrug: a model
        // that spends its whole budget reasoning, one that was cut at its output limit, and one whose tool calls Legion
        // failed to parse all landed on the same sentence. Say which.
        if (!text) {
          return {
            ...res, usage, isError: true, subtype: 'error_during_execution',
            errorText: emptyAnswerReason(r.finishReason, res.turns),
          };
        }
        if (r.finishReason === 'length') host.onNotice('The reply may be cut off: the model stopped at its output limit.');
        return { ...res, usage, resultText: text };
      }
      // The window was checked once, before turn 1. Everything since then is tool output the check never saw, so a run
      // can grow past the window entirely inside itself. Checked here, on the LIVE conversation, and summarised when
      // over — otherwise the only thing left is the rescue below, which is a failed request away.
      messages.push({ role: 'assistant', content: r.text || null, tool_calls: r.toolCalls.map((c, i) => ({ ...c, id: used.has(c.id) ? `${c.id}_${turn}_${i}` : c.id })) });
      const calls = messages[messages.length - 1]!.tool_calls!;
      for (const c of calls) used.add(c.id);
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;
        const name = call.function.name;
        let out: { text: string; isError: boolean };
        if (host.cancelled()) return { ...res, subtype: 'cancelled', usage };
        let input: Record<string, unknown> = {};
        let parseFailed = false;
        if (call.function.arguments.length > MAX_ARG_BYTES) { parseFailed = true; }
        else if (call.function.arguments.trim()) {
          try { const v = JSON.parse(call.function.arguments); if (v && typeof v === 'object' && !Array.isArray(v)) input = v as Record<string, unknown>; else parseFailed = true; } catch { parseFailed = true; }
        }
        host.onToolCall(name, call.id, input);
        const entry = tools.offered.get(name);
        if (i >= opts.maxToolCallsPerTurn) out = { text: `Error: too many tool calls in one turn (limit ${opts.maxToolCallsPerTurn}); this one was not run.`, isError: true };
        else if (!entry) out = { text: `Error: ${name.slice(0, 80)} is not a tool you have. Your tools are: ${[...tools.offered.keys()].slice(0, 40).join(', ') || 'none'}.`, isError: true };
        else if (parseFailed) out = { text: 'Error: the arguments were not a JSON object within the size limit; the tool was not run.', isError: true };
        else {
          host.noteToolUse(name, call.id, input);
          const decision = await host.authorize(name, input);
          if (host.cancelled()) return { ...res, subtype: 'cancelled', usage };
          if (!decision.allow) out = { text: decision.message || 'The user denied this action.', isError: true };
          else {
            try {
              const r = await entry.client.callTool({ name: entry.remote, arguments: input }, undefined, { signal: host.signal, timeout: 3_600_000 });
              out = { text: textOf(r as { content?: unknown }), isError: (r as { isError?: boolean }).isError === true };
            } catch (e) {
              if (host.cancelled()) return { ...res, subtype: 'cancelled', usage };
              out = { text: `Error: ${e instanceof Error ? e.message.slice(0, 300) : 'the tool failed'}`, isError: true };
            }
          }
        }
        const shown = redact(clipText(out.text, MAX_TOOL_RESULT_CHARS));
        // Clipping each result is not enough: sixteen results at the cap is ~190k chars added by ONE turn, which is the
        // overflow this whole feature exists to prevent arriving through the back door. So the turn gets its own budget
        // and later results are clipped harder to fit inside it.
        //
        // Later results are cut rather than earlier ones because a turn's results are read in order, and the tail of a
        // tool turn is the most recent evidence - the part the model's next decision rests on.
        //
        // `spent` is charged with what is actually SENT, not with the full length: charging the unclipped length makes
        // the first oversized result consume the entire budget and every result after it arrives empty.
        const room = Math.max(0, turnBudget - spent);
        const bounded = room <= 0 ? '(this turn\u2019s tool output budget was used up; earlier results in this turn are above)'
          : shown.length > room ? clipText(shown, room)
          : shown;
        spent += bounded.length;
        host.onToolResult(call.id, bounded);
        messages.push({ role: 'tool', content: bounded || '(no output)', tool_call_id: call.id });
        const key = `${name}\n${call.function.arguments}`;
        if (out.isError) {
          const n = (fails.get(key) ?? 0) + 1; fails.set(key, n);
          if (n >= REPEAT_FAIL_LIMIT) return { ...res, usage, isError: true, subtype: 'error_during_execution', errorText: 'The model kept repeating a failing tool call, so Legion stopped the run.' };
        } else fails.delete(key);
      }
      // The re-check, on the conversation as it now stands. Done here, after the results are in, because that is the
      // first moment the growth is real.
      //
      // It summarises the LIVE messages rather than the pre-run snapshot. That is the whole difference: `host.stored`
      // was captured before this run, so a compaction built from it would drop every tool result produced since — the
      // work the model just did, silently, mid-task. This is the only place that can compact the run's own work.
      if (needsCompaction(messages, window, toolsTokens(tools.specs))) {
        const live = await compactMessages(turnFn, target, model, opts, host, redact, messages, window, !rescued, false);
        if (live) messages = live;
      }
    }
    return { ...res, usage, isError: true, subtype: 'error_max_turns', errorText: `Stopped after ${opts.maxTurns} model turns without a final answer.`, ...(lastText ? { resultText: lastText } : {}) };
  } catch (e) {
    if (host.cancelled() || (e instanceof ProviderHttpError && e.code === 'aborted')) return { ...res, subtype: 'cancelled', usage };
    return { ...res, usage, isError: true, subtype: 'error_during_execution', errorText: redact(e instanceof Error ? e.message : String(e)).slice(0, 400) };
  } finally {
    await tools.close();
  }
}
