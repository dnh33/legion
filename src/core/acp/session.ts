/**
 * One ACP session over an agent process: handshake, a prompt turn with streamed updates, permission requests handed to a callback,
 * cancel, a watchdog, and token deltas. No engine wiring here; the engine drives it (`AcpSession.open`, then `prompt` per turn).
 * Wire shapes (camelCase): https://agentclientprotocol.com initialization, session-setup, prompt-turn, tool-calls, agent-plan, session-modes.
 * What Hermes does on top: acp_adapter/gateway_server.py (new_session, _resume, prompt, cancel, set_session_model/mode), permissions.py,
 * server.py:1019 (set_model). `session/set_model`, `models` in session replies and `usage` in the prompt reply are not on the stable spec
 * pages; they come from the Hermes source above.
 */
import { VERSION } from '../../shared/config.js';
import type { TodoItem } from '../../shared/types.js';
import type { TokenDelta } from '../../shared/acp-view.js';
import type { AgentProcess } from './process.js';
import { mapPermission, mapPlan, mapToolCall, type MappedPermission, type MappedTool } from './map.js';
import { RpcClosed, RpcError, RpcPeer } from './rpc.js';
import { HERMES_TOO_MANY_ASKS_TEXT } from './texts.js';

export type { MappedPermission, MappedTool } from './map.js';

/** An ACP stdio MCP server entry (McpServerStdio: name, command, args, env as name/value pairs), as `session/new` takes it. */
export type AcpStdioServer = { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };

export type AcpRefusalReason = 'acp-version' | 'no-policy' | 'protocol-mismatch' | 'breakaway' | 'auth' | 'not-found';

/** The agent cannot be used as asked. `message` is the agent's own text where it gave one; the engine writes the words the user sees. */
export class AcpRefusal extends Error {
  constructor(readonly reason: AcpRefusalReason, message: string) {
    super(message);
    this.name = 'AcpRefusal';
  }
}

export interface AcpCallbacks {
  onText(delta: string): void;
  onThought(delta: string): void;
  onToolStart(t: MappedTool): void;
  onToolUpdate(t: MappedTool): void;
  /** Every plan update replaces the whole list. */
  onPlan(items: TodoItem[]): void;
  /** Answer with the agent's own optionId, or cancelled. An answer that comes after the request was withdrawn (cancel, watchdog) is dropped. */
  onPermission(r: MappedPermission): Promise<{ optionId: string } | { cancelled: true }>;
  /**
   * The tokens this turn used. Called at most once per turn, when the turn ends, with the same figure as `AcpTurnEnd.usage`:
   * use one of them, never both. The agent reports session-cumulative counters; this is the difference to the last report.
   */
  onUsage(deltaTokens: TokenDelta): void;
  /** A line for the thread about something Legion did on its own (a refused flood of requests). Called at most once per turn for each kind. */
  onNote?(text: string): void;
}

export interface AcpTurnEnd {
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'watchdog';
  /** Same figure as `onUsage`. Absent when the agent reported no usage. */
  usage?: TokenDelta;
  /** The agent's latest session-cumulative counters, as it reported them this turn. The caller stores them and passes them back as `usageBaseline` on resume. */
  cumulative?: TokenDelta;
  /** True when this turn's usage was counted as 0 because the session was resumed without a `usageBaseline`. */
  baselineUnknown?: true;
}

export interface AcpOpenInit {
  cwd: string;
  mcpServers: AcpStdioServer[];
  resumeId?: string;
  modelId?: string;
  mode?: 'default' | 'accept_edits' | 'dont_ask';
  /** The engine passes `watchdogMinutes * 60000`. No update and no open permission request for this long cancels the turn (an open request pauses it for at most `permissionPauseCapMs`). 0 turns it off. */
  watchdogMs: number;
  /** How long a cancelled turn may take to end before it is ended without the agent's answer. Default ACP_CANCEL_GRACE_MS. */
  cancelGraceMs?: number;
  /** How long an open permission request may pause the watchdog. Default ACP_PERMISSION_PAUSE_CAP_MS. */
  permissionPauseCapMs?: number;
  /** The agent's cumulative counters when the session was last used (`AcpTurnEnd.cumulative`). The first turn's delta is computed against it. */
  usageBaseline?: TokenDelta;
}

/** After session/cancel the agent gets this long to end the turn. */
export const ACP_CANCEL_GRACE_MS = 10_000;
/** Hermes denies a waiting approval itself after 300 s; the watchdog is paused for that long plus a small margin, then runs again. */
export const ACP_PERMISSION_PAUSE_CAP_MS = 305_000;
/** The most permission requests of one turn that may be open at once. Hermes asks one at a time; more than this is an agent gone wrong, and each open one holds a card for up to 300 s. */
export const ACP_MAX_OPEN_PERMISSIONS = 8;

// Per-method waits (Task 2 note: the peer's default is 30 s, too short for starting the agent's background service). A prompt has no limit; the watchdog guards it.
const WAIT_INITIALIZE_MS = 30_000;
const WAIT_SESSION_MS = 120_000;
const WAIT_SET_MODEL_MS = 60_000; // Hermes does network I/O when it switches a model (server.py set_session_model)
const WAIT_SET_MODE_MS = 30_000;
const WAIT_CLOSE_MS = 5_000; // best effort, after a failure
export const PROTOCOL_VERSION = 1;

type Rec = Record<string, unknown>;
const rec = (x: unknown): Rec | undefined => (x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Rec) : undefined);
const CANCELLED_OUTCOME = { outcome: { outcome: 'cancelled' } } as const;
const STOP_REASONS: readonly string[] = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'];

// What an agent's error text means. UNVERIFIED for the real Python ACP SDK: where it puts a handler exception's text (error.message or
// error.data.details), so both are searched. Markers: gateway_server.py:274, hermes_cli/gateway_runtime_start.py:79, gateway_client.py:307,
// gateway/session_a2a.py:162, gateway_server.py:443/562/624, acp_adapter/session.py:574, schema page (-32000 auth required, -32002 not found).
const MARKERS: Array<[AcpRefusalReason, RegExp]> = [
  ['breakaway', /windows_breakaway_unavailable/],
  ['no-policy', /acp_policy_unavailable/],
  ['protocol-mismatch', /gateway protocol mismatch|gateway_protocol_mismatch/i],
  ['not-found', /\bnot_found\b/],
  ['auth', /no llm provider configured|auth_required|authentication required/i],
];

/**
 * What was written to stderr after `before` was read. The tail is a rolling window, so its front may have been dropped since:
 * the longest end of `before` (whole lines only) that still starts `now` is the old part. Without any overlap everything is new.
 */
function stderrSince(before: string, now: string): string {
  const old = before.slice(0, before.lastIndexOf('\n') + 1);
  for (let d = 0; d < old.length; d += 1) {
    const kept = old.slice(d);
    if (now.startsWith(kept)) return now.slice(kept.length);
  }
  return now;
}

function refusalOf(e: unknown, stderr: () => string): AcpRefusal | undefined {
  if (e instanceof RpcError) {
    const details = rec(e.data)?.details;
    const own = typeof details === 'string' && details ? details : e.message;
    const haystack = `${e.message} ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data ?? '')}`;
    for (const [reason, re] of MARKERS) if (re.test(haystack)) return new AcpRefusal(reason, own);
    if (e.code === -32002) return new AcpRefusal('not-found', own);
    if (e.code === -32000) return new AcpRefusal('auth', own);
    return undefined;
  }
  // The agent could not even answer (it exited while starting its service): its own last words are on stderr.
  const tail = stderr();
  for (const [reason, re] of MARKERS) {
    if (reason === 'not-found') continue;
    const line = tail.split('\n').find((l) => re.test(l));
    if (line) return new AcpRefusal(reason, line.trim());
  }
  return undefined;
}

interface PendingPermission { settle(outcome: unknown): void }
interface Turn {
  cb: AcpCallbacks;
  tools: Map<string, MappedTool>;
  permIds: Set<string>;
  perms: Set<PendingPermission>;
  done: boolean;
  userCancelled: boolean;
  watchdogFired: boolean;
  cancelSent: boolean;
  /** The extra requests were refused and the note was sent. */
  floodNoted?: boolean;
  /** The open permission requests have paused the watchdog for the whole cap: it runs again while they stay open. */
  pauseExpired: boolean;
  watchdog?: NodeJS.Timeout;
  grace?: NodeJS.Timeout;
  pause?: NodeJS.Timeout;
  end(e: AcpTurnEnd): void;
}

interface SessionConfig { watchdogMs: number; graceMs: number; pauseCapMs: number; usageBaseline: TokenDelta; baselineUnknown: boolean }

export class AcpSession {
  private id = '';
  private version = '';
  private modelIds: string[] = [];
  private turn: Turn | undefined;
  private lastUsage: TokenDelta;
  /** A resumed session with no stored baseline: the first usage figure only becomes the baseline. */
  private baselineUnknown: boolean;

  private constructor(
    private readonly peer: RpcPeer,
    private readonly stderr: () => string,
    private readonly cfg: SessionConfig,
  ) {
    this.lastUsage = { ...cfg.usageBaseline };
    this.baselineUnknown = cfg.baselineUnknown;
    peer.onNotification('session/update', (params) => this.onUpdate(params));
    peer.onRequest('session/request_permission', (params) => this.onPermissionRequest(params));
    // No fs or terminal handlers: the client never advertises them, so a request for either gets "method not found".
  }

  get sessionId(): string { return this.id; }
  get agentVersion(): string { return this.version; }
  /** The model ids the agent offers, as it names them (pass one back as `modelId`). */
  get models(): string[] { return [...this.modelIds]; }

  /**
   * Handshake and a session: `initialize`, then `session/new` (or `session/resume`, else `session/load`, with the same MCP servers again),
   * then `session/set_model` and `session/set_mode` when asked. Throws AcpRefusal for an agent that cannot be used.
   * It never stops the process: the caller owns it and stops it after a failure.
   */
  static async open(p: AgentProcess, init: AcpOpenInit): Promise<AcpSession> {
    const peer = new RpcPeer(p.io, { requestTimeoutMs: WAIT_INITIALIZE_MS, onNoise: (line) => p.note?.(line) });
    const s = new AcpSession(peer, () => p.stderrTail(), {
      watchdogMs: init.watchdogMs,
      graceMs: init.cancelGraceMs ?? ACP_CANCEL_GRACE_MS,
      pauseCapMs: init.permissionPauseCapMs ?? ACP_PERMISSION_PAUSE_CAP_MS,
      usageBaseline: init.usageBaseline ?? { input: 0, output: 0 },
      baselineUnknown: init.resumeId !== undefined && init.usageBaseline === undefined,
    });
    const call = async (method: string, params: unknown, timeoutMs: number): Promise<unknown> => {
      const before = s.stderr(); // only what the agent writes while this call runs can be its reason
      try {
        return await peer.request<unknown>(method, params, timeoutMs);
      } catch (e) {
        throw refusalOf(e, () => stderrSince(before, s.stderr())) ?? e;
      }
    };

    const hello = rec(await call('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {}, // no fs, no terminal: the agent works in its own folder with its own tools
      clientInfo: { name: 'legion', title: 'Legion', version: VERSION },
    }, WAIT_INITIALIZE_MS));
    const theirs = hello?.protocolVersion;
    if (theirs !== PROTOCOL_VERSION) {
      throw new AcpRefusal('acp-version', `The agent speaks ACP version ${typeof theirs === 'number' ? theirs : 'unknown'}; Legion speaks version ${PROTOCOL_VERSION}.`);
    }
    s.version = typeof rec(hello?.agentInfo)?.version === 'string' ? (rec(hello?.agentInfo)!.version as string) : '';
    const caps = rec(hello?.agentCapabilities);
    const canResume = rec(rec(caps?.sessionCapabilities)?.resume) !== undefined;
    const canLoad = caps?.loadSession === true;
    const canClose = rec(rec(caps?.sessionCapabilities)?.close) !== undefined;

    let reply: unknown;
    if (init.resumeId !== undefined) {
      const method = canResume ? 'session/resume' : canLoad ? 'session/load' : undefined;
      if (!method) throw new AcpRefusal('not-found', 'The agent can neither resume nor load a session.');
      // session/load replays the history as updates before it answers; no turn is open yet, so the driver drops them.
      reply = await call(method, { sessionId: init.resumeId, cwd: init.cwd, mcpServers: init.mcpServers }, WAIT_SESSION_MS);
      if (reply === null || reply === undefined) throw new AcpRefusal('not-found', 'The agent does not know that session.');
      s.id = init.resumeId; // the reply has no sessionId; Hermes addresses the session by the id the client sent
    } else {
      reply = await call('session/new', { cwd: init.cwd, mcpServers: init.mcpServers }, WAIT_SESSION_MS);
      const sid = rec(reply)?.sessionId;
      if (typeof sid !== 'string' || sid === '') throw new Error('The agent did not give a session id.');
      s.id = sid;
    }
    const available = rec(rec(reply)?.models)?.availableModels;
    if (Array.isArray(available)) {
      s.modelIds = available.map((m) => rec(m)?.modelId).filter((m): m is string => typeof m === 'string' && m !== '');
    }
    try {
      if (init.modelId !== undefined) await call('session/set_model', { sessionId: s.id, modelId: init.modelId }, WAIT_SET_MODEL_MS);
      if (init.mode !== undefined) await call('session/set_mode', { sessionId: s.id, modeId: init.mode }, WAIT_SET_MODE_MS);
    } catch (e) {
      // A session this call just created would stay behind in the agent's daemon. Close it when the agent has a close; otherwise the
      // caller stops the process. A resumed session existed before and is not ours to close.
      if (init.resumeId === undefined && canClose) await peer.request('session/close', { sessionId: s.id }, WAIT_CLOSE_MS).catch(() => undefined);
      throw e;
    }
    return s;
  }

  /**
   * One prompt turn. Resolves when the agent ends it, when Legion cancels it, or when the watchdog does. Rejects when the connection
   * breaks (RpcClosed) or the agent answers with an error (AcpRefusal for the known ones, RpcError otherwise). One turn at a time.
   * After a watchdog end the prompt request is still open on the wire until the connection closes: stop the process.
   */
  async prompt(text: string, cb: AcpCallbacks): Promise<AcpTurnEnd> {
    if (this.turn) throw new Error('A turn is already running on this session.');
    let finish!: (e: AcpTurnEnd) => void;
    let fail!: (e: unknown) => void;
    const ended = new Promise<AcpTurnEnd>((res, rej) => { finish = res; fail = rej; });
    const turn: Turn = {
      cb, tools: new Map(), permIds: new Set(), perms: new Set(), done: false, userCancelled: false, watchdogFired: false, cancelSent: false,
      pauseExpired: false, end: (e) => finish(e),
    };
    this.turn = turn;
    this.armWatchdog(turn);
    const before = this.stderr(); // only what the agent writes during this turn can be its reason
    this.peer.request<unknown>('session/prompt', { sessionId: this.id, prompt: [{ type: 'text', text }] }, 0).then(
      (reply) => {
        if (turn.done) return;
        try { finish(this.endOf(reply, turn)); } catch (e) { fail(e); }
      },
      (e) => {
        if (turn.done) return;
        // After Legion's own cancel (user or watchdog) the agent may answer the prompt with an error (Hermes admitted_turn_failed) or the
        // connection may close: either way the turn is over because Legion ended it.
        if ((e instanceof RpcClosed || e instanceof RpcError) && (turn.watchdogFired || turn.userCancelled)) {
          finish({ stopReason: turn.watchdogFired ? 'watchdog' : 'cancelled' });
        } else fail(refusalOf(e, () => stderrSince(before, this.stderr())) ?? e);
      },
    );
    try {
      return await ended;
    } finally {
      this.retire(turn);
    }
  }

  /**
   * Ask the agent to stop the running turn: every open permission request is answered cancelled at once, then `session/cancel` is sent.
   * The turn ends when the agent answers, or after the grace period. Nothing happens when no turn is running.
   */
  async cancel(): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.done) return;
    if (!turn.userCancelled && !turn.watchdogFired) {
      turn.userCancelled = true;
      if (turn.watchdog) clearTimeout(turn.watchdog);
      turn.grace = setTimeout(() => turn.end({ stopReason: 'cancelled' }), this.cfg.graceMs);
    }
    this.sendCancel(turn);
  }

  // ---------------------------------------------------------------- turn plumbing

  private sendCancel(turn: Turn): void {
    for (const p of [...turn.perms]) p.settle(CANCELLED_OUTCOME); // the spec says MUST answer every pending request cancelled
    if (turn.cancelSent) return;
    turn.cancelSent = true;
    this.peer.notify('session/cancel', { sessionId: this.id });
  }

  private armWatchdog(turn: Turn): void {
    if (turn.watchdog) clearTimeout(turn.watchdog);
    turn.watchdog = undefined;
    if (turn.done || turn.watchdogFired || turn.userCancelled || this.paused(turn)) return;
    const ms = this.cfg.watchdogMs;
    if (!(ms > 0) || !Number.isFinite(ms)) return;
    turn.watchdog = setTimeout(() => {
      if (turn.done || this.paused(turn)) return;
      turn.watchdogFired = true;
      this.sendCancel(turn);
      turn.grace = setTimeout(() => turn.end({ stopReason: 'watchdog' }), this.cfg.graceMs);
    }, ms);
  }

  /** A waiting card is not a stuck agent, but only for so long: Hermes denies an unanswered approval itself and may never tell us. */
  private paused(turn: Turn): boolean {
    return turn.perms.size > 0 && !turn.pauseExpired;
  }

  private retire(turn: Turn): void {
    turn.done = true;
    if (turn.watchdog) clearTimeout(turn.watchdog);
    if (turn.grace) clearTimeout(turn.grace);
    if (turn.pause) clearTimeout(turn.pause);
    for (const p of [...turn.perms]) p.settle(CANCELLED_OUTCOME);
    if (this.turn === turn) this.turn = undefined;
  }

  private endOf(reply: unknown, turn: Turn): AcpTurnEnd {
    const r = rec(reply);
    const reason = r?.stopReason;
    if (typeof reason !== 'string' || !STOP_REASONS.includes(reason)) throw new Error(`The agent ended the turn with an unknown stop reason (${String(reason)}).`);
    const u = this.usageDelta(rec(r?.usage));
    if (u) safe(() => turn.cb.onUsage(u.delta));
    return {
      stopReason: turn.watchdogFired ? 'watchdog' : (reason as AcpTurnEnd['stopReason']),
      ...(u ? { usage: u.delta, cumulative: u.cumulative, ...(u.unknown ? { baselineUnknown: true as const } : {}) } : {}),
    };
  }

  /**
   * The agent's counters are cumulative over the session; the delta is the difference to the last figure (or to `usageBaseline`).
   * A counter that went down (a reset) starts over and reports 0 for that turn. A resumed session with no baseline reports 0 for the
   * first figure it sees and flags it, so the caller can say the count is unknown.
   */
  private usageDelta(u: Rec | undefined): { delta: TokenDelta; cumulative: TokenDelta; unknown: boolean } | undefined {
    if (!u) return undefined;
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
    const cur = { input: n(u.inputTokens), output: n(u.outputTokens) };
    const prev = this.lastUsage;
    this.lastUsage = cur;
    const cumulative = { ...cur };
    if (this.baselineUnknown) {
      this.baselineUnknown = false;
      return { delta: { input: 0, output: 0 }, cumulative, unknown: true };
    }
    const reset = cur.input < prev.input || cur.output < prev.output;
    return { delta: reset ? { input: 0, output: 0 } : { input: cur.input - prev.input, output: cur.output - prev.output }, cumulative, unknown: false };
  }

  private onUpdate(params: unknown): void {
    const p = rec(params);
    const turn = this.turn;
    // Other sessions (the agent's daemon is shared with other clients), updates between turns and the replay of a loaded history are not ours.
    if (!p || p.sessionId !== this.id || !turn || turn.done) return;
    const u = rec(p.update);
    if (!u) return;
    this.armWatchdog(turn);
    const cb = turn.cb;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const c = rec(u.content);
        if (c?.type === 'text' && typeof c.text === 'string' && c.text !== '') {
          const text = c.text;
          safe(() => (u.sessionUpdate === 'agent_message_chunk' ? cb.onText(text) : cb.onThought(text)));
        }
        return;
      }
      case 'tool_call':
      case 'tool_call_update': {
        const id = typeof u.toolCallId === 'string' ? u.toolCallId : '';
        if (turn.permIds.has(id)) return; // the update that closes a permission card; Legion keeps its own card state
        const prev = turn.tools.get(id);
        const mapped = mapToolCall(u, u.sessionUpdate === 'tool_call' ? undefined : prev);
        if (!mapped) return;
        turn.tools.set(id, mapped);
        safe(() => (u.sessionUpdate === 'tool_call' ? cb.onToolStart(mapped) : cb.onToolUpdate(mapped)));
        return;
      }
      case 'plan': {
        const items = mapPlan(u.entries);
        safe(() => cb.onPlan(items));
        return;
      }
      default:
        return; // usage_update (context size), available_commands_update, session_info_update, mode changes: nothing Legion needs
    }
  }

  private onPermissionRequest(params: unknown): Promise<unknown> {
    const p = rec(params);
    const turn = this.turn;
    // Never leave a request unanswered. Cancelled is "not a denial" to Hermes's gateway (gateway_server.py _answer_permission).
    if (!p || p.sessionId !== this.id || !turn || turn.done || turn.cancelSent) return Promise.resolve(CANCELLED_OUTCOME);
    const mapped = mapPermission(params);
    if (!mapped) return Promise.resolve(CANCELLED_OUTCOME);
    if (turn.perms.size >= ACP_MAX_OPEN_PERMISSIONS) {
      // an agent gone wrong could open hundreds of cards: past the cap a request gets the agent's own reject option at once (cancelled when it offers none)
      if (!turn.floodNoted) { turn.floodNoted = true; safe(() => turn.cb.onNote?.(HERMES_TOO_MANY_ASKS_TEXT)); }
      const reject = mapped.options.find((o) => o.kind === 'reject_once');
      return Promise.resolve(reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : CANCELLED_OUTCOME);
    }
    turn.permIds.add(mapped.requestId);
    if (turn.watchdog) { clearTimeout(turn.watchdog); turn.watchdog = undefined; } // a waiting card is not a stuck agent...
    const cap = this.cfg.pauseCapMs;
    if (turn.perms.size === 0 && cap > 0 && Number.isFinite(cap)) {
      turn.pause = setTimeout(() => { // ...for the cap at most; then the watchdog runs again
        turn.pause = undefined;
        turn.pauseExpired = true;
        this.armWatchdog(turn);
      }, cap);
    }
    return new Promise<unknown>((resolve) => {
      let settled = false;
      const pending: PendingPermission = {
        settle: (outcome) => {
          if (settled) return;
          settled = true;
          turn.perms.delete(pending);
          if (turn.perms.size === 0) {
            if (turn.pause) clearTimeout(turn.pause);
            turn.pause = undefined;
            turn.pauseExpired = false;
          }
          this.armWatchdog(turn);
          resolve(outcome);
        },
      };
      turn.perms.add(pending);
      this.armWatchdog(turn); // after the pause cap a further request must not leave the turn without a watchdog
      const offered = new Set(mapped.options.map((o) => o.optionId));
      new Promise<{ optionId: string } | { cancelled: true }>((res) => res(turn.cb.onPermission(mapped))).then(
        (answer) => pending.settle('optionId' in answer && offered.has(answer.optionId)
          ? { outcome: { outcome: 'selected', optionId: answer.optionId } }
          : CANCELLED_OUTCOME),
        () => pending.settle(CANCELLED_OUTCOME),
      );
    });
  }
}

/** A callback that throws must not break the stream of updates. */
function safe(fn: () => void): void {
  try { fn(); } catch { /* the caller's problem, not the protocol's */ }
}
