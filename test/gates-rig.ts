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
import type { ModeResolver } from '../src/core/gates-settings/index.js';
import { ProjectStore } from '../src/core/projects/store.js';

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
  ceiling?: 'ask';
  approvalTimeoutMs?: number;
}

export async function gatesRig(o: RigOptions = {}) {
  const r = setup({ gatesCore: true, approval: o.own ?? 'ask', script: idle, ...(o.approvalTimeoutMs ? { approvalTimeoutMs: o.approvalTimeoutMs } : {}) });
  const core = r.core as GatesCore;
  if (o.app) core.store.patchApp({ preset: o.app });
  const body: Record<string, unknown> = {};
  if (o.preset) body.preset = o.preset;
  if (o.limit !== undefined) body.limit = o.limit;
  if (o.overrides) body.overrides = o.overrides;
  if (Object.keys(body).length) core.store.patchProject(r.project.id, body);
  const a1 = r.store.agents.get('a1')!;
  if (o.follow) a1.approvalSource = 'project';
  const task = r.start('a1', 'go');
  await pause(120);
  const origin: TaskOrigin | undefined = o.ceiling ? ({ roomId: 'r1', fromAgentId: 'x1', hop: 0, approvalCeiling: o.ceiling }) : undefined;
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
  /** Lets an open card run out its time. Build the rig with `approvalTimeoutMs`. */
  const advanceApprovalTimeout = async (): Promise<void> => { await pause((o.approvalTimeoutMs ?? 0) + 40); };
  return { ...r, core, task, job, agent: a1, call, run, hook, pending, answer, tick, setMode, setRules, projectDir, setGateOverride, noteUse, advanceApprovalTimeout, stop: () => r.engine.cancel(task.id) };
}
export type GatesRig = Awaited<ReturnType<typeof gatesRig>>;

/** A gates store with no key (only Ask can be stored) and one with the fixed test key, over a fresh temp folder. */
export function noKeyStore(dir = join(tempDir('legion-gates-nokey-'), 'data')): GatesCore { return createGatesCore({ dataDir: dir, projects: new ProjectStore(dir, join(dir, 'ws')) }); }
export function keyedStore(dir = join(tempDir('legion-gates-keyed-'), 'data')): GatesCore { return createGatesCore({ dataDir: dir, projects: new ProjectStore(dir, join(dir, 'ws')), keyring: { get: () => Buffer.alloc(32, 7) } as never }); }
export type { ModeResolver };
