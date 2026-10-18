/**
 * Shared rig for the gates tests (PR 2): a real Engine over a real gates core (signing with a fixed test key), one idle run, and the helpers
 * the engine, rail and web tests share. Built on away-rig's `setup`. A card is raised by the real approval broker and answered here.
 */
import { join } from 'node:path';
import { tempDir } from './tmp-cleanup.js';
import { setup } from './away-rig.js';
import { createGatesCore } from '../src/core/gates-settings/index.js';
import type { GatesCore } from '../src/core/gates-settings/index.js';
import type { Preset } from '../src/shared/gates-registry.js';
import type { ApprovalMode, GateRule } from '../src/shared/types.js';
import type { TaskOrigin } from '../src/shared/comms.js';
import type { RunMode } from '../src/shared/types.js';
import type { ModeResolver } from '../src/core/gates-settings/index.js';
import type { ActivityLog } from '../src/core/activity/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { ProviderKeys } from '../src/core/providers/secrets.js';
import { ADAPTERS } from '../src/core/web-search/adapters.js';
import { WebSearchService } from '../src/core/web-search/index.js';
import { defaultWebSearch } from '../src/shared/web-search-config.js';
import type { WebSearchConfig } from '../src/shared/web-search-config.js';

export const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** An idle scripted run: it starts, then waits until the test cancels it. */
export const idle = () => (async function* () {
  yield { type: 'system', subtype: 'init', session_id: 's1' };
  await new Promise<void>(() => undefined);
})();

type Decision = { allow: boolean; message?: string };
type Hook = (i: Record<string, unknown>) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | undefined>;
type HookEntry = { matcher?: string; hooks: Hook[] };

export interface RigOptions {
  /** The project's preset (absent: none, "Per agent"). */
  preset?: Preset;
  /** Whether the project caps its agents (default on). */
  limit?: boolean;
  /** The app preset (absent: Ask). */
  app?: Preset;
  /** The agent a1's own mode (default `ask`). */
  own?: ApprovalMode;
  /** a1 follows its project's preset instead of its own mode. */
  follow?: boolean;
  /** Gate overrides on the project, signed with the test key. */
  overrides?: Record<string, boolean>;
  /** The run is a helper woken by an outside app or another bot: the ceiling it carries. */
  ceiling?: RunMode;
  /** The run itself starts with that ceiling's origin, so its hooks and canUseTool (not only `call`) carry it. */
  originAtStart?: boolean;
  approvalTimeoutMs?: number;
  /** Names on the owner's keep list for the environment scrub (signed app file). */
  keep?: string[];
  /** The agent a1 has Legion's own host shell on. */
  host?: boolean;
  /** Task 28: a web search provider service over an in-memory key store and a fake fetch. Keys by id ('web:exa'); nothing here touches the network. */
  webSearch?: { cfg?: Partial<WebSearchConfig>; keys?: Record<string, string>; fetchImpl?: typeof fetch };
}

/** A fetch that answers every call with this JSON, and records what it was asked. */
export function fixtureFetch(json: unknown, headers: Record<string, string> = {}, status = 200): typeof fetch & { seen: Request[] } {
  const seen: Request[] = [];
  const f = (async (u: string | URL | Request, init?: RequestInit) => { seen.push(new Request(u as string, init)); return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } }); }) as typeof fetch & { seen: Request[] };
  f.seen = seen;
  return f;
}

export async function gatesRig(o: RigOptions = {}) {
  const wsCfg: WebSearchConfig = { ...defaultWebSearch(), ...(o.webSearch?.cfg ?? {}) };
  const wsKeys = new ProviderKeys(join(tempDir('legion-wskeys-'), 'providers', 'keys.json'));
  for (const [id, key] of Object.entries(o.webSearch?.keys ?? {})) wsKeys.set(id, key, ADAPTERS[id.replace(/^web:/, '') as keyof typeof ADAPTERS].origin(wsCfg)!);
  const ws = o.webSearch ? new WebSearchService({ config: () => wsCfg, keys: wsKeys, ...(o.webSearch.fetchImpl ? { fetchImpl: o.webSearch.fetchImpl } : {}) }) : undefined;
  const r = setup({ gatesCore: true, ...(ws ? { webSearch: ws } : {}), activity: true, approval: o.own ?? 'ask', script: idle, ...(o.approvalTimeoutMs ? { approvalTimeoutMs: o.approvalTimeoutMs } : {}) });
  const core = r.core as GatesCore;
  if (o.app) core.store.patchApp({ preset: o.app });
  if (o.keep) core.store.patchApp({ envKeep: o.keep });
  const body: Record<string, unknown> = {};
  if (o.preset) body.preset = o.preset;
  if (o.limit !== undefined) body.limit = o.limit;
  if (o.overrides) body.overrides = o.overrides;
  if (Object.keys(body).length) core.store.patchProject(r.project.id, body);
  const a1 = r.store.agents.get('a1')!;
  if (o.follow) a1.approvalSource = 'project';
  if (o.host) a1.host = { enabled: true } as never;
  const origin: TaskOrigin | undefined = o.ceiling ? ({ roomId: 'r1', fromAgentId: 'x1', hop: 0, approvalCeiling: o.ceiling }) : undefined;
  const task = r.start('a1', 'go', o.originAtStart && origin ? { origin } : {});
  await pause(120);
  const job = { taskId: task.id, agentId: 'a1', prompt: 'go', choice: 'auto', projectAtStart: r.project.id, trigger: 'ui', ...(origin ? { origin } : {}) } as never;
  const engine = r.engine as unknown as Record<string, (...a: unknown[]) => unknown>;

  /** The engine's decision for one tool call, exactly as `canUseTool` and the provider path make it. */
  const call = (toolName: string, input: Record<string, unknown>): Promise<Decision> =>
    (engine['toolDecider']!.call(r.engine, job, a1) as (t: string, i: Record<string, unknown>) => Promise<Decision>)(toolName, input);
  const pending = () => r.approvals.pending();
  /** Answers the oldest open card. */
  const answer = (allow: boolean): boolean => { const p = pending()[0]; return p ? r.approvals.resolve(p.id, allow) : false; };
  const tick = (ms = 25) => pause(ms);
  /** One tool call to the end: whether it raised a card (a card is answered "no" so nothing hangs), and what was decided. */
  const run = async (toolName: string, input: Record<string, unknown>) => {
    const p = call(toolName, input);
    await tick();
    const pend = pending()[0];
    const card = pend !== undefined;
    const noRemember = card && pend!.noRemember === true;
    if (card) answer(false);
    const d = await p;
    return { card, noRemember, allow: d.allow, message: d.message, summary: pend?.summary };
  };
  /** The PreToolUse hooks of the run's options (Claude path), in order; the ones whose matcher fits `toolName` answer. A card is answered "no". */
  const hook = async (toolName: string, input: Record<string, unknown>) => {
    const pre = ((r.calls[0]!.options as { hooks?: { PreToolUse?: HookEntry[] } }).hooks?.PreToolUse ?? []).filter((h) => !h.matcher || new RegExp(`^(?:${h.matcher})$`).test(toolName));
    let card = false; let decision: string | undefined;
    for (const h of pre) for (const fn of h.hooks) {
      const p = fn({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: input, tool_use_id: `u${Math.random()}` });
      await tick(30);
      if (pending().length) { card = true; answer(false); }
      const out = await p;
      const d = out?.hookSpecificOutput?.permissionDecision;
      if (d) { decision = d; if (d === 'deny') return { card, decision }; }
    }
    return { card, decision };
  };
  const setMode = (mode: ApprovalMode) => { r.store.agents.get('a1')!.approval = mode; };
  const setRules = (rules: GateRule[]) => { r.config.gates = { rules, presetsVersion: r.config.gates?.presetsVersion ?? 1 } as never; };
  /** The folder the run's project lives in. */
  const projectDir = (): string => r.projects.get(r.project.id)!.folder;
  /** Writes one gate override on the project through the signed store. */
  const setGateOverride = (id: string, value: boolean): void => { core.store.patchProject(r.project.id, { overrides: { ...(core.store.project(r.project.id).overrides ?? {}), [id]: value } }); };
  /** The engine's note of one tool use (taint and module feeds), as the stream and the hook do. */
  let n = 0;
  const noteUse = (toolName: string, input: Record<string, unknown>): void => {
    const act = (r.engine as unknown as { active: Map<string, unknown> }).active.get(task.id);
    (engine['noteToolUse']!.call(r.engine, job, act, toolName, `u${++n}`, input) as void);
  };
  /** The approval cards raised so far (every `approval.requested` event, answered or not). */
  const approvalEvents = (): number => r.events.filter((e) => e.type === 'approval.requested').length;
  /** Waits for `p`, answering every card that opens meanwhile with `allow`. Returns the result and the summaries of the cards it answered. */
  const settle = async <T>(p: Promise<T>, allow: boolean): Promise<{ out: T; summaries: string[] }> => {
    let done = false; const summaries: string[] = [];
    const all = p.then((v) => { done = true; return v; }, (e) => { done = true; throw e; });
    while (!done) { await tick(20); for (const c of pending()) { summaries.push(c.summary); r.approvals.resolve(c.id, allow); } }
    return { out: await all, summaries };
  };
  /**
   * Every PreToolUse hook of the run that fits `toolName`, started together with ONE tool use id, the way Claude Code runs them (all matching hooks in
   * parallel, deny over ask over allow). Each card is answered `allow` (default no). `cards` is the number of approval events the call raised.
   */
  const hookAll = async (toolName: string, input: Record<string, unknown>, ho: { allow?: boolean; id?: string } = {}) => {
    const pre = ((r.calls[0]!.options as { hooks?: { PreToolUse?: HookEntry[] } }).hooks?.PreToolUse ?? []).filter((h) => !h.matcher || new RegExp(`^(?:${h.matcher})$`).test(toolName));
    const id = ho.id ?? `u${++n}`;
    const before = approvalEvents();
    const { out, summaries } = await settle(Promise.all(pre.flatMap((h) => h.hooks).map((fn) => fn({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: input, tool_use_id: id }))), ho.allow ?? false);
    const ds = out.map((x) => x?.hookSpecificOutput?.permissionDecision).filter((d): d is string => !!d);
    const decision = ds.includes('deny') ? 'deny' : ds.includes('ask') ? 'ask' : ds.includes('allow') ? 'allow' : undefined;
    return { cards: approvalEvents() - before, decision, id, summaries };
  };
  /** The run's canUseTool for one call (with the tool use id the SDK passes), each card answered `allow`; `cards` as for hookAll. */
  const canUse = async (toolName: string, input: Record<string, unknown>, id: string, allow = false) => {
    const fn = (r.calls[0]!.options as { canUseTool: (t: string, i: Record<string, unknown>, o: unknown) => Promise<{ behavior: string; message?: string }> }).canUseTool;
    const before = approvalEvents();
    const { out, summaries } = await settle(fn(toolName, input, { signal: new AbortController().signal, toolUseID: id }), allow);
    return { cards: approvalEvents() - before, behavior: out.behavior, summaries };
  };
  /** A second run of the same agent, starting in the same project (or the project named): its own task and `Active`, the same engine and gates core. Each call to it is judged on its own job. */
  const freshRun = async (fo: { projectId?: string } = {}) => {
    const t = r.start('a1', 'again');
    await pause(120);
    const j = { taskId: t.id, agentId: 'a1', prompt: 'again', choice: 'auto', projectAtStart: fo.projectId ?? r.project.id, trigger: 'ui' } as never;
    const callAs = (toolName: string, input: Record<string, unknown>): Promise<Decision> =>
      (engine['toolDecider']!.call(r.engine, j, a1) as (t2: string, i: Record<string, unknown>) => Promise<Decision>)(toolName, input);
    const noteAs = (toolName: string, input: Record<string, unknown>): void => {
      const act = (r.engine as unknown as { active: Map<string, unknown> }).active.get(t.id);
      (engine['noteToolUse']!.call(r.engine, j, act, toolName, `u${++n}`, input) as void);
    };
    return { task: t, call: callAs, noteUse: noteAs, stop: () => r.engine.cancel(t.id) };
  };
  /** Lets an open card run out its time. Build the rig with `approvalTimeoutMs`. */
  const advanceApprovalTimeout = async (): Promise<void> => { await pause((o.approvalTimeoutMs ?? 0) + 40); };
  /** The activity log's lines for this rig, newest first. */
  const activityRead = (q?: Parameters<ActivityLog['read']>[0]) => r.activity!.read(q);
  /** The options of the run's first Claude start (task 28): the tool names Legion offered, the tools it forbade, and a way to call an offered tool. */
  const options = (): Record<string, any> => r.calls[0]!.options as Record<string, any>;
  const legionTools = (): Record<string, { handler: (a: Record<string, unknown>, e: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }> => options().mcpServers.legion.instance._registeredTools;
  const toolNames = (): string[] => Object.keys(legionTools()).map((n) => `mcp__legion__${n}`);
  const callTool = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const t = legionTools()[name.replace(/^mcp__legion__/, '')];
    if (!t) throw new Error(`tool not offered: ${name}`);
    const res = await t.handler(args, {});
    return { text: res.content.map((c) => c.text).join('\n'), isError: res.isError === true };
  };
  return { ...r, webSearch: ws, options, legionTools, toolNames, callTool, activityRead, core, task, job, agent: a1, call, run, hook, hookAll, canUse, approvalEvents, pending, answer, tick, setMode, setRules, projectDir, setGateOverride, noteUse, freshRun, advanceApprovalTimeout, stop: () => r.engine.cancel(task.id) };
}
export type GatesRig = Awaited<ReturnType<typeof gatesRig>>;

/** A gates store with no key (only Ask can be stored) and one with the fixed test key, over a fresh temp folder. */
export function noKeyStore(dir = join(tempDir('legion-gates-nokey-'), 'data')): GatesCore { return createGatesCore({ dataDir: dir, projects: new ProjectStore(dir, join(dir, 'ws')) }); }
export function keyedStore(dir = join(tempDir('legion-gates-keyed-'), 'data')): GatesCore { return createGatesCore({ dataDir: dir, projects: new ProjectStore(dir, join(dir, 'ws')), keyring: { get: () => Buffer.alloc(32, 7) } as never }); }
export type { ModeResolver };
