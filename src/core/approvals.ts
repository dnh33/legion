/** Human-in-the-loop tool approvals. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { BLENDER_EXEC_TOOL } from '../shared/blender.js';
import { BROWSER_SERVER_NAME, BROWSER_TOOLS } from '../shared/browser.js';
import { classifySafe, unknownConsequence } from '../shared/consequence.js';
import type { Consequence } from '../shared/consequence.js';
import { SITE_ANSWERS } from '../shared/types.js';
import type { ApprovalMode, ApprovalRequest, SiteAnswer } from '../shared/types.js';
import { newId, nowIso } from '../shared/util.js';
import type { EventBus } from './bus.js';
import { stricterMode } from './permission-mode.js';
import type { RunMode } from './permission-mode.js';
import { longestWaitSeconds, startAskTimer } from './away/policy.js';
import type { AskPolicy, AskTimer } from './away/policy.js';
import { ACP_CLOSED_NOTE, ACP_LATE_NOTE } from '../shared/acp-copy.js';

/** The run's own task list (TodoWrite, and the TaskCreate/Update/List/Get tools that replaced it) is notes, not an action: never carded. */
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Task', 'Agent']);
/**
 * Exported so test/gates.test.ts can assert the gate layer's `reads` group is exactly this set (plus the agent
 * shell's read tool): the two describe the same idea in two modules and must never drift apart.
 */
export const APPROVAL_READ_ONLY: ReadonlySet<string> = READ_ONLY;
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Legion's own in-process MCP servers: vm tools, the comms bridge, the knowledge graph, the project board, the house context layer and the guarded Blender bridge (it asks for its own approval inside the tool). */
export const LEGION_TOOL_PREFIXES = ['mcp__legion__', 'mcp__legion_comms__', 'mcp__legion_kg__', 'mcp__legion_board__', 'mcp__legion_house__', 'mcp__legion_armory__', 'mcp__legion_blender__', 'mcp__legion_connectors__'];
/** Legion's own in-process server names ("legion", "legion_comms", ...): a Settings MCP entry may not take one, its tools would pass for Legion's (no card, no taint). */
export const LEGION_SERVER_NAMES: ReadonlySet<string> = new Set(LEGION_TOOL_PREFIXES.map((p) => p.replace(/^mcp__/, '').replace(/__$/, '')));
const LEGION_TOOL_NAME = new RegExp(`^(?:${LEGION_TOOL_PREFIXES.join('|')})[a-z][a-z0-9_]*$`);
/**
 * One of Legion's own in-process tools: the exact server name, then a plain tool name. A prefix test alone also matches
 * "mcp__legion__x__run", a tool of some other server that happens to be called "legion__x"; its tool part holds "__".
 */
export function isLegionTool(toolName: string): boolean {
  return LEGION_TOOL_NAME.test(toolName) && !toolName.split('__').slice(2).join('__').includes('__');
}

/**
 * The browser tool's own tools (exact names). The module asks its own cards (first page, new site, script) with the page URL in them, so the generic
 * per-call card is not added on top. Deliberately NOT part of isLegionTool: the engine still taints the run on the first call.
 */
const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set(BROWSER_TOOLS.map((t) => `mcp__${BROWSER_SERVER_NAME}__${t}`));

// One rank table for every mode comparison: it lives in permission-mode.ts.
export { stricterMode };

/** VM tools that burn billing or hand a whole task to another Claude inside the VM. A run capped by another party (an MCP client, or a bot woken by one) needs a card for these. */
const CAPPED_CARDED = new Set(['mcp__legion__vm_exec', 'mcp__legion__vm_claude', 'mcp__legion__vm_desktop']);

/**
 * The mode a guard must judge by, and the one place that decides whether a guard shows a card at all.
 *
 * OWNER RULE (2026-10-04): **one rule, no exceptions — in `full` a guard never shows a card.** Every guard in
 * Legion goes through here, so a new guard cannot forget the mode the way four of them did (Blender exec and
 * asset, the comms room tools and the project board all asked unconditionally, so a full-access bot still got a
 * "Needs your OK" card; the browser module already did this correctly and was the proof the pattern was known).
 *
 * EXCEPTION (decided 2026-10-06, recorded 2026-10-07; docs/design/design-connectors.md 4.1 step 6): the connector gateway handlers
 * (src/core/connectors/gateway.ts, mcp__legion_connectors__) that write outward or spend raise their own card in EVERY mode, full
 * included, by calling `broker.request` directly. They are the only exception to the rule above. Do not "fix" them to go through
 * guardAsk. (Slice 1b shipped READ tools only. Since 2026-10-15 the six GitHub write tools are the carded handlers: src/core/connectors/github/write-tools.ts raises
 * ONE card per write through the gateway's `ask`, in `ask`, `auto-edits` and `full`, on the Claude path and the provider path, with no Remember, unless the registry says the card is off for the run (Bypass, or the owner's own switch).)
 * Second exception, maintainer decision 2026-10-07: WebFetch and WebSearch in a run that read connector data AND is tainted raise their own
 * card in every mode (Engine.webEgressCard), because web access can carry that data out.
 *
 * `modeOf` re-reads the store on EVERY call, so switching an agent from `ask` to `full` mid-task takes effect on
 * its next guarded call. A snapshot taken at run start would keep carding a bot the owner has just promoted.
 * `ceiling` (a run started by an MCP client or another bot) always wins over the agent's own setting — the
 * confused-deputy guard — so a promoted-but-capped run still asks.
 */
export interface GuardDecision {
  /** False when the run is `full` and uncapped: the caller must NOT ask, and must go straight to the action. */
  needsCard: boolean;
  /** The mode actually in force, for the reason a card was or was not shown. */
  mode: RunMode;
}

/** Reads the agent's live mode (for that task, when given) from the store. Returns undefined when the agent is gone. */
export type ModeOf = (agentId: string, taskId?: string) => RunMode | undefined;

/**
 * The one function a guard calls instead of asking on its own. `ask` is called only when a card is genuinely
 * required; a guard that skips this and calls `broker.request` directly is the bug this exists to prevent.
 *
 * `summary`/`input`/`origin`/`onTimeout` are forwarded untouched, so the card the owner sees is unchanged.
 */
export async function guardAsk(
  opts: {
    ceiling?: RunMode;
    /** The live store read. Omit only where no store is reachable; the agent's own setting is then used. */
    modeOf?: ModeOf;
    agentId: string;
    /** The task the guarded call belongs to, so a task-level mode (a goal's autonomy) is read, not only the agent's own. */
    taskId?: string;
    /** The agent's setting as it stood when the run started. Used only if `modeOf` cannot answer. */
    fallbackMode: RunMode;
    /** What the guarded call does. Smart asks only at level 3; with none given it asks (fails closed). */
    consequence?: Consequence;
    /** Shows the card and resolves with the owner's answer. Never called in `full`. */
    ask: () => Promise<boolean>;
  },
): Promise<boolean> {
  const live = opts.modeOf?.(opts.agentId, opts.taskId);
  const base = live ?? opts.fallbackMode;
  const effective = opts.ceiling ? stricterMode(base, opts.ceiling) : base;
  if (decideGuard(effective, opts.consequence).needsCard) return opts.ask();
  return true;
}

/**
 * Smart's card test: a level 3 ask (unknown is level 3 too), any ask that reaches the network (`net`), whatever its level, and a local build or
 * test run (`runs-code`) once an agent changed a build or script file in the project (`buildEdited`, only the engine's tool cards pass it).
 */
export const smartCards = (c: Consequence, buildEdited?: boolean): boolean => c.level >= 3 || c.tags.includes('net') || (buildEdited === true && c.tags.includes('runs-code'));

/** The pure half of `guardAsk`, split out so it can be asserted directly. `full` never cards; Smart cards per `smartCards`. */
export function decideGuard(mode: RunMode, consequence?: Consequence): GuardDecision {
  if (mode === 'full') return { needsCard: false, mode };
  if (mode === 'smart') return { needsCard: smartCards(consequence ?? unknownConsequence()), mode };
  // Ask, Accept edits and smart-edits: a module guard always cards (Accept edits already does)
  return { needsCard: true, mode };
}

/**
 * `capped`: the run has an approval ceiling from someone else (it came from an MCP client or was woken by another bot). Then vm_exec,
 * vm_claude and vm_desktop need a card even though they are Legion's own tools; everything else follows the mode as before.
 */
export function needsApproval(mode: RunMode, toolName: string, opts: { capped?: boolean; consequence?: Consequence; buildEdited?: boolean } = {}): boolean {
  if (opts.capped && CAPPED_CARDED.has(toolName)) return true;
  if (BROWSER_TOOL_NAMES.has(toolName)) return false;
  if (mode === 'full') return false;
  if (READ_ONLY.has(toolName) || isLegionTool(toolName)) return false;
  if (mode === 'smart') return smartCards(opts.consequence ?? unknownConsequence(), opts.buildEdited);
  // smart-edits (held by Smart and by Accept edits): an edit cards where Smart would (level 3), every other call cards where Accept edits would
  if (mode === 'smart-edits') return EDIT_TOOLS.has(toolName) ? (opts.consequence ?? unknownConsequence()).level >= 3 : true;
  if (EDIT_TOOLS.has(toolName)) return mode === 'ask';
  // Bash, other mcp__*, and unknown tools
  return true;
}

/**
 * Whether the engine's web check (a new site asks, a built-in docs or approved site opens) applies to this call: every mode but Bypass, for the two
 * web tools. It is not part of `needsApproval`: WebFetch and WebSearch stay read-only there, and the check raises its own card (Engine.askGuards).
 */
export function webChecksApply(mode: RunMode, toolName: string): boolean {
  return mode !== 'full' && webKind(toolName) !== undefined;
}

/**
 * Which built-in web tool a call counts as for the web check, the egress card and the gate rules: Legion's two provider tools (the owner's
 * optional web search and page read providers, src/core/web-search) are judged exactly like WebSearch and WebFetch. Exact names only: a tool of another server
 * that ends in the same words is not one.
 */
export function webKind(toolName: string): 'WebFetch' | 'WebSearch' | undefined {
  if (toolName === 'WebFetch' || toolName === 'mcp__legion__web_read') return 'WebFetch';
  if (toolName === 'WebSearch' || toolName === 'mcp__legion__web_search') return 'WebSearch';
  return undefined;
}

/**
 * The input of a web call in the shape the web check reads: a page address for the fetch kind, a query for the search kind. For the provider
 * tools only those two fields are carried (the TARGET address of a read, the query of a search); the built-in tools keep their input as it is.
 */
export function webInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (toolName === 'mcp__legion__web_read') return { url: typeof input?.url === 'string' ? input.url : '' };
  if (toolName === 'mcp__legion__web_search') return { query: typeof input?.query === 'string' ? input.query : '' };
  return input;
}

function compactJson(v: unknown, max: number): string {
  let s: string;
  try { s = JSON.stringify(v) ?? String(v); } catch { s = String(v); }
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const cap = (s: string) => (s.length > 400 ? s.slice(0, 399) + '…' : s);
  // every shell tool shows its command as written (the card and the activity log read it; JSON would hide it from the log scrub)
  if ((toolName === 'Bash' || toolName === 'PowerShell' || toolName === 'Monitor' || toolName === 'mcp__host__shell') && typeof input?.command === 'string') return cap(input.command);
  if ((toolName === 'Write' || toolName === 'Edit') && typeof input?.file_path === 'string') return cap(input.file_path);
  if (toolName === BLENDER_EXEC_TOOL && typeof input?.script === 'string') {
    const lines = input.script.split('\n');
    const first = lines.find((l) => l.trim() && !l.trim().startsWith('#'))?.trim() ?? '';
    return cap(`Blender script (${input.mode === 'live' ? 'LIVE' : 'sandbox'}, ${lines.length} lines): ${first}`);
  }
  return compactJson(input ?? {}, 400);
}

/** The wait as plain words for a message to the model or the owner: "10 minutes", "1 minute", "5 seconds". */
export function describeWait(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  if (secs < 60) return `${secs} second${secs === 1 ? '' : 's'}`;
  const mins = Math.round(secs / 60);
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

/**
 * The wait as the model should read it. Normally "10 minutes". When quiet hours paused the countdown the ask stayed open much longer,
 * and saying only "10 minutes" would be a false statement, so it says both.
 */
export function describeWaited(elapsedMs: number, baseMs: number): string {
  const base = describeWait(baseMs);
  if (elapsedMs <= baseMs + 90_000) return base;
  const mins = Math.round(elapsedMs / 60_000);
  const long = mins < 120 ? `${mins} minutes` : `${Math.round(mins / 60)} hours`;
  return `${base} of waiting (quiet hours paused the countdown, so it stayed open for ${long})`;
}

interface Pending { req: ApprovalRequest; resolve: (allow: boolean) => void; timer: AskTimer; alwaysRefusal?: string; /** Closes the card when the agent host stops waiting (a card raised inside one of its tool calls). */ deadline?: ReturnType<typeof setTimeout>; /** Stops listening for the call's cancel. */ detach?: () => void }

export { ACP_CLOSED_NOTE, ACP_LATE_NOTE } from '../shared/acp-copy.js';

/** How an agent host card ended: an option of the card, a plain no, or closed with no answer (deadline, cancel, the turn ended). */
export type AcpAnswer = { kind: 'option'; optionId: string } | { kind: 'denied' } | { kind: 'closed'; note: string; /** The card ran out of time or the host cancelled the call: the window keeps it in the thread (R60). Not set when the task ended. */ stays?: boolean };
interface AcpPending { req: ApprovalRequest; shown: ReadonlySet<string>; resolve: (a: AcpAnswer) => void; timer: ReturnType<typeof setTimeout> }
const CLOSED_KEPT = 200;
/** Only an allow option allows. A reject option, or a kind this code does not know, never does. */
const allows = (kind: string | undefined): boolean => kind === 'allow_once' || kind === 'allow_always';

export class ApprovalBroker {
  private readonly items = new Map<string, Pending>();
  /** Cards for requests of an agent host: they carry the agent's own options and a hard wait the quiet-hours policy cannot lengthen. */
  private readonly acp = new Map<string, AcpPending>();
  /** Cards that closed with no answer from the owner, kept so a late answer can be told why nothing happened. */
  private readonly closed = new Map<string, string>();
  /**
   * Cards that closed on their own and stay in the thread (R60), whole, so a window that was reloaded draws them again (R61). The window dismisses them
   * (`dismissClosed`); a task that was stopped or deleted, or begins a new turn after a finished one, takes its cards with it, as the window does.
   */
  private readonly kept = new Map<string, { card: ApprovalRequest; note: string; late?: string }>();
  /** Tasks seen to have finished: a turn that starts again for one of them drops its kept cards. */
  private readonly endedTasks = new Set<string>();
  /** The tool call an agent host is waiting for, seen by every card that call raises (it follows the call through its awaits). */
  private readonly scope = new AsyncLocalStorage<{ taskId: string; atMs: number; signal?: AbortSignal; ended: boolean }>();
  private readonly timeoutMs: number;
  /** How long a card waits for an answer before it is denied, in words ("10 minutes"). For messages that explain a timeout. */
  get timeoutWait(): string { return describeWait(this.timeoutMs); }
  /** The plain wait in milliseconds (before quiet hours lengthen it). */
  get waitMs(): number { return this.timeoutMs; }
  /**
   * The longest an ask can wait, in whole seconds: a hook that awaits a card must be given at least this long. With no policy it is the
   * plain wait. With one (quiet hours lengthen the wait, a hold adds a few seconds, a park wait can be up to 120 minutes) it is the longest of those.
   */
  get timeoutSeconds(): number { return longestWaitSeconds(this.timeoutMs, this.policy); }
  private policy?: AskPolicy;
  private readonly now?: () => number;
  constructor(private readonly bus: EventBus, opts?: { timeoutMs?: number; policy?: AskPolicy; now?: () => number }) {
    this.timeoutMs = opts?.timeoutMs ?? 10 * 60 * 1000;
    this.policy = opts?.policy;
    this.now = opts?.now;
    bus.on((e) => {
      if (e.type === 'task.deleted') { this.dropKept(e.taskId); this.endedTasks.delete(e.taskId); return; }
      if (e.type !== 'task.updated') return;
      const s = e.task.status;
      if (s === 'cancelled') { this.dropKept(e.task.id); this.endedTasks.delete(e.task.id); }
      else if (s === 'done' || s === 'error') this.endedTasks.add(e.task.id);
      else if (this.endedTasks.delete(e.task.id)) this.dropKept(e.task.id);
    });
  }

  private dropKept(taskId: string): void { for (const [id, k] of [...this.kept]) if (k.card.taskId === taskId) this.kept.delete(id); }

  /** The away module attaches its policy after the brokers are built. Absent: today's behaviour. */
  setPolicy(policy: AskPolicy | undefined): void { this.policy = policy; }

  request(
    taskId: string, agentId: string, toolName: string, input: Record<string, unknown>,
    origin?: ApprovalRequest['origin'],
    opts: {
      /** Called when the wait ends in a deny; gets how long the ask really stayed open (quiet hours make that longer than the wait). */ onTimeout?: (waitedMs?: number) => void; /** A written-out card text (a room request), instead of the compact JSON of the input. */ summary?: string; /** No "Remember" on this card. */ noRemember?: boolean;
      /** A web card: the site and whether Always allow is offered. The four answers go with it. */ site?: NonNullable<ApprovalRequest['site']>;
      /** Why "Always allow" is refused on this card (said back to the app that sent it). */ alwaysRefusal?: string;
      /** Called with the card as soon as it is open, so the caller knows its id (for `takeSite`). */ onOpen?: (req: ApprovalRequest) => void;
      /** The run's project (the engine knows it; a module that does not is asked of the policy by task). */ projectId?: string;
      /** What saying yes would do. Absent: worked out here from the tool and its input. */ consequence?: Consequence;
      /** The ask may be parked when its project is set to park (only the engine's own cards). Needs `onPark`. */ parkable?: boolean;
      /** Called when the ask is parked; the ask is then answered "no" so the waiting call returns. */ onPark?: () => void;
    } = {},
  ): Promise<boolean> {
    const projectId = opts.projectId ?? this.policy?.projectOf?.(taskId);
    const call = this.scope.getStore();
    const mine = call && call.taskId === taskId && !call.ended ? call : undefined; // work a call left running after it was decided is not part of it
    if (mine?.signal?.aborted) return Promise.resolve(false); // the agent host already cancelled this call: no card
    const closeAt = mine?.atMs;
    const req: ApprovalRequest = {
      id: newId('apr'), taskId, agentId, toolName,
      summary: opts.summary ?? summarizeToolInput(toolName, input), input, at: nowIso(),
      ...(origin ? { origin } : {}),
      ...(opts.noRemember ? { noRemember: true } : {}),
      ...(opts.site ? { site: opts.site } : {}),
      ...(projectId ? { projectId } : {}),
      consequence: opts.consequence ?? classifySafe({ kind: 'approval', toolName, input }),
      ...(closeAt !== undefined ? { expiresAt: new Date(closeAt).toISOString() } : {}),
    };
    const askedAt = (this.now ?? Date.now)();
    return new Promise<boolean>((resolvePromise) => {
      // the only automatic outcomes are "no" and "park" (which is also a "no" to the waiting call): there is no path to an allow here
      const timer = startAskTimer({
        baseWaitMs: this.timeoutMs, policy: this.policy, projectId, parkable: !!opts.parkable, now: this.now,
        onDeny: () => { try { opts.onTimeout?.((this.now ?? Date.now)() - askedAt); } catch { /* advisory */ } this.settle(req.id, false); },
        ...(opts.parkable && opts.onPark ? { onPark: () => { try { opts.onPark!(); } catch { /* advisory */ } this.settle(req.id, false); } } : {}),
      });
      // the agent host cuts the call at the deadline: the card closes then, and the caller is told no one answered (not that the owner said no)
      const deadline = closeAt !== undefined ? setTimeout(() => { try { opts.onTimeout?.((this.now ?? Date.now)() - askedAt); } catch { /* advisory */ } this.settle(req.id, false, ACP_CLOSED_NOTE); }, Math.max(0, closeAt - (this.now ?? Date.now)())) : undefined;
      deadline?.unref?.();
      // the agent host cancelled this one call: its card closes at once
      const onAbort = (): void => { this.settle(req.id, false, ACP_CLOSED_NOTE); };
      mine?.signal?.addEventListener('abort', onAbort, { once: true });
      const detach = mine?.signal ? () => mine.signal!.removeEventListener('abort', onAbort) : undefined;
      this.items.set(req.id, { req, resolve: resolvePromise, timer, ...(deadline ? { deadline } : {}), ...(detach ? { detach } : {}), ...(opts.alwaysRefusal ? { alwaysRefusal: opts.alwaysRefusal } : {}) });
      try { opts.onOpen?.(req); } catch { /* advisory */ }
      this.bus.emit({ type: 'approval.requested', approval: req });
    });
  }

  /**
   * The app is about to send an answer in the last seconds of an ask's wait: push the deadline out so the answer can land (spec 3.2).
   * Once per ask, a few seconds at most. It never answers the ask. False: unknown ask, or already held.
   */
  hold(id: string, ms: number): boolean { return this.items.get(id)?.timer.hold(ms) ?? false; }

  /**
   * The owner's answer. On a web card a yes may say how far it reaches (`site`): for good, for this goal, or this one call; no `site` means this one call.
   * A site answer on a No means nothing and is dropped. Throws (the route turns it into a 400, and the card stays open) for a site answer that is not one
   * of the three, on a card that is not a web card, or `always` where the card does not offer it. An unknown or closed card answers false and changes nothing.
   */
  resolve(id: string, allow: boolean, site?: SiteAnswer, optionId?: string): boolean {
    if (site !== undefined && !SITE_ANSWERS.includes(site)) throw new Error('The site answer must be always, goal or once.');
    const a = this.acp.get(id);
    if (a) {
      if (site !== undefined && allow) throw new Error('A site answer belongs on a web card.');
      const kindOf = (oid: string): string | undefined => a.req.acpOptions?.find((o) => o.optionId === oid)?.kind;
      if (!allow) {
        // a plain no sends the agent's own reject_once; a no that names one of the card's reject options (reject_always too) sends that one
        if (optionId === undefined) { this.settleAcp(id, { kind: 'denied' }); return true; }
        if (!a.shown.has(optionId)) throw new Error('That option is not on this card.');
        if (allows(kindOf(optionId))) throw new Error('That option allows it, so it cannot answer a no.');
        this.settleAcp(id, { kind: 'option', optionId });
        return true;
      }
      // an allow that names no option is a single allow: never the option that lasts
      const pick = optionId ?? a.req.acpOptions?.find((o) => o.kind === 'allow_once')?.optionId;
      if (pick === undefined) throw new Error('Choose one of the options on this card.');
      if (!a.shown.has(pick)) throw new Error('That option is not on this card.');
      this.settleAcp(id, { kind: 'option', optionId: pick });
      return true;
    }
    const p = this.items.get(id);
    if (!p) return false;
    if (site !== undefined && allow) {
      if (!p.req.site) throw new Error('A site answer belongs on a web card.');
      if (site === 'always' && !p.req.site.canAlways) throw new Error(p.alwaysRefusal ?? 'Always allow is not offered for this site.');
      this.sites.set(id, site);
    }
    return this.settle(id, allow);
  }

  /** The site answer that came with a card's yes (once: a second call gets nothing). Read right after the request settles. */
  takeSite(id: string): SiteAnswer | undefined {
    const s = this.sites.get(id);
    this.sites.delete(id);
    return s;
  }
  private readonly sites = new Map<string, SiteAnswer>();

  cancelForTask(taskId: string): void {
    for (const [id, p] of [...this.items]) if (p.req.taskId === taskId) this.settle(id, false);
    for (const [id, a] of [...this.acp]) if (a.req.taskId === taskId) this.settleAcp(id, { kind: 'closed', note: ACP_CLOSED_NOTE });
  }

  pending(): ApprovalRequest[] { return [...[...this.items.values()].map((p) => p.req), ...[...this.acp.values()].map((a) => a.req)]; }

  /** Why a card that has closed did not take an answer (an agent host stopped waiting), or undefined for a card that is open or unknown. */
  lateNote(id: string): string | undefined {
    const note = this.closed.get(id);
    const k = this.kept.get(id);
    if (note && k) k.late = note; // the only caller is an answer that came too late: a reloaded window shows that too
    return note;
  }

  /** The closed cards that stay in the thread, oldest first. The state snapshot carries them. */
  closedCards(): Array<{ card: ApprovalRequest; note: string; late?: string }> { return [...this.kept.values()].map((k) => ({ ...k })); }

  /** The owner dismissed a closed card. False when it is not kept (unknown, or already gone). */
  dismissClosed(id: string): boolean { return this.kept.delete(id); }

  /**
   * Run `fn` while an agent host waits for one tool call that must finish by `atMs`: a card that call raises meanwhile (by `request`) shows
   * that time and closes itself at it, because the host cuts the whole call then, card time included. Each call has its own time. When `signal`
   * aborts (the host cancelled this call) the card closes at once. Cards of other calls, and of other tasks, are not touched.
   */
  async withDeadline<T>(taskId: string, atMs: number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const call = { taskId, atMs, ended: false, ...(signal ? { signal } : {}) };
    try { return await this.scope.run(call, fn); } finally { call.ended = true; }
  }

  /**
   * A card for a request an agent host made. The card shows the agent's own title and the options in `options` (the caller has already left out
   * any it must not offer); the owner's answer names one of them. The wait is exactly `waitMs`: the host denies an unanswered request itself,
   * so quiet hours and `hold` cannot lengthen it. There is no Remember. Closing with no answer (the wait ended, a cancel) says why on the card.
   */
  requestAcp(
    taskId: string, agentId: string,
    o: { toolName: string; title: string; summary: string; input: Record<string, unknown>; options: Array<{ optionId: string; name: string; kind: string }>; waitMs: number; origin?: ApprovalRequest['origin']; projectId?: string; consequence?: Consequence },
  ): Promise<AcpAnswer> {
    const req: ApprovalRequest = {
      id: newId('apr'), taskId, agentId, toolName: o.toolName, summary: o.summary, input: o.input, at: nowIso(),
      ...(o.origin ? { origin: o.origin } : {}), noRemember: true, ...(o.projectId ? { projectId: o.projectId } : {}),
      consequence: o.consequence ?? classifySafe({ kind: 'approval', toolName: o.toolName, input: o.input }),
      acpOptions: o.options.map((x) => ({ ...x })), acpTitle: o.title, expiresAt: new Date((this.now ?? Date.now)() + o.waitMs).toISOString(),
    };
    return new Promise<AcpAnswer>((resolve) => {
      const timer = setTimeout(() => this.settleAcp(req.id, { kind: 'closed', note: ACP_CLOSED_NOTE, stays: true }), o.waitMs);
      timer.unref?.();
      this.acp.set(req.id, { req, shown: new Set(o.options.map((x) => x.optionId)), resolve, timer });
      this.bus.emit({ type: 'approval.requested', approval: req });
    });
  }

  private settleAcp(id: string, answer: AcpAnswer): boolean {
    const a = this.acp.get(id);
    if (!a) return false;
    this.acp.delete(id);
    clearTimeout(a.timer);
    if (answer.kind === 'closed') this.keepClosed(id, answer.stays ? { card: a.req, note: answer.note } : undefined);
    this.bus.emit({ type: 'approval.resolved', approvalId: id, allowed: answer.kind === 'option' && allows(a.req.acpOptions?.find((o) => o.optionId === answer.optionId)?.kind), ...(answer.kind === 'closed' ? { note: answer.note, ...(answer.stays ? { stays: true as const } : {}) } : {}) });
    a.resolve(answer);
    return true;
  }

  private keepClosed(id: string, stays?: { card: ApprovalRequest; note: string }): void {
    this.closed.set(id, ACP_LATE_NOTE);
    if (this.closed.size > CLOSED_KEPT) for (const k of this.closed.keys()) { this.closed.delete(k); if (this.closed.size <= CLOSED_KEPT) break; }
    if (!stays) return;
    this.kept.set(id, stays);
    if (this.kept.size > CLOSED_KEPT) for (const k of this.kept.keys()) { this.kept.delete(k); if (this.kept.size <= CLOSED_KEPT) break; }
  }

  private settle(id: string, allow: boolean, note?: string): boolean {
    const p = this.items.get(id);
    if (!p) return false;
    this.items.delete(id);
    p.timer.cancel();
    if (p.deadline) clearTimeout(p.deadline);
    p.detach?.();
    if (note) this.keepClosed(id, { card: p.req, note });
    this.bus.emit({ type: 'approval.resolved', approvalId: id, allowed: allow, ...(note ? { note, stays: true as const } : {}) });
    p.resolve(allow);
    return true;
  }
}
