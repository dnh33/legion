/** Runs agent tasks via the Claude Agent SDK. */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import type { HookInput, McpServerConfig, Options, Query, Settings, SyncHookJSONOutput, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentProfile, ChatMessage, ConcreteModel, LegionConfig, MascotMood, MessageRole, ModelChoice, QueueReason, QueueSnapshot, StartTrigger, Task, TaskProgress, TaskSource,
} from '../shared/types.js';
import { newId, nowIso, titleFrom } from '../shared/util.js';
import { API_BILLING_BLOCKED, PLAN_CHECK_FAILED, PLAN_CHECK_FAILED_TEXT, apiBillingBlockedText, explainClaudeError } from '../shared/claude-errors.js';
import { gatesFor, scrubHostSessionEnv } from '../shared/config.js';
import { heldBackNames, scrubSecretEnv, type ScrubOpts } from './env-scrub.js';
import { TRUSTED_FOLDERS_LABEL } from '../shared/gates-registry.js';
import { assessRun, plain as trustPlain, readInstructions } from './folder-trust.js';
import type { FolderScan } from './folder-trust.js';
import { classifySafe } from '../shared/consequence.js';
import { AWAY_COPY } from '../shared/away-copy.js';
import type { BuildSnapshot } from './gates-settings/build-edited.js';
import { isBuildFile } from '../shared/build-files.js';
import { liveSecrets } from './kg/index.js';
import { BUDGET_LIMIT_PREFIX, CONTINUE_PROMPT, TOKEN_LIMIT_PREFIX, TURN_LIMIT_PREFIX, budgetCap, formatUsdLimit } from '../shared/continue.js';
import { clampBudget } from './brief.js';
import { InputChannel } from './input-channel.js';
import { BackgroundTasks } from './background-tasks.js';
import { capStored, RESULT_STORE_MAX } from './result-store.js';
import { contextTokensOf } from '../shared/context-meter.js';
import { APPROVAL_READ_ONLY, decideGuard, describeWaited, isLegionTool, needsApproval, stricterMode, summarizeToolInput, webChecksApply, webInput, webKind, LEGION_SERVER_NAMES } from './approvals.js';
import { WebSession } from './web-session.js';
import { globMatchesAny, secretFileNames, secretReadDetail, secretReadHit, type SecretLocation } from './secret-paths.js';
import { OWN_WRITE_FILE_TOOLS, WRITE_FILE_TOOLS, protectedWriteHit, startsAtLogin } from './protected-paths.js';
import { webVerdict } from '../shared/web-verdict.js';
import type { WebVerdict } from '../shared/web-verdict.js';
import { loadDocsHosts } from '../shared/docs-hosts.js';
import { webCardSummary, WEB_CARD, WEB_MANY_BODY } from '../shared/web-copy.js';
import { ENV_KEEP_LABEL, ENV_NEVER_PASSED, GATES } from '../shared/gates-registry.js';
import type { GateValue } from '../shared/gates-registry.js';
import type { ActivityLog } from './activity/index.js';
import type { WebSearchService } from './web-search/index.js';
import type { RunMode, ClaudeSdkMode } from './permission-mode.js';
import { claudePermissionMode, startIsStricter } from './permission-mode.js';
import { decideGate } from './gates.js';
import { TaintedPaths } from './tainted-paths.js';
import { carryDone, CLAUDE_TASK_TOOLS, mirrorClaudeTaskCall, renderEmptyHandover, renderForModel, renderHandover, TaskList, TaskListStore } from './task-list.js';
import { nativeTaskListOn } from '../shared/task-list-setting.js';
import { buildHostToolsServer, nativePath, redactValues } from './exec/host-tools.js';
import { MAX_READABLE, collapsedText, criticalDeleteRead, longCatastrophic, recursiveDeleteSnippet, refuseCatastrophic, unjudgeableCommand, windowsShellTexts, type ShellKind } from './exec/shell-floor.js';
import { dataFolderRead } from './exec/data-folder-guard.js';
import { containedRunBlock } from './acp/contained.js';
import { canonicalLocal, canonicalSet, hitsCanonical, isHardlinkToProtected, isProtected, protectedTargets } from './exec/canonical-path.js';
/** The tools that run a shell command: Legion's host shell and Claude Code's own Bash and PowerShell. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['mcp__host__shell', 'Bash', 'PowerShell', 'Monitor']);
/** The shell each tool runs its command in: Claude Code's Bash and Monitor (POSIX sh, Git Bash on Windows), its PowerShell, Legion's host shell (agent-shell.ts: Git Bash, or cmd.exe on Windows without Git). */
const shellKindOf = (toolName: string): ShellKind => (toolName === 'PowerShell' ? 'pwsh' : toolName === 'mcp__host__shell' ? floorShell(agentShell()) : 'sh');
import { DirectHostBackend } from './exec/direct-host.js';
import { agentShell, floorShell } from './exec/agent-shell.js';
import { clampExecLimits } from './exec/limits.js';
import { CONTINUE_REFUSED } from './connector-withhold.js';
import type { CoreModule, ModuleJob, PreambleContext, TaskEndOutcome } from './modules.js';
import type { TaskOrigin } from '../shared/comms.js';
import type { ApprovalBroker } from './approvals.js';
import { QuestionBroker } from './questions.js';
import type { EventBus } from './bus.js';
import { modelRank, overrideAllowed, overrideRefusal, rankModel } from './model-cap.js';
import { routeModel, shouldEscalate } from './router.js';
import type { Store } from './store.js';
import { buildAgentToolsServer } from './agent-tools.js';
import { Bridge } from './bridge.js';
import { leadDoctrineFor } from './lead.js';
import type { BridgeStartParams } from './bridge.js';
import type { VmManager } from './vm-manager.js';
import { isSelfMcpUrl, McpStatusTracker, selfMcpNames } from './mcp-status.js';
import type { Catalog, McpStatusView, TodoItem } from '../shared/types.js';
import { parseAcpModel, runtimeOf } from '../shared/runtime.js';
import { acpCostOf, acpEntry, entryLimits } from '../shared/acp-view.js';
import type { AcpEntry } from '../shared/acp-view.js';
import { AcpRefusal, AcpSession } from './acp/session.js';
import { noteAgentVersion, noteAuthFailure } from './acp/detect.js';
import type { AcpCallbacks, AcpStdioServer, AcpTurnEnd } from './acp/session.js';
import { AgentLaunchError, startAgentProcess } from './acp/process.js';
import type { AgentProcess } from './acp/process.js';
import { issueRunToken, shimServer } from './acp/run-tokens.js';
import type { RunToken, RunToolsHost } from './acp/run-tokens.js';
import { RUN_TOOL_WAIT_MAX_S } from './acp/run-tools.js';
import { RpcClosed, RpcError } from './acp/rpc.js';
import type { MappedPermission } from './acp/map.js';
import { agentModeFor, cardHidden, cardSummary, commandNamesPath, expandRequestPath, hermesHomes, isAdminShare, isRouteTool, permissionWaitOf, plainWindowsPath, requestPaths, stripPaths, toolWaitOf } from './acp/run-helpers.js';
import { redact as logRedact } from './log/redact.js';
import { HERMES_BASELINE_TEXT, HERMES_CWD_TEXT, HERMES_MAX_TOKENS_TEXT, HERMES_NOT_ALLOWED_TEXT, HERMES_REFUSED_TEXT, HERMES_SESSION_GONE_TEXT, HERMES_UNTESTED_TEXT, HERMES_WATCHDOG_TEXT, blockedNote, disasterNote, named, refusalText, sessionStateText, toolPolicyText } from './acp/texts.js';
import { checkerFallbackLine } from '../shared/claude-checks-copy.js';
import { providerPrefix } from './providers/runtime.js';
import type { ProviderRuntime } from './providers/runtime.js';
import type { ProviderHost, ResolvedModel } from './providers/types.js';
import { messagesTokens, isSummaryMessage } from './providers/compaction.js';
import { toChatMessages } from './providers/tool-loop.js';
import type { Project } from '../shared/projects.js';
import { projectSection } from './projects/prompt.js';
import { renderCapabilities } from './agent-facts.js';
import { renderTeamwork } from './teamwork.js';
import type { ProjectStore } from './projects/store.js';
import { homedir, tmpdir } from 'node:os';
import { CARDED_CONNECTOR_WRITES } from './connectors/gateway.js';

/** On Windows the agent shell and Git Bash read `/tmp` as the user's temp folder: gates check both spellings there. */
const GATE_TMP_DIR = process.platform === 'win32' ? tmpdir() : undefined;

export type QueryFn = typeof sdkQuery;

/**
 * What the engine asks of the away module (0.3.0). Absent: nothing is ever held and no spend is written, exactly as before.
 * Every method is called inside a try: a throwing hook never stops the queue or a run.
 */
export interface AwayHooks {
  /** "Pause new starts" is on for this project. */
  isPaused(projectId: string): boolean;
  /** The project's budget is reached and no override is in force. */
  budgetBlocked(projectId: string): boolean;
  /** When the budget period that holds this project's starts ends (ms since epoch), if it holds any. The engine wakes itself then. */
  budgetRollsAt?(projectId: string): number | undefined;
  /** One cost the run reported (a result's rise in spend). */
  recordSpend(e: { taskId: string; agentId: string; projectId?: string; usd: number }): void;
}

export interface EngineDeps {
  store: Store; bus: EventBus; vms: VmManager; approvals: ApprovalBroker; config: LegionConfig;
  /** Structured questions (agent ask_user_question -> thread card). Defaults to one private to this engine, on the same bus. */
  questions?: QuestionBroker;
  /** Injected for tests; defaults to the real SDK query(). */
  queryFn?: QueryFn;
  /** Returns whether boat is configured (vm tools only offered when true). */
  boatConfigured: () => boolean;
  maxConcurrent?: number;
  /** The away module's hooks: pause, budget, spend ledger. Absent: today's behaviour. */
  away?: AwayHooks;
  modules?: CoreModule[];
  /** Where the list of files written by tainted runs is kept; defaults to <workspaceDir>/.tainted-paths.json. */
  taintedPaths?: TaintedPaths;
  /** Where each task's own task list is kept (task-list.ts); defaults to <workspaceDir>/.task-lists. */
  taskLists?: TaskListStore;
  /** Other model providers (OpenAI-compatible endpoints). Absent: every run is a Claude run, exactly as before. */
  providers?: ProviderRuntime;
  /** Projects (src/core/projects). Absent: no task has a project and nothing about projects is interpreted. */
  projects?: ProjectStore;
  /** The gate presets' mode resolver (spec 4.2). Absent: the agent's own mode, as before. */
  modes?: import('./gates-settings/index.js').ModeResolver;
  /** The gate values (spec 4): the permission gates the engine owns are read per call, for the project the run started in. Absent: every gate is on, as before. */
  gates?: GatesRead;
  /** The activity log: what a gate that is off let through is written here as a "would have asked" line. Absent: no lines. */
  activity?: ActivityLog;
  /** The web search and page read providers: when the owner picked one, the run gets web_search / web_read and the built-in tool it replaces is forbidden. Absent: today's behaviour. */
  webSearch?: WebSearchService;
  /** Timings for a run that is held open by background agents. Tests shorten them; the defaults are BG_STALL_MS and BG_GRACE_MS. */
  /** How long a plan-only run waits for the account check before it fails closed. Default 20 s. */
  accountCheckMs?: number;
  background?: { stallMs?: number; graceMs?: number; maxHeldMs?: number; now?: () => number };
  /**
   * What running an agent host (Hermes) needs from the core. Absent: an agent host agent fails in plain words and nothing is started.
   * Only the first three are real settings; the rest let a test shorten a wait or watch the run keys.
   */
  agentHost?: {
    /** Legion's data folder: the agent never gets a working folder inside or above it, and its process list is kept there. */
    dataDir: string;
    /** The port Legion's own core listens on: the tool shim of a run connects there. */
    port: number;
    /** The agent's home folder, when it is not where the agent itself would put it. */
    hermesHome?: string;
    /** Overrides the turn watchdog (ms). Default: the Settings value in minutes. */
    watchdogMs?: number;
    /**
     * How long a card for an agent request stays open (ms), or a function that gives it, read at each request. Default 300 s: the agent denies
     * the request itself then. The agent's own setting for that wait (its approvals timeout) is read by the agent host detection and fed in here.
     */
    permissionWaitMs?: number | ((entry: AcpEntry) => number | undefined);
    /** How long a card raised inside an agent's tool call may stay open (ms), counted from the call, or a function that gives it, read at each run. Default 270 s. The agent's own tool-call timeout is read by the agent host detection and fed in here. */
    toolWaitMs?: number | ((entry: AcpEntry) => number | undefined);
    cancelGraceMs?: number;
    /** Told when a run on an agent host starts, so the core can read the agent's own settings in the background. Never awaited; a throw is ignored. */
    onRunStart?: (entry: AcpEntry) => void;
    issueRunToken?: (taskId: string, agentId: string) => RunToken;
    /** Why a Contained run may not start (plain words), or undefined. Default: the Contained profile read-back (acp/contained.ts, cached for a minute). Tests replace it. */
    containedGate?: (entry: AcpEntry) => Promise<string | undefined>;
  };
}

/**
 * A run with background agents is held open (its input stays open) until they report. If the SDK sends nothing at all for this long while
 * they are running, Legion stops waiting, says so in the thread and closes the run (which ends them).
 */
export const BG_STALL_MS = 60 * 60_000;
/** After the last background agent reports, how long a silent run is given to answer the notification before it is closed. */
export const BG_GRACE_MS = 30_000;
/**
 * The most a run is held open for background agents, whatever they send: their own heartbeats (task_progress, tool_progress) would
 * otherwise keep the silence cap from ever firing on a wedged agent, and the run holds a concurrency slot meanwhile.
 */
export const BG_MAX_HELD_MS = 2 * 60 * 60_000;

/** Claude Code's own task tools, opted in or out per agent (nativeTaskListOn). */
const NATIVE_TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'] as const;

/** Most items and longest item text of a TodoWrite list kept for the live checklist. */
export const TODO_MAX_ITEMS = 50;
export const TODO_MAX_TEXT = 200;
const clipText = (v: string) => (v.length > TODO_MAX_TEXT ? v.slice(0, TODO_MAX_TEXT - 1) + '…' : v);

/** Reads a TodoWrite input ({ todos: [{ content, status, activeForm? }] }) into a clipped checklist; null when it has no usable list. */
export function clipTodos(input: unknown): TodoItem[] | null {
  const raw = (input as { todos?: unknown } | null | undefined)?.todos;
  if (!Array.isArray(raw)) return null;
  const out: TodoItem[] = [];
  for (const t of raw) {
    if (out.length >= TODO_MAX_ITEMS) break;
    const content = typeof t?.content === 'string' ? t.content.trim() : '';
    if (!content) continue;
    const status = t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending';
    const active = typeof t.activeForm === 'string' ? t.activeForm.trim() : '';
    out.push({ content: clipText(content), status, ...(active ? { activeForm: clipText(active) } : {}) });
  }
  return out;
}

/** A task list as the live checklist: the same limit a TodoWrite list has. */
const checklistOf = (list: TaskList): TodoItem[] => list.todos().slice(0, TODO_MAX_ITEMS);

/**
 * Keep stored tool results small (≤ ~1500 chars) without breaking JSON: a JSON result is shortened
 * field by field and re-serialised so UIs can still parse it; anything else is cut with an ellipsis.
 */
export function clipToolResult(raw: string, max = 1500): string {
  if (raw.length <= max) return raw;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'string' && v.length > max - 200 ? v.slice(0, max - 201) + '…' : v;
      const s = JSON.stringify(out);
      if (s.length <= max + 200) return s;
    }
  } catch { /* not JSON */ }
  return raw.slice(0, max - 1) + '…';
}

/**
 * The tools that are known not to bring outside content into a run: file tools (the agent's own workspace), the to-do list
 * and sub-agent plumbing. Everything NOT on this list taints the run (an allowlist, so a tool Legion has never heard of,
 * such as ReadMcpResourceTool, is treated as outside content until someone vouches for it here).
 */
const CLEAN_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
  'TodoWrite', 'Task', 'Agent', 'ExitPlanMode', 'EnterPlanMode',
  // the agent's own plumbing: no network, no other server, nothing that carries someone else's text into the run.
  // 'Skill' is deliberately NOT here: a skill's text can come from a third party, so each load is classified by the skill it names (noteToolUse).
  'ToolSearch', 'AskUserQuestion', 'TaskStop', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'Config', 'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronList', 'CronDelete', 'Monitor',
  'ScheduleWakeup', // schedules the agent's own next turn; returns only a confirmation
  'PushNotification', // notice to the owner's device; nothing comes back into the run
]);
/** Legion's own file tool also counts for the build-file flag (it is not in WRITE_FILE_TOOLS, which the taint checks share). */
const BUILD_EDIT_EXTRA_FILE_TOOLS = OWN_WRITE_FILE_TOOLS;
const READ_FILE_TOOLS: Record<string, string> = { Read: 'file_path' };
const SEARCH_TOOLS = new Set(['Glob', 'Grep', 'LS']);
/** Legion's own in-process tools that still return outside content: a VM's output. */
const TAINTING_LEGION_TOOLS = new Set([
  'mcp__legion__vm_exec', 'mcp__legion__vm_read_file', 'mcp__legion__vm_claude', 'mcp__legion__vm_desktop',
  // the owner's web search and page read providers hand back outside text, as WebFetch and WebSearch do
  'mcp__legion__web_search', 'mcp__legion__web_read',
]);
/** True when calling this tool taints the run: unless it is a Legion in-process tool (not a VM-output one) or on the clean built-in list, it does. */
export function taintsRun(toolName: string): boolean {
  if (TAINTING_LEGION_TOOLS.has(toolName)) return true;
  if (isLegionTool(toolName)) return false;
  return !CLEAN_BUILTINS.has(toolName);
}

/** A PreToolUse hook answer that blocks the tool and tells the agent why. */
/** The one start-project value every mode reader uses for a run: the project it started in, else the project it helps from outside. Never the live membership. */
const startProjectOf = (j: { projectAtStart?: string; outsideOf?: string }): string | undefined => j.projectAtStart ?? j.outsideOf;
/** How long an answered guard card is shared with an identical call (the PreToolUse hook and canUseTool both ask). */
const GUARD_MEMO_MS = 5000;
/** How long a Smart run waits for the model list before it starts without knowing whether the model has Claude's checker. */
const CATALOG_WAIT_MS = 3000;
/** How long a hook's answer for one call waits for canUseTool (which, when it is asked at all, is asked right after the hooks). */
const HOOK_DECIDED_MS = 60_000;
/** The data-folder entries whose contents are secrets to read: provider keys, connector tokens and data keys, the gate settings and the gates key. */
const SECRET_DATA_NAMES: ReadonlySet<string> = new Set(['providers', 'connectors', 'gates', 'gates-key.bin']);
/** The data-folder entries a shell write or delete still asks about in Full (Bypass): the gate settings, the gates key, config, state, the project list and app-settings.json (the desktop's own switches) and the agent host's pid list. */
const FULL_CARD_NAMES: ReadonlySet<string> = new Set(['gates', 'gates-key.bin', 'gates-key.unconfirmed', 'config.json', 'state.json', 'projects.json', 'app-settings.json', 'acp-pids.json']);
/** New sites raised by one run within this long go out as one card (the first call opens the window). */
const WEB_BATCH_MS = 10;
type Decision = { allow: boolean; message?: string };
interface WebBatchEntry { toolName: string; input: Record<string, unknown>; v: Extract<WebVerdict, { kind: 'ask' }>; resolve: (d: Decision) => void }
interface WebBatch { entries: WebBatchEntry[] }
/** The same text for the same input whatever the order of its keys: the key of a shared guard card. */
const canonicalJson = (v: unknown): string => {
  try { return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : x)) ?? ''; } catch { return newId('unkeyed'); } // an input that cannot be written out never shares a card with another call
};

function preToolDeny(reason: string): { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string } } {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}
/** Hand the call to Claude Code's permission flow as an ask: it reaches canUseTool, where it becomes a card. Never an allow, so Claude's own checker is not skipped. */
function preToolAsk(reason: string): { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'ask'; permissionDecisionReason: string } } {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } };
}
/** The owner already decided this call (on a floor card): skip the ordinary permission check for it. */
function preToolAllow(reason: string, updatedInput?: Record<string, unknown>): { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'allow'; permissionDecisionReason: string; updatedInput?: Record<string, unknown> } } {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason, ...(updatedInput ? { updatedInput } : {}) } };
}

/** The path with symlinks and junctions resolved as far as it exists (the rest of the name is appended as written). */
function realish(p: string): string {
  const parts: string[] = [];
  let cur = resolve(p);
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    parts.unshift(basename(cur));
    cur = up;
  }
  let real = cur;
  try { real = realpathSync.native(cur); } catch { /* keep the written path */ }
  return join(real, ...parts);
}

/**
 * True when `target` is `dir` or inside it, compared as written, after symlinks are resolved and in the canonical Windows spelling. Always compared
 * without case: Windows and macOS file systems usually ignore case, and for a deny guard a false match on Linux only
 * blocks a path that differs from a protected one by case, which is harmless.
 */
export function pathInside(dir: string, target: string): boolean {
  const fold = (x: string): string => x.toLowerCase();
  const inside = (d: string, t: string): boolean => { const a = fold(resolve(d)); const b = fold(resolve(t)); return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep); };
  // Windows ignores trailing dots and spaces in a name and accepts long-path, device and admin-share spellings: the canonical form (the one the shell and
  // file-tool guards compare) folds them, so `gates.\x` is `gates\x` here too. A fold only ever adds a match.
  return inside(dir, target) || inside(realish(dir), realish(target)) || hitsCanonical(canonicalLocal(target), [canonicalLocal(dir)]);
}

export class EngineError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = 'EngineError'; }
}

/**
 * Who the agent is and how to behave. Reaching other agents lives in the teamwork block (teamwork.ts) and the VM policy in the
 * capabilities block (agent-facts.ts), each said once and only when the run has those tools (Fascia 3a).
 */
export const LEGION_PREAMBLE = [
  'You are {name}, an agent inside Legion, the user\'s personal multi-agent bot running on their own computer.',
  'Be direct and get the work done; report results concisely.',
].join('\n');

/**
 * Child-process env. Built from process.env only; Legion never reads credential files.
 * claude-login: API key vars removed so the signed-in account is used. api-key: key from config.
 */
/**
 * Second layer for "no claude.ai connectors": the SDK `settings` flag layer (`--settings`). `disableClaudeAiConnectors` is any-source-true,
 * so a project or user settings file inherited by this run cannot turn it back off. Absent when the owner turned inheritMcp on (probes: always set).
 */
export function connectorSettings(config: LegionConfig, opts?: { probe?: boolean }): { settings?: Settings } {
  return config.claude.inheritMcp !== true || opts?.probe ? { settings: { disableClaudeAiConnectors: true } } : {};
}

/**
 * "Plan only": a Claude login (not an API key) that may not bill API credits (claude.allowApiBilling off, the default). The flag settings layer
 * beats a user-file env value and apiKeyHelper, and an empty string counts as unset, so every key source Legion can reach is blanked. A key stored
 * by a Console login cannot be blanked by any setting: the account check in planAccountCheck (before the request is sent) catches that one, and the init
 * message check in handleMessage backs it up. Unknown key sources count as billed: never bill unless the owner allowed it. Stated limit: a bearer token
 * from an organization's managed settings reports "none", so it passes; the organization's managed settings decide there.
 */
export function isPlanOnly(config: LegionConfig): boolean {
  return config.claude.auth === 'claude-login' && config.claude.allowApiBilling !== true;
}

/** Merges the plan-only blanks into the run's flag settings (`base`: connector and skill-shell flags, all kept). A copy of `base` otherwise. */
export function planOnlySettings(config: LegionConfig, base: Settings = {}): Settings {
  return isPlanOnly(config) ? { ...base, env: { ...base.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' }, apiKeyHelper: '' } : { ...base };
}

export function buildChildEnv(config: LegionConfig, opts?: { probe?: boolean; scrub?: false | ScrubOpts }): Record<string, string | undefined> {
  const raw = scrubHostSessionEnv({ ...process.env });
  const scrubbing = opts?.scrub !== false;
  // Default ON, also for probes and callers that pass nothing. The cloud logins stay when the CLI is told to use Bedrock, Vertex or Foundry.
  const providerAuth = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some((k) => raw[k]);
  const env: Record<string, string | undefined> = scrubbing ? scrubSecretEnv(raw, { ...(opts?.scrub ?? {}), providerAuth }) : raw;
  // The CLI keeps its own credentials for its API calls and strips them from the subprocesses it starts (Bash, hooks, stdio MCP servers), so in api-key mode
  // the key set below is not visible to Claude's Bash. Needs CLI 2.1.251 or later (bundled: 2.1.306). Documented side effect: on Linux, Bash then runs in its own PID namespace.
  // https://code.claude.com/docs/en/env-vars (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB)
  // Only where the CLI holds a credential Legion put in the environment (the api-key, or the cloud logins). In a Claude-login run that credential
  // lives outside the environment, so Legion's scrub and the owner's keep list decide alone: the CLI's own scrub would override the keep list.
  if (scrubbing && (config.claude.auth === 'api-key' || providerAuth)) env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  // SDK 0.3.302 turned fork subagents on by default in SDK sessions. They stay off until Legion's cards, task counting and cost are
  // tested with them (owner, 2026-10-21: off in 0.3.7, decided in 0.3.8); the owner's own CLAUDE_CODE_FORK_SUBAGENT wins (KEEP_ENV).
  if (!env.CLAUDE_CODE_FORK_SUBAGENT) env.CLAUDE_CODE_FORK_SUBAGENT = '0'; // unset or empty: off
  // the bearer token opens every human-only route: whatever put it in this process's environment, it must not reach a bot's
  if (config.authToken.length >= 8) for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && v.toLowerCase().includes(config.authToken.toLowerCase())) delete env[k];
  if (config.claude.auth === 'api-key') {
    env.ANTHROPIC_API_KEY = config.claude.apiKey;
    // an inherited bearer token outranks the key, so the run could sign in with the wrong credential
    if (!providerAuth) delete env.ANTHROPIC_AUTH_TOKEN;
  } else if (isPlanOnly(config)) {
    // empty counts as unset for Claude Code, and keeps a settings-file value from filling the gap
    env.ANTHROPIC_API_KEY = '';
    env.ANTHROPIC_AUTH_TOKEN = '';
  } else {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  // claude.ai connectors (the account's own MCP servers) load only when the owner turned on claude.inheritMcp. A probe never needs them.
  // The SDK's bundled CLI reads ENABLE_CLAUDEAI_MCP_SERVERS and treats false/0/no/off as "do not load them".
  if (config.claude.inheritMcp !== true || opts?.probe) env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  return env;
}

/** Environment variables that hold Legion's own credentials. */
const LEGION_CREDENTIAL_ENV: ReadonlySet<string> = new Set(ENV_NEVER_PASSED);

/**
 * The environment the agent shell (host tools) starts from. Legion's own credentials are not the agent's: the Anthropic
 * key and token, the boat key, and any variable whose value holds the bearer token or a configured key are left out, so a
 * command (`set`, `env`, a curl that sends a variable) does not get them from its environment. Legion's own control
 * variables (the LEGION_ namespace) are left out too. Everything else is kept,
 * except names that look like keys, tokens or passwords (src/core/env-scrub.ts): those are dropped unless the owner keeps them
 * (`keep`, from the signed envKeep list) or switched the `env-scrub` gate off (`scrub: false`). A GITHUB_TOKEN for git push is
 * then the owner's choice to add.
 *
 * Known limit, stated rather than hidden: the shell runs as the user, so it can still READ Legion's own files
 * (`~/.legion/config.json`, or LEGION_HOME) where those keys are kept. Only a sandboxed backend closes that.
 */
export function buildHostShellEnv(config: LegionConfig, opts?: ScrubOpts & { scrub?: boolean }): Record<string, string> {
  // a section that is not there has no key in it: the named variables are still dropped
  const secrets = [config.authToken, config.claude?.apiKey, config.boat?.apiKey]
    .filter((s): s is string => typeof s === 'string' && s.length >= 8).map((s) => s.toLowerCase());
  const out: Record<string, string> = {};
  const host = scrubHostSessionEnv({ ...process.env });
  for (const [k, v] of Object.entries(opts?.scrub === false ? host : scrubSecretEnv(host, { ...(opts?.keep ? { keep: opts.keep } : {}), ...(opts?.providerAuth ? { providerAuth: true } : {}) }))) {
    if (v === undefined || LEGION_CREDENTIAL_ENV.has(k.toUpperCase())) continue;
    // LEGION_* steers the core itself (LEGION_PORT, LEGION_HOME, LEGION_TEST_MODE, ...): a Legion or a test the agent starts must not inherit it
    if (/^LEGION_/i.test(k)) continue;
    const lower = v.toLowerCase();
    if (secrets.some((s) => lower.includes(s))) continue;
    out[k] = v;
  }
  return out;
}

interface Job {
  taskId: string; agentId: string; prompt: string; choice: ModelChoice; priorModel?: ConcreteModel;
  /** The project the run was queued in (A10): if it is gone when the run starts, the thread says so. */
  projectAtStart?: string;
  /** An outside helper's project (decision 2026-10-13): the run is not in it, but its deny and ask rules bind the run. */
  outsideOf?: string;
  /** One-line bridge header prepended to what Claude sees (not stored). */
  header?: string;
  /** Text the auto router scores, when it differs from `prompt` (a typed brief scores its goal only; Fascia 3b). */
  routeText?: string;
  /** A per-run spend cap in USD (a brief's budget); clamped in buildOptions, never above the owner's claude.maxBudgetUsd. */
  maxBudgetUsd?: number;
  /** Set for bridge runs: the caller agent + task, for mascot note and cap bypass. */
  fromAgentId?: string; parentTaskId?: string;
  /** Set when another bot woke this run (rooms, or the agent bridge). Caps the run's approval mode. */
  origin?: TaskOrigin;
  /** What started the run. Only 'marshal' and 'schedule' are held by "Pause new starts". */
  trigger: StartTrigger;
  /** "Queue after it": the agent's other live tasks in this project at enqueue time. The job waits until none of them is live. */
  after?: string[];
}
/** What the engine reads of the gates core: the gate values, and (optional, so a bare stub still works) the per-project build-file flag. */
type GatesRead = Pick<import('./gates-settings/index.js').GatesCore, 'gate' | 'switchedOff'> & Partial<Pick<import('./gates-settings/index.js').GatesCore, 'buildEdited' | 'envKeep' | 'trustedFolders' | 'store' | 'webLastUsed' | 'canAllowHosts' | 'allowHost'>>;
interface Active {
  ac: AbortController; cancelled: boolean; q?: Query;
  /** What the run did on the web: paths read per site (the budget), a secret file read, sites allowed for this goal. */
  web: WebSession;
  /** Sticky: the run (or the chain that woke it) touched outside content. Set by the engine, never by a tool argument. */
  tainted: boolean;
  /** A build or script file was changed in this run. Used only when the run has no project (with a project the flag lives in the gates core, per project). */
  buildEdited?: boolean;
  /** This run follows Claude's own permission checks (fixed when the run starts), and the Claude mode it asked for / was given. */
  nativeChecks?: boolean;
  sdkMode?: ClaudeSdkMode;
  /** Tool use ids Legion denied on the owner's own No (or a timeout): Claude's "permission denied" message for them is not logged a second time. */
  ownerDenied?: Set<string>;
  /** The "could not use Claude's own checker" note went into the thread already. */
  checkerNoted?: boolean;
  /** Claude Code's shell keeps its folder between calls: set once a call ran a `cd` the data-folder guard could not prove stays outside the protected set. */
  shellMoved?: boolean;
  /** The folder(s) the run's Claude shell may be in after its last call, when the guard could follow them. */
  shellCwds?: string[];
  /**
   * Every folder Claude's shell may be in after its earlier calls, as the project-folder delete check followed them (null: not known;
   * absent: still where the run started). The folders before a `cd` stay in: the call may have been refused or denied, or the cd may have failed.
   */
  critCwds?: string[] | null;
  /** The project this run started in (absent: none); only such a run is told later that its project changed. */
  projectAtStart?: string;
  /** For an outside helper's run: the project it helps (its cap and deny rules bind the run although the run is not in it). */
  outsideOf?: string;
  /** tool_use ids already reported (the stream and the PreToolUse hook both see each one). */
  toolUses: Set<string>;
  /** This run's prompt reached a session (Claude: its init arrived; provider: it took a turn). Only then can a stop be continued. */
  reached?: boolean;
  /** Live progress of the current run (Claude, or a provider run from its first turn): sent as `task.progress`, never stored. */
  progress?: { startedAt: string; turn: number; maxTurns: number; tool: string | null; turnIds: Set<string>; contextTokens?: number; todos?: TodoItem[]; thinking: boolean };
  /** The live prompt stream of the current Claude run: a message from the person while it works is pushed here. */
  input?: InputChannel;
  /** The background agents the current Claude run has going (from the SDK's task messages). While any run, the input stays open. */
  bg?: BackgroundTasks;
  /** When the held phase ends whatever happens (ms since epoch); set while the run is held for background agents. */
  bgStopsAt?: number;
  /** The task's own task list (kept per Legion task): a mirror of Claude Code's on a Claude run, the list itself on a provider run. */
  taskList?: TaskList;
  /** Claude Code task-tool calls waiting for their result (a new task's id arrives only in the result), by tool_use id. */
  taskCalls?: Map<string, { name: string; input: unknown }>;
  /** The list as it was handed over to this Claude run (flag still set): put back if the run does not finish, so nothing is lost. */
  handoverFrom?: TaskList;
  /** The run ended done (set just before that status is saved). */
  finishedOk?: boolean;
  /** The names of the variables held back from this run's commands were written to the activity log (once per run). */
  heldBackNoted?: boolean;
  /** The held-back folder settings were written to the activity log (once per run). */
  folderTrustNoted?: boolean;
  /** An agent host run (Hermes): the session and the process Legion started for it. Cancel ends both. */
  acp?: { session: AcpSession; proc: AgentProcess };
  /** The agent's process while its session is still opening, so a cancel in that time can end it. */
  acpProc?: AgentProcess;
}
interface Outcome { subtype: string; isError: boolean; errorText?: string }

const IDLE_MASCOT_MS = 4000;
/** What the bundled Claude Code says when `resume` names a session it cannot find (strings in claude.exe, SDK 0.3.285). */
const SESSION_MISSING_RE = /no conversation found|failed to resume session/i;

export class Engine {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly vms: VmManager;
  private readonly approvals: ApprovalBroker;
  private readonly questions: QuestionBroker;
  private readonly config: LegionConfig;
  private readonly queryFn: QueryFn;
  private readonly boatConfigured: () => boolean;
  private readonly maxConcurrent: number;
  private readonly taintedPaths: TaintedPaths;
  private readonly taskLists: TaskListStore;
  private readonly providers?: ProviderRuntime;
  private readonly projects?: ProjectStore;
  private readonly away?: AwayHooks;
  private readonly modes?: import('./gates-settings/index.js').ModeResolver;
  private readonly gates?: GatesRead;
  private readonly activity?: ActivityLog;
  /** The owner's optional web search and page read providers (src/core/web-search). Absent: every web call is the built-in tool's. */
  private readonly webSearch?: WebSearchService;
  private readonly queue: Job[] = [];
  /** The last queue snapshot sent, as text: `queue.updated` goes out only when it changes. */
  private lastQueueJson = JSON.stringify({ cap: 0, running: 0, items: [] });
  private readonly active = new Map<string, Active>();
  /** Live runs already told that their project was archived or their agent removed (decision B3): one note per run. */
  private readonly projectNoted = new Set<string>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  readonly bridge: Bridge;
  private modules: CoreModule[];
  private readonly mcpTracker = new McpStatusTracker();
  private readonly accountCheckMs: number;
  private readonly bgStallMs: number;
  private readonly bgGraceMs: number;
  private readonly bgMaxHeldMs: number;
  private readonly bgNow: () => number;
  private readonly agentHost?: EngineDeps['agentHost'];

  constructor(deps: EngineDeps) {
    this.agentHost = deps.agentHost;
    this.accountCheckMs = Math.max(1, deps.accountCheckMs ?? 20_000);
    this.bgStallMs = Math.max(1, deps.background?.stallMs ?? BG_STALL_MS);
    this.bgGraceMs = Math.max(1, deps.background?.graceMs ?? BG_GRACE_MS);
    this.bgMaxHeldMs = Math.max(1, deps.background?.maxHeldMs ?? BG_MAX_HELD_MS);
    this.bgNow = deps.background?.now ?? Date.now;
    this.store = deps.store; this.bus = deps.bus; this.vms = deps.vms; this.approvals = deps.approvals;
    this.questions = deps.questions ?? new QuestionBroker(deps.bus);
    this.config = deps.config;
    this.queryFn = deps.queryFn ?? realQuery;
    this.boatConfigured = deps.boatConfigured;
    this.maxConcurrent = Math.max(1, deps.maxConcurrent ?? 4);
    this.modules = deps.modules ?? [];
    this.providers = deps.providers;
    this.projects = deps.projects;
    this.away = deps.away;
    this.modes = deps.modes;
    this.gates = deps.gates;
    this.activity = deps.activity;
    this.webSearch = deps.webSearch;
    this.lastQueueJson = JSON.stringify(this.queueSnapshot());
    this.taintedPaths = deps.taintedPaths ?? new TaintedPaths(join(deps.config.workspaceDir, '.tainted-paths.json'));
    this.taskLists = deps.taskLists ?? new TaskListStore(join(deps.config.workspaceDir, '.task-lists'));
    // a deleted task takes its task list with it, so nothing of it is left behind for a later task to find
    this.bus.on((e) => { if (e.type === 'task.deleted') { try { this.taskLists.remove(e.taskId); } catch { /* best effort */ } } });
    this.bus.on((e) => { if (e.type === 'project.updated') { try { this.onProjectUpdated(e.project); } catch { /* the note is advisory */ } } });
    // a pause was lifted, a budget changed, or "Stop at the budget" was switched off: what was held can start now
    this.bus.on((e) => { if (e.type === 'away.updated' || e.type === 'gates.updated') this.pump(); });
    this.bridge = new Bridge({ store: this.store, bus: this.bus, engine: this });
  }

  /** Modules are built after the engine (they need it), so they are attached here. */
  setModules(mods: CoreModule[]): void { this.modules = mods; }

  startTask(p: BridgeStartParams): Task {
    const agent = this.store.getAgent(p.agentId);
    if (!agent || !this.bridge.isVisible(agent)) throw new EngineError(`Unknown agent: ${p.agentId}`, 404);
    const prompt = (p.prompt ?? '').trim();
    if (!prompt) throw new EngineError('Prompt is empty', 400);
    // A /command the owner switched off for this agent is refused here, before anything is queued or fed to a live run, so it holds for the app,
    // MCP clients, rooms and agent-to-agent messages alike.
    // The check runs on the text that will really be sent (after routeModel strips a /model or /opus prefix): `/model sonnet /update-config x`
    // reaches Claude Code as `/update-config x`. A message to a live run that starts with a slash is not fed live (feedLive). execute() checks again when the run starts.
    const refusal = this.slashRefusal(agent, routeModel(prompt, 'auto').prompt);
    if (refusal) throw new EngineError(refusal, 400);

    // Confused-deputy rule: a run another agent starts through the bridge never gets looser
    // approvals than its caller (rooms set their own origin and take precedence).
    const origin = p.origin ?? this.bridgeOrigin(p) ?? this.mcpOrigin(p, p.continueTaskId ? this.store.getTask(p.continueTaskId) : undefined);
    // Taint follows the chain: a tainted waking bot, or a tainted peer's reply, taints this task for good.
    const tainted = !!p.tainted || !!origin?.tainted || (!!p.bridge?.reply && !!p.bridge.fromTaskId && this.isTainted(p.bridge.fromTaskId));

    // A token client (MCP, curl) never moves a run between Claude and a provider, or between providers: that decides where the owner's data goes.
    if (p.source === 'mcp' && p.model && (runtimeOf(p.model) !== 'claude' || runtimeOf(agent.model) !== 'claude') && p.model !== agent.model) {
      throw new EngineError('Provider models and agent hosts can only be chosen in the Legion app. This agent runs on its own setting; leave model out.', 400);
    }
    const overriding = !!p.modelOverrideBy && !!p.model;
    if (overriding && !overrideAllowed(agent.model, p.model)) throw new EngineError(overrideRefusal(agent.name, agent.model, p.model!), 400);
    let task: Task;
    let priorModel: ConcreteModel | undefined;
    let outside: { project: Project; why: string } | undefined;
    // a project whose deny rules bind this run although the run is not in it (review #1, #2)
    let bound: string | undefined;
    if (p.continueTaskId) {
      const prev = this.store.getTask(p.continueTaskId);
      if (!prev) throw new EngineError(`Unknown task: ${p.continueTaskId}`, 404);
      if (prev.status === 'running') { const live = this.feedLive(p, prev, prompt); if (live) return live; }
      if (prev.status === 'queued' || prev.status === 'running') throw new EngineError('Task is still running', 409);
      if (prev.agentId !== agent.id) throw new EngineError('Task belongs to a different agent', 400);
      // a task that read connector data holds that text in its session: nothing started by or down a chain from an MCP client may resume it
      if (prev.usedConnectors && origin?.viaMcpClient) throw new EngineError(CONTINUE_REFUSED, 403);
      const pick = this.pickProject(p, agent, prev);
      const picked = pick.id;
      outside = pick.outside;
      // Continuing never erases the task's project (council A4): when this run cannot use it (the agent left the project,
      // or it is archived), the task keeps it, the run goes without it, and the thread says so. Only an explicit `null`
      // from the app or a room clears it.
      const projectId = picked ?? (p.projectId === null ? undefined : prev.projectId);
      const lostProject = picked === undefined && projectId !== undefined && this.projects ? this.projects.get(projectId) : undefined;
      // a run of a task that keeps a project it cannot use still meets that project's deny rules
      bound = pick.bound ?? lostProject?.id;
      priorModel = prev.model;
      const viaBridge = p.bridge && !p.bridge.reply;
      // A model another bot chose lasts for that run only: a later message that asks for none (and is not a reply landing in the caller's own task) goes back to the agent's setting.
      const keepOverride = !!p.bridge?.reply;
      // Provenance flag `modelChosen` (carried on the task row): requestedModel was CHOSEN for this task - a value
      // other than agent.model - rather than copied from Settings. When nobody asks for a model on this turn the
      // configured model is re-read instead of the snapshot taken at task creation, so changing a bot's model in
      // Settings reaches every thread it owns. The one place the previous value survives is a reply landing in the
      // caller's own task, and only while it is still an explicit choice (or a recorded override).
      const chosenBefore = (prev as Task & { modelChosen?: boolean }).modelChosen === true;
      const keepChosen = keepOverride && (chosenBefore || !!prev.modelOverride);
      const requestedModel = p.model ?? (keepChosen ? prev.requestedModel : agent.model);
      const next = {
        ...prev, status: 'queued' as const, source: p.source,
        requestedModel, modelChosen: requestedModel !== agent.model,
        modelOverride: overriding ? { model: p.model!, by: p.modelOverrideBy! } : keepOverride ? prev.modelOverride : undefined,
        // not resumable until this run's own prompt reaches the session (a restart before then must re-send it, not continue)
        result: undefined, error: undefined, resumable: undefined,
        ...(this.projects ? { projectId } : {}),
        // the app clearing the project clears the outside-helper binding too
        ...(outside ? { helpingProjectId: outside.project.id } : p.projectId === null ? { helpingProjectId: undefined } : {}),
        ...(viaBridge ? { fromAgentId: p.bridge!.fromAgentId, parentTaskId: p.bridge!.parentTaskId } : {}),
        bridgeHop: p.bridge ? p.bridge.hop ?? 0 : undefined,
        // A human continuing a task clears any bot-origin ceiling; a bridge reply keeps the task's own.
        origin: origin ?? (p.bridge?.reply ? prev.origin : undefined),
        ...(tainted ? { tainted: true } : {}),
      };
      task = this.saveTask(next);
      if (lostProject) {
        const why = lostProject.status === 'archived' ? 'the project is archived' : `${agent.name} is not a member of it any more`;
        this.addMessage(task.id, 'system', `This run is not in project "${lostProject.name}": ${why}. The task still belongs to the project; it runs without the project's instructions, board and folder until that changes.`);
      }
    } else {
      const now = nowIso();
      const base = prompt.replace(/^\s*\/(opus|sonnet)\b\s*/i, '') || prompt;
      const callerName = p.bridge ? (this.store.getAgent(p.bridge.fromAgentId)?.name ?? p.bridge.fromAgentId) : '';
      const pick = this.pickProject(p, agent, undefined);
      const projectId = pick.id;
      outside = pick.outside;
      const requestedModel = p.model ?? agent.model;
      const next = {
        id: newId('task'), agentId: agent.id,
        title: p.bridge ? `${callerName}: ${base.replace(/\s+/g, ' ').trim().slice(0, 50)}` : titleFrom(base),
        status: 'queued' as const, source: p.source,
        ...(p.bridge ? { fromAgentId: p.bridge.fromAgentId, parentTaskId: p.bridge.parentTaskId, bridgeHop: p.bridge.hop ?? 0 } : {}),
        // provenance: a task that runs on its agent's own model carries no choice of its own (see the continue branch)
        requestedModel, modelChosen: requestedModel !== agent.model, createdAt: now, updatedAt: now,
        ...(overriding ? { modelOverride: { model: p.model!, by: p.modelOverrideBy! } } : {}),
        ...(origin ? { origin } : {}),
        ...(projectId ? { projectId } : {}),
        ...(outside ? { helpingProjectId: outside.project.id } : {}),
        ...(tainted ? { tainted: true } : {}),
      };
      task = this.saveTask(next);
    }
    this.addMessage(task.id, 'user', prompt, undefined, p.bridge?.fromAgentId);
    if (outside) this.noteOutsideHelper(task.id, p.bridge?.parentTaskId, agent, outside);
    const projectAtStart = this.projectOf(task.id, agent.id)?.id;
    this.queue.push({
      taskId: task.id, agentId: agent.id, prompt, choice: task.requestedModel, priorModel,
      ...(projectAtStart ? { projectAtStart } : {}),
      ...(outside || bound ? { outsideOf: outside?.project.id ?? bound } : {}),
      header: p.bridge?.header, fromAgentId: p.bridge?.fromAgentId, parentTaskId: p.bridge && !p.bridge.reply ? p.bridge.parentTaskId : undefined,
      ...(p.routeText !== undefined ? { routeText: p.routeText } : {}),
      ...(p.maxBudgetUsd !== undefined ? { maxBudgetUsd: p.maxBudgetUsd } : {}),
      origin: task.origin,
      // a delegation and a room wake are never held by a pause; only the Marshal and a schedule name themselves
      trigger: p.trigger ?? (p.bridge ? 'delegation' : p.source === 'bot' ? 'room' : 'owner'),
      ...(p.startAfter ? { after: this.liveOfAgent(agent.id, projectAtStart, task.id) } : {}),
    });
    queueMicrotask(() => this.pump());
    return { ...task };
  }

  /**
   * The project a new or continued task belongs to. Only the app (source 'ui', admin) and a room's own wake (source 'bot') may name one;
   * a bridge run (ask/tell) inherits its caller's task's project; an MCP or CLI client never picks. The agent must be a member and the
   * project active. The app gets an error for a bad pick; a room or bridge run just starts without the project. Continuing keeps the
   * task's project unless the app or the room says otherwise. `undefined` = no project.
   */
  private pickProject(p: BridgeStartParams, agent: AgentProfile, prev: Task | undefined): { id?: string; outside?: { project: Project; why: string }; bound?: string } {
    if (!this.projects) {
      if (p.source === 'ui' && typeof p.projectId === 'string') throw new EngineError('Projects are not available in this core', 400);
      return { id: prev?.projectId };
    }
    let want: string | undefined;
    let named = false;
    // a delegation (ask/tell) belongs to its CALLER's project, before any older thread's (BUG-5)
    const delegated = !!p.bridge && !p.bridge.reply && !!p.bridge.parentTaskId;
    if ((p.source === 'ui' || p.source === 'bot') && p.projectId !== undefined) { want = p.projectId ?? undefined; named = true; }
    else if (delegated) {
      const caller = this.store.getTask(p.bridge!.parentTaskId!);
      want = caller?.projectId;
      // work an outside helper hands on stays outside the project, and its deny rules go with it (review #1)
      const helping = !want && caller?.helpingProjectId ? this.projects.get(caller.helpingProjectId) : undefined;
      if (helping) return { outside: { project: helping, why: 'asked by an outside helper' } };
    } else if (prev) {
      want = prev.projectId;
      // an outside helper's own later runs (a reply landing, a continue) stay bound by the project's deny rules
      if (!want && prev.helpingProjectId && this.projects.get(prev.helpingProjectId)) return { bound: prev.helpingProjectId };
    }
    if (!want) return {};
    const pr = this.projects.get(want);
    if (pr && pr.status === 'archived') {
      // a reply always lands in its caller's task (B3: live runs finish); the run goes on without the project, with the note
      if (p.bridge?.reply) return {};
      // a live run of an archived project may still hand work on: the helper works from outside it, and both threads say so
      if (delegated) return { outside: { project: pr, why: 'the project is archived' } };
      if (p.source === 'ui' || (prev && !named)) throw new EngineError(`Project "${pr.name}" is archived. Unarchive it to start or continue a task in it.`, 409);
      return {};
    }
    if (pr && pr.members.includes(agent.id)) return { id: want };
    if (p.source === 'ui' && named) throw new EngineError(pr ? `${agent.name} is not a member of project "${pr.name}"` : `Unknown project: ${want}`, 400);
    // A non-member helps from outside (decision 2026-10-13): no folder, notes or board, the project's deny rules still bind it,
    // and both threads say so (the caller is never left unaware, council A3).
    if (delegated && pr) return { outside: { project: pr, why: `${agent.name} is not a member` } };
    return {};
  }

  /** An outside helper is told it works on the project from outside it, and its caller is told how to give it the project (decision 2026-10-13). */
  private noteOutsideHelper(taskId: string, callerTaskId: string | undefined, agent: AgentProfile, o: { project: Project; why: string }): void {
    try { this.addMessage(taskId, 'system', `You are helping with project "${o.project.name}" from outside it (${o.why}). You are not given its folder, notes or board; its deny rules still apply.`); } catch { /* advisory */ }
    if (!callerTaskId) return;
    const how = o.project.status === 'archived' ? 'Unarchive the project to work in it again.' : `To give ${agent.name} the project's folder, notes and board, add it on the project page.`;
    try { this.addMessage(callerTaskId, 'system', `${agent.name} helped from outside project "${o.project.name}" (${o.why}). ${how}`); } catch { /* advisory */ }
  }

  /**
   * Says in the thread that a run queued in a project starts without it (council A10): the project was archived or
   * deleted, or the agent was removed, while the run waited. Worded like the note a continued task gets at start.
   */
  private noteProjectLost(taskId: string, projectId: string, agent: AgentProfile): void {
    const pr = this.projects?.get(projectId);
    const text = !pr ? 'This run has no project: its project was deleted while the run waited.'
      : `This run is not in project "${pr.name}": ${pr.status === 'archived' ? 'the project is archived' : `${agent.name} is not a member of it any more`}. The task still belongs to the project; it runs without the project's instructions, board and folder until that changes.`;
    try { this.addMessage(taskId, 'system', text); } catch { /* the note is advisory */ }
  }

  /** A live run whose project was archived, or whose agent left it, finishes; its thread says so once (decision B3). */
  private onProjectUpdated(p: Project): void {
    for (const taskId of this.active.keys()) {
      if (this.projectNoted.has(taskId)) continue;
      const t = this.store.getTask(taskId);
      // a run that started without the project already said so at its start
      if (!t || this.active.get(taskId)?.projectAtStart !== p.id) continue;
      const archived = p.status === 'archived';
      if (!archived && p.members.includes(t.agentId)) continue;
      this.projectNoted.add(taskId);
      const name = this.store.getAgent(t.agentId)?.name ?? t.agentId;
      const why = archived ? `Project "${p.name}" was archived while this run was working.` : `${name} was removed from project "${p.name}" while this run was working.`;
      this.addMessage(taskId, 'system', `${why} The run finishes; its remaining steps have no project board or notes, and the project's deny rules still apply.`);
    }
  }

  /**
   * Says, at the start of a run, that another live run works in the same folder (decision B2): a run in the same project
   * folder, or another run of the same agent (its own folder). Advisory: nothing is blocked; the run already working is not told.
   */
  private noteSharedFolder(taskId: string, agent: AgentProfile, project: Project | undefined): void {
    for (const other of this.active.keys()) {
      if (other === taskId) continue;
      const t = this.store.getTask(other);
      if (!t) continue;
      const otherName = this.store.getAgent(t.agentId)?.name ?? t.agentId;
      let text: string | undefined;
      if (project && this.projectOf(other, t.agentId)?.id === project.id) text = `${otherName} is also working in this project's folder now ("${t.title}"). Both runs can change the same files.`;
      else if (t.agentId === agent.id) text = `${agent.name} is also running another task now ("${t.title}"), in the same agent folder. Both runs can change the same files.`;
      if (!text) continue;
      try { this.addMessage(taskId, 'system', text); } catch { /* the note is advisory */ }
      return;
    }
  }

  /** The project this task's run belongs to right now (active, agent is a member), else undefined. Checked at every run. */
  private projectOf(taskId: string, agentId: string): Project | undefined {
    if (!this.projects) return undefined;
    return this.projects.forRun(this.store.getTask(taskId)?.projectId, agentId);
  }

  /**
   * A run started by a bearer-token client (Claude Code / Cowork / curl via MCP or POST /api/tasks without the admin header) is never
   * human-level: its approval is capped at `ask` whatever the agent is set to (a `full` agent runs in `default` mode with cards).
   * Only the Electron UI (admin) starts human runs. Continuing keeps what the task already had (room, hop, taint) and the stricter
   * of its earlier ceiling and `ask`, so a continue can never launder a ceiling away.
   */
  private mcpOrigin(p: BridgeStartParams, prev?: Task): TaskOrigin | undefined {
    if (p.source !== 'mcp') return undefined;
    // viaMcpClient is set in both branches: a continue of a room-woken task by a client still came from a client (connector reads are refused for it).
    if (prev?.origin) return { ...prev.origin, approvalCeiling: stricterMode(prev.origin.approvalCeiling, 'ask'), viaMcpClient: true };
    return { roomId: 'mcp', fromAgentId: 'mcp', hop: 0, approvalCeiling: 'ask', viaMcpClient: true };
  }

  /** Origin (approval ceiling) for a task started by `ask`/`tell`. Replies go back to the caller's own task and add none. */
  private bridgeOrigin(p: BridgeStartParams): TaskOrigin | undefined {
    if (!p.bridge || p.bridge.reply) return undefined;
    const callerTask = p.bridge.parentTaskId ? this.store.getTask(p.bridge.parentTaskId) : undefined;
    // the caller's RESOLVED mode for that task (agent mode, preset, project cap), never its stored mode: a caller the resolver holds at Ask hands out Ask
    let ceiling: RunMode = this.runModeOf(p.bridge.fromAgentId, p.bridge.parentTaskId) ?? 'ask';
    if (callerTask?.origin) ceiling = stricterMode(ceiling, callerTask.origin.approvalCeiling);
    // An agent host agent acts where Legion cannot see, so what it starts is held at Ask and counts as touched by outside content, whatever mode the agent is set to
    const fromHost = runtimeOf(callerTask?.model) === 'acp' || runtimeOf(this.store.getAgent(p.bridge.fromAgentId)?.model) === 'acp';
    if (fromHost) ceiling = stricterMode(ceiling, 'ask');
    const tainted = fromHost || !!callerTask?.origin?.tainted || (!!p.bridge.parentTaskId && this.isTainted(p.bridge.parentTaskId));
    // the client flag travels down the chain: MCP client -> A -> (ask/tell) -> B is still a client-started chain (strictest wins, never cleared)
    const viaMcpClient = callerTask?.origin?.viaMcpClient === true;
    return { roomId: 'agent-bridge', fromAgentId: p.bridge.fromAgentId, hop: p.bridge.hop ?? 1, approvalCeiling: ceiling, ...(tainted ? { tainted: true } : {}), ...(viaMcpClient ? { viaMcpClient: true } : {}) };
  }

  /** Whether a task touched outside content (live run first, then what was stored). */
  isTainted(taskId: string): boolean {
    const a = this.active.get(taskId);
    if (a?.tainted) return true;
    const t = this.store.getTask(taskId);
    return !!t && (t.tainted === true || t.origin?.tainted === true);
  }

  /** Marks a task tainted: live runs flip at once, stored tasks keep it for later runs. */
  markTainted(taskId: string): void {
    const a = this.active.get(taskId);
    if (a) a.tainted = true;
    const t = this.store.getTask(taskId);
    if (t && !t.tainted) this.patchTask(taskId, { tainted: true });
  }

  cancel(taskId: string): boolean {
    const qi = this.queue.findIndex((j) => j.taskId === taskId);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.markCancelled(taskId);
      try { this.bridge.cancelFor(taskId); } catch { /* ignore */ }
      this.emitQueue();
      return true;
    }
    const a = this.active.get(taskId);
    if (!a || a.cancelled) return false;
    a.cancelled = true;
    this.markCancelled(taskId);
    this.approvals.cancelForTask(taskId);
    this.questions.cancelForTask(taskId);
    try { this.bridge.cancelFor(taskId); } catch { /* ignore */ }
    try { a.ac.abort(); } catch { /* ignore */ }
    try { void a.q?.interrupt?.()?.catch?.(() => undefined); } catch { /* ignore */ }
    // an agent host run: tell the agent to stop, then end its process (the prompt stays open on the wire otherwise)
    const host = a.acp;
    // (one turn of the event loop between: the open requests are answered `cancelled` on the wire first, as the protocol requires)
    if (host) void host.session.cancel().catch(() => undefined).then(() => new Promise<void>((r) => setImmediate(r))).then(() => host.proc.stop()).catch(() => undefined);
    else if (a.acpProc) void a.acpProc.stop().catch(() => undefined); // still starting: nothing to cancel on the wire, the process just ends
    return true;
  }

  /** The tasks a task started, and the ones those started (what "Stop a team" would also stop, live or not). */
  teamOf(taskId: string): string[] { return this.bridge.teamOf(taskId); }

  /** Stop a team: cancel the task and every task it started, and stop their send-backs from waking the caller. `cancelled` lists the live ones stopped. */
  cancelTeam(taskId: string): { cancelled: string[] } {
    return { cancelled: this.bridge.stopTeam(taskId) };
  }

  waitFor(taskId: string, timeoutMs: number): Promise<Task> {
    const cur = this.store.getTask(taskId);
    if (!cur) return Promise.reject(new EngineError(`Unknown task: ${taskId}`, 404));
    const isLive = (t: Task) => t.status === 'queued' || t.status === 'running';
    if (!isLive(cur)) return Promise.resolve(cur);
    return new Promise<Task>((resolve) => {
      let off: () => void = () => undefined;
      const timer = setTimeout(() => { off(); resolve(this.store.getTask(taskId) ?? cur); }, Math.max(0, timeoutMs));
      off = this.bus.on((ev) => {
        if (ev.type === 'task.updated' && ev.task.id === taskId && !isLive(ev.task)) {
          clearTimeout(timer); off(); resolve(ev.task);
        }
      });
    });
  }

  running(): string[] { return [...this.active.keys()]; }

  /** The project a task's run belongs to now (active, its agent a member): the roster's membership column. */
  projectOfTask(taskId: string): Project | undefined {
    const t = this.store.getTask(taskId);
    return t ? this.projectOf(taskId, t.agentId) : undefined;
  }

  /** An approval card or a question of this task waits on the owner (the run is paused on a person, not stalled). */
  waitingOnOwner(taskId: string): boolean {
    try { return this.approvals.pending().some((a) => a.taskId === taskId) || this.questions.pending().some((q) => q.taskId === taskId); } catch { return false; }
  }

  // ---------------------------------------------------------------- internals

  private saveTask(t: Task): Task {
    const saved = this.store.upsertTask({ ...t, updatedAt: nowIso() });
    this.bus.emit({ type: 'task.updated', task: saved });
    return saved;
  }

  private patchTask(taskId: string, patch: Partial<Task>): Task | undefined {
    const cur = this.store.getTask(taskId);
    if (!cur) return undefined;
    return this.saveTask({ ...cur, ...patch });
  }

  /**
   * The task row's copy of a reply. A reply longer than the row holds is kept whole in the result store first, and the
   * row's visible note points there, so no character is lost (the owner's no-silent-truncation rule): only this copy is cut.
   */
  private keepResult(taskId: string, text: string): string {
    if (text.length <= RESULT_STORE_MAX) return text;
    try { return capStored(text, RESULT_STORE_MAX, { taskId, resultId: this.bridge.results.put(taskId, text) }); } catch { return capStored(text); }
  }

  private addMessage(taskId: string, role: MessageRole, text: string, toolName?: string, fromAgentId?: string, extra?: Partial<ChatMessage>): ChatMessage {
    const m: ChatMessage = { id: newId('msg'), taskId, role, text, at: nowIso(), ...(toolName ? { toolName } : {}), ...(fromAgentId ? { fromAgentId } : {}), ...(extra ?? {}) };
    const saved = this.store.addMessage(m);
    this.bus.emit({ type: 'message', message: saved ?? m });
    return saved ?? m;
  }

  /** Live progress of a Claude run for the working row; transient by design (a restart has no run to report on). */
  /** The newest request the person (or a bot) actually wrote in this task: not a Continue instruction. */
  private lastRequest(taskId: string): string | undefined {
    const rows = this.store.listMessages(taskId);
    for (let i = rows.length - 1; i >= 0; i--) {
      const m = rows[i]!;
      if (m.role === 'user' && m.text.trim() && m.text !== CONTINUE_PROMPT) return m.text;
    }
    return undefined;
  }

  /**
   * A message from the person to their own running Claude task joins the run: Claude reads it after its current step, in
   * the same conversation, instead of it waiting for the whole run to end. Returns undefined (the caller answers 409 and
   * the app queues it as before) for anything else: a bot, an MCP client or a room (their approval ceiling and taint are
   * fixed per run), a provider run (no stream), a slash command (it would act on the run, not join it), or a run that is
   * already closing.
   */
  private feedLive(p: BridgeStartParams, prev: Task, prompt: string): Task | undefined {
    if (p.source !== 'ui' || p.bridge || p.origin || p.modelOverrideBy || prompt.startsWith('/')) return undefined;
    const act = this.active.get(prev.id);
    if (!act?.input || act.input.isClosed || act.cancelled) return undefined;
    if (!act.input.push(prompt)) return undefined;
    this.addMessage(prev.id, 'user', prompt);
    return { ...prev };
  }

  /** The live progress of every running Claude run, for a client that connects mid-run (events are transient). */
  progressSnapshot(): Record<string, TaskProgress> {
    const out: Record<string, TaskProgress> = {};
    for (const [taskId, act] of this.active) {
      const p = this.progressView(act);
      // a run whose task is already marked done/error is in its last moments of cleanup: it has no progress to show
      if (!p || this.store.getTask(taskId)?.status !== 'running') continue;
      out[taskId] = p;
    }
    return out;
  }

  private emitProgress(taskId: string, act: Active): void {
    const p = this.progressView(act);
    if (p) this.bus.emit({ type: 'task.progress', taskId, progress: p });
  }

  /** A Claude run's mirrored task list changed: keep it for the task's next run and show it as the live checklist. */
  private keepTaskList(taskId: string, act: Active, list: TaskList): void {
    // only the checklist's copy (Claude Code keeps the real list): an unwritable folder must not stop the run
    try { this.taskLists.save(taskId, list); } catch { /* the live checklist still updates */ }
    this.showTaskList(taskId, act, list);
  }

  /** Shows the task's list as the live checklist of the current run. */
  private showTaskList(taskId: string, act: Active, list: TaskList): void {
    act.taskList = list;
    if (act.progress) { act.progress.todos = checklistOf(list); this.emitProgress(taskId, act); }
  }

  /** What the app is told about a run: one place, so the live event and the snapshot for a late client cannot drift apart. */
  private progressView(act: Active): TaskProgress | undefined {
    const p = act.progress;
    if (!p) return undefined;
    const background = act.bg?.count ?? 0;
    return {
      startedAt: p.startedAt, turn: p.turn, maxTurns: p.maxTurns, tool: p.tool, thinking: p.thinking,
      ...(p.contextTokens !== undefined ? { contextTokens: p.contextTokens } : {}), ...(p.todos ? { todos: p.todos } : {}),
      ...(background > 0 ? { background, ...(act.bgStopsAt !== undefined ? { backgroundStopsAt: new Date(act.bgStopsAt).toISOString() } : {}) } : {}),
    };
  }

  private mascot(mood: MascotMood, note?: string): void {
    if (mood !== 'idle' && this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    this.bus.emit({ type: 'mascot', mood, ...(note ? { note } : {}) });
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.active.size === 0 && this.queue.length === 0) this.mascot('idle');
    }, IDLE_MASCOT_MS);
    this.idleTimer.unref?.();
  }

  private markCancelled(taskId: string): void {
    const t = this.patchTask(taskId, { status: 'cancelled', ...(this.active.get(taskId)?.tainted ? { tainted: true } : {}) });
    if (t) this.addMessage(taskId, 'system', 'Cancelled');
    this.mascot('idle', 'cancelled');
  }

  /**
   * Cancels, right now, every queued job whose agent is no longer visible (the Assayer when BSV mode goes off). Returns the task ids.
   * Runs already in progress are left to finish; startJob re-checks too, so a job can never start for a hidden agent.
   */
  cancelHiddenQueued(): string[] {
    const hidden = this.queue.filter((j) => this.isHiddenAgent(j.agentId));
    const ids: string[] = [];
    for (const j of hidden) {
      const i = this.queue.indexOf(j);
      if (i >= 0) { this.queue.splice(i, 1); this.dropHiddenJob(j); ids.push(j.taskId); }
    }
    if (ids.length) this.emitQueue();
    if (ids.length && this.active.size === 0 && this.queue.length === 0) this.scheduleIdle();
    return ids;
  }

  private isHiddenAgent(agentId: string): boolean {
    const a = this.store.getAgent(agentId);
    return !!a && !this.bridge.isVisible(a);
  }

  /** A queued job whose agent got hidden: it is cancelled with a visible reason and never runs. */
  private dropHiddenJob(job: Job): void {
    const t = this.patchTask(job.taskId, { status: 'cancelled' });
    if (t) this.addMessage(job.taskId, 'system', 'Cancelled: BSV mode was turned off before this run started.');
    try { this.bridge.cancelFor(job.taskId); } catch { /* ignore */ }
    this.mascot('idle', 'cancelled');
  }

  private startJob(job: Job): void {
    // the agent may have been switched off while the job waited in the queue
    if (this.isHiddenAgent(job.agentId)) { this.dropHiddenJob(job); return; }
    const act: Active = { ac: new AbortController(), cancelled: false, tainted: false, toolUses: new Set(), web: new WebSession() };
    act.tainted = !!(job.origin?.tainted || this.store.getTask(job.taskId)?.tainted);
    // one value for the start project: the one the job was queued with, the same one modeNow reads (membership at start time could differ)
    if (job.projectAtStart) act.projectAtStart = job.projectAtStart;
    if (job.outsideOf) act.outsideOf = job.outsideOf;
    this.active.set(job.taskId, act);
    void this.runJob(job, act);
  }

  /** The ids of this agent's tasks in this project that are running or waiting (what "Queue after it" waits for). */
  private liveOfAgent(agentId: string, projectId: string | undefined, selfId: string): string[] {
    const ids: string[] = [];
    for (const id of this.active.keys()) {
      if (id !== selfId && this.store.getTask(id)?.agentId === agentId && this.projectOf(id, agentId)?.id === projectId) ids.push(id);
    }
    // a queued job counts only when it is not itself held by a pause or a budget: nobody should wait behind a job that is not going to run
    for (const j of this.queue) if (j.taskId !== selfId && j.agentId === agentId && j.projectAtStart === projectId && !this.heldByPolicy(j)) ids.push(j.taskId);
    return ids;
  }

  /**
   * The project's budget holds starts: it is reached with no override in force, and the owner has not switched "Stop at the budget" off
   * for the project the run started in. The budget itself (what the page shows, the notice) is the away module's and is not touched by the switch.
   * A gate that cannot be read is on.
   */
  private budgetHolds(pid: string): boolean {
    if (!this.away?.budgetBlocked(pid)) return false;
    try { return this.gates?.gate('budget-stop', pid) !== false; } catch { return true; }
  }

  /** Held by the owner's pause or budget (not by a slot or another run). */
  private heldByPolicy(job: Job): boolean {
    const pid = job.projectAtStart;
    if (!this.away || !pid) return false;
    try { return this.budgetHolds(pid) || ((job.trigger === 'marshal' || job.trigger === 'schedule') && this.away.isPaused(pid)); } catch { return false; }
  }

  /**
   * Why a queued job cannot start now, or undefined when it can. Order (spec 4.3): budget, paused, after, slot.
   * Budget holds every start in the project, the owner's too (a budget the owner set); a pause holds only the Marshal and schedules.
   * `ignoreSlot`: used by the start loop, which has already checked the cap.
   */
  private blockedReason(job: Job, opts: { ignoreSlot?: boolean } = {}): QueueReason | undefined {
    const pid = job.projectAtStart;
    if (this.away && pid) {
      try {
        if (this.budgetHolds(pid)) return 'budget';
        if ((job.trigger === 'marshal' || job.trigger === 'schedule') && this.away.isPaused(pid)) return 'paused';
      } catch { /* a failing hook holds nothing */ }
    }
    if (job.after?.some((id) => this.active.has(id) || this.queue.some((j) => j.taskId === id && !this.heldByPolicy(j)))) return 'after';
    if (!opts.ignoreSlot && this.active.size >= this.maxConcurrent) return 'slot';
    return undefined;
  }

  /** Who waits and why. `running` counts every live run; a delegated child may exceed `cap`, so the app shows min(running, cap). */
  queueSnapshot(): QueueSnapshot {
    const items = this.queue.filter((j) => !this.active.has(j.taskId)).map((j, i) => ({ taskId: j.taskId, reason: this.blockedReason(j) ?? ('slot' as const), position: i + 1 }));
    return { cap: this.maxConcurrent, running: this.active.size, items };
  }

  private emitQueue(): void {
    const q = this.queueSnapshot();
    const json = JSON.stringify(q);
    if (json === this.lastQueueJson) return;
    this.lastQueueJson = json;
    this.bus.emit({ type: 'queue.updated', queue: q });
  }

  private pump(): void {
    // Bridge runs whose parent is running bypass the cap, so nested asks cannot deadlock the queue.
    for (let i = 0; i < this.queue.length;) {
      const j = this.queue[i]!;
      if (j.parentTaskId && this.active.has(j.parentTaskId) && !this.active.has(j.taskId)) {
        this.queue.splice(i, 1);
        this.startJob(j);
      } else i++;
    }
    while (this.active.size < this.maxConcurrent) {
      const idx = this.queue.findIndex((j) => !this.active.has(j.taskId) && this.blockedReason(j, { ignoreSlot: true }) === undefined);
      if (idx < 0) break;
      this.startJob(this.queue.splice(idx, 1)[0]!);
    }
    this.emitQueue();
    this.armBudgetTimer();
  }

  /** The budget timer: set while any queued job is held by a budget, so the end of the period starts it without any event. */
  private budgetTimer?: ReturnType<typeof setTimeout>;
  private budgetTimerAt?: number;
  private armBudgetTimer(): void {
    let at: number | undefined;
    if (this.away?.budgetRollsAt) {
      for (const j of this.queue) {
        const pid = j.projectAtStart;
        if (!pid || this.active.has(j.taskId)) continue;
        try {
          if (!this.budgetHolds(pid)) continue;
          const r = this.away.budgetRollsAt(pid);
          if (r !== undefined && Number.isFinite(r) && (at === undefined || r < at)) at = r;
        } catch { /* no timer for this one */ }
      }
    }
    if (at === undefined) {
      if (this.budgetTimer) clearTimeout(this.budgetTimer);
      this.budgetTimer = undefined; this.budgetTimerAt = undefined;
      return;
    }
    if (this.budgetTimer && this.budgetTimerAt === at) return;
    if (this.budgetTimer) clearTimeout(this.budgetTimer);
    this.budgetTimerAt = at;
    // a little after the boundary; a boundary already past (it should not be) is re-checked in a second, never in a tight loop
    const delay = at > Date.now() ? Math.min(at - Date.now() + 50, 2 ** 31 - 1) : 1000;
    this.budgetTimer = setTimeout(() => { this.budgetTimer = undefined; this.budgetTimerAt = undefined; this.pump(); }, delay);
    this.budgetTimer.unref?.();
  }

  private async runJob(job: Job, act: Active): Promise<void> {
    try {
      await this.execute(job, act);
    } catch (e) {
      this.failTask(job.taskId, e, act);
    } finally {
      this.settleHandover(job.taskId, act);
      this.endTask(job, act);
      if (this.active.get(job.taskId) === act) { this.active.delete(job.taskId); this.projectNoted.delete(job.taskId); }
      try { this.approvals.cancelForTask(job.taskId); } catch { /* ignore */ }
      try { this.questions.cancelForTask(job.taskId); } catch { /* ignore */ }
      if (this.active.size === 0 && this.queue.length === 0) this.scheduleIdle();
      this.pump();
    }
  }

  /** A hand-over run that did not finish (stopped, failed, paused at a limit) puts the handed-over list back, flagged, so the next Claude run gets it again. */
  private settleHandover(taskId: string, act: Active): void {
    // the run's own outcome, not the task's status: a continuation queued the moment this run finished has already re-set that
    if (!act.handoverFrom || act.finishedOk) return;
    try { this.taskLists.save(taskId, act.handoverFrom); } catch { /* best effort */ }
  }

  /** Tells every module the run is over (after the final status is saved). A broken module never breaks the engine. */
  private endTask(job: Job, act: Active): void {
    const task = this.store.getTask(job.taskId);
    const agent = this.store.getAgent(job.agentId);
    if (!task || !agent) return;
    const projectId = this.projectOf(job.taskId, agent.id)?.id;
    const outcome: TaskEndOutcome = {
      status: task.status, isError: task.status === 'error', ...(task.error ? { errorText: task.error } : {}), tainted: act.tainted,
      ...(projectId ? { projectId } : {}),
    };
    for (const m of this.modules) {
      try { m.onTaskEnd?.(task, agent, outcome); } catch { /* ignore */ }
    }
  }

  private failTask(taskId: string, e: unknown, act?: Active): void {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      const cur = this.store.getTask(taskId);
      if (cur && cur.status === 'cancelled') return;
      this.patchTask(taskId, { status: 'error', error: msg, ...(act?.tainted ? { tainted: true } : {}) });
      this.addMessage(taskId, 'system', `Error: ${msg}`);
    } catch { /* never crash */ }
    this.mascot('error', msg.slice(0, 120));
  }

  private async execute(job: Job, act: Active): Promise<void> {
    const agent = this.store.getAgent(job.agentId);
    if (!agent) throw new Error(`Agent ${job.agentId} no longer exists`);
    // Fascia 3b: a typed brief is sent whole, but only its goal is scored by the auto router. The checks and the context
    // refs are a checklist, not the task, and must not flip `auto` (they name words such as plan, review and debug, or run long).
    const hasBriefRoute = !!(job.routeText && job.routeText.trim());
    let decision = routeModel(hasBriefRoute ? job.routeText! : job.prompt, job.choice, { priorModel: job.priorModel });
    // The last check before anything is sent, on the exact text Claude Code will get. A queued prompt starts here, and the owner may have
    // switched the skill off since it was queued.
    const sendText = hasBriefRoute ? job.prompt : decision.prompt;
    const slashNo = this.slashRefusal(agent, sendText);
    if (slashNo) throw new EngineError(slashNo, 400);
    // A model a bot picked (per-task override, or a /opus prefix in a bot's message) never goes above the agent's own setting.
    const picked = this.store.getTask(job.taskId)?.modelOverride || (job.origin && decision.reason.startsWith('prefix'));
    const offClaudeAgent = runtimeOf(agent.model) !== 'claude';
    if (picked && offClaudeAgent && decision.model !== agent.model) {
      // a bot's pick never moves a provider or agent host agent to another model or to Claude (that would send the owner's data somewhere else)
      decision = { ...decision, model: agent.model, reason: `${decision.reason}, kept on ${agent.name}'s own model setting` };
    } else if (picked && !offClaudeAgent && runtimeOf(decision.model) !== 'claude') {
      const own = rankModel(modelRank(agent.model));
      decision = { ...decision, model: own, reason: `${decision.reason}, a bot cannot ${runtimeOf(decision.model) === 'acp' ? 'move it off Claude' : 'pick a provider'}; using ${own}` };
    } else if (picked && modelRank(decision.model) > modelRank(agent.model)) {
      const capped = rankModel(modelRank(agent.model));
      decision = { ...decision, model: capped, reason: `${decision.reason}, capped at ${capped} (${agent.name}'s own setting)` };
    }
    let model = decision.model;
    const first = this.patchTask(job.taskId, { status: 'running', model, error: undefined, resumable: undefined, runsAs: this.runsAsOf(job, agent), web: undefined });
    if (!first) throw new Error('Task disappeared');
    const from = job.header && job.fromAgentId ? this.store.getAgent(job.fromAgentId) : undefined;
    this.mascot('thinking', from ? `${from.name} → ${agent.name}` : `${agent.name} on ${model}: ${decision.reason}`);
    const sendPrompt = (job.header ? job.header + '\n' : '') + sendText;

    const hadSession = !!this.store.getTask(job.taskId)?.sessionId;
    // The same /command check for text that is re-sent later from the task's history (the raw text, and the text after a /model prefix is removed).
    const slashNo2 = (text: string): string | undefined => this.slashRefusal(agent, text) ?? this.slashRefusal(agent, routeModel(text, 'auto').prompt);
    let outcome = await this.runOnce(job, agent, model, sendPrompt, act);
    if (act.cancelled) return;

    // The session this task resumes is gone (its file was deleted, or Claude Code cannot find it): every Retry and
    // Continue would fail the same way forever. Start a new conversation once, with the request itself (a "continue"
    // instruction means nothing to a new conversation), and say so. Checked before escalation, which would hit the
    // same missing session.
    if (hadSession && !act.reached && outcome.isError && SESSION_MISSING_RE.test(outcome.errorText ?? '')) {
      this.patchTask(job.taskId, { sessionId: undefined });
      const request = decision.prompt === CONTINUE_PROMPT ? this.lastRequest(job.taskId) : sendPrompt;
      if (!request || /^\s*\/compact\b/i.test(request)) {
        outcome = { subtype: 'error_during_execution', isError: true, errorText: 'The earlier conversation could not be found, so there is nothing to continue or compact. Send your request again to start a new one.' };
      } else if (slashNo2(request)) {
        // The request comes from the task's history, not from the text checked above: it may be a /command the owner has switched off since.
        // Fail closed, and stop here: this is a refusal, not a failure Opus should retry.
        throw new EngineError(slashNo2(request)!, 400);
      } else {
        this.addMessage(job.taskId, 'system', 'The earlier conversation could not be found, so Claude is starting a new one with your request.');
        outcome = await this.runOnce(job, agent, model, request, act);
        if (act.cancelled) return;
      }
    }

    const cur = this.store.getTask(job.taskId);
    if (
      model === 'sonnet' && !cur?.escalated && outcome.isError && !(cur?.modelOverride && modelRank(agent.model) < 3) &&
      shouldEscalate({ model, subtype: outcome.subtype, isError: outcome.isError, errorText: outcome.errorText })
    ) {
      model = 'opus';
      this.patchTask(job.taskId, { escalated: true, model });
      this.addMessage(job.taskId, 'system', `Sonnet could not finish this (it stopped with an error). Opus is taking over the same conversation.${outcome.errorText ? ` Error: ${outcome.errorText.slice(0, 160)}` : ''}`);
      this.mascot('thinking', 'escalating to opus');
      // The resumed session already holds the request when the failed run got that far: send it again and Opus starts the task over.
      outcome = await this.runOnce(job, agent, model, act.reached ? CONTINUE_PROMPT : sendPrompt, act);
      if (act.cancelled) return;
    }

    if (outcome.isError) {
      // Read by people (the app) and by callers without a button (MCP clients, other bots), so it names no button.
      // A provider run says how far it got ("Stopped after N model turns ...", providers/tool-loop.ts): the same pause,
      // with that run's own limit; a Claude run's stop carries no text and its limit is claude.maxTurns.
      const providerStop = /^Stopped after (\d+) (model turns|Hermes steps)/.exec(outcome.errorText ?? '');
      const stopUnit = providerStop?.[2] === 'Hermes steps' ? 'steps' : 'turns';
      const tokenStop = /^Stopped after ([\d,]+) tokens/.exec(outcome.errorText ?? '');
      const turnLimit = outcome.subtype === 'error_max_turns' && (!outcome.errorText || !!providerStop);
      const limitTurns = providerStop ? Number(providerStop[1]) : this.config.claude.maxTurns;
      // The spend limit is the same kind of stop. The subtype alone says so (no error text is needed), and the amount is named when known.
      // A Hermes token-limit stop has its own words: Hermes reports tokens, never money, so the spend-limit wording would be false for it.
      const tokenLimit = outcome.subtype === 'error_max_budget_usd' && !!tokenStop;
      const budgetLimit = outcome.subtype === 'error_max_budget_usd' && !tokenStop;
      // the cap this run really had: a brief's budget when it lowered the owner's (Fascia 3b)
      const cap = this.perRunBudget(job);
      const budgetWhere = cap !== undefined ? ` (${formatUsdLimit(cap)} this run)` : '';
      const text = tokenLimit
        ? `${TOKEN_LIMIT_PREFIX} (${tokenStop![1]} tokens this task) before finishing. The work so far is kept. To go on, raise the token limit in Settings, Agent hosts, then continue the task.`
        : turnLimit
        ? `${TURN_LIMIT_PREFIX} (${limitTurns} ${stopUnit} this run) before finishing. The work so far is kept: continue the task to pick up where it stopped.`
        : budgetLimit
          ? `${BUDGET_LIMIT_PREFIX}${budgetWhere} before finishing. The work so far is kept: continue the task to pick up where it stopped.`
          : outcome.errorText || outcome.subtype;
      // An empty API credit balance: say why and how to switch to the Claude plan, and keep what Claude said.
      const why = explainClaudeError(outcome.errorText, this.config.claude.auth, this.config.claude.allowApiBilling === true);
      const shown = why ? `${why}\n\nClaude said: ${text}` : text;
      this.patchTask(job.taskId, { status: 'error', error: shown, ...(act.tainted ? { tainted: true } : {}) });
      // the history keeps a short line; the full text is the task's error, which the app shows on the Paused card
      this.addMessage(job.taskId, 'system', tokenLimit ? `${TOKEN_LIMIT_PREFIX} (${tokenStop![1]} tokens this task).` : turnLimit ? `${TURN_LIMIT_PREFIX} (${limitTurns} ${stopUnit} this run).` : budgetLimit ? `${BUDGET_LIMIT_PREFIX}${budgetWhere}.` : `Error: ${why ?? text}`);
      // A limit stop is a pause with the work kept: the mascot stands calm. "Fault detected" would contradict the card.
      if (turnLimit) this.mascot('idle', 'paused at the turn limit');
      else if (tokenLimit) this.mascot('idle', 'paused at the token limit');
      else if (budgetLimit) this.mascot('idle', 'paused at the spend limit');
      else this.mascot('error', text.slice(0, 120));
    } else {
      act.finishedOk = true;
      this.patchTask(job.taskId, { status: 'done', resumable: undefined, ...(act.tainted ? { tainted: true } : {}) });
      this.mascot('success');
    }
  }

  /** Read-only: the MCP servers the latest run saw and their state (Settings -> MCP). */
  mcpStatus(): McpStatusView { return this.mcpTracker.view(this.config); }

  private buildMcpServers(agent: AgentProfile, job: Job, act: Active, runtime: 'claude' | 'provider' | 'acp' = 'claude'): Record<string, McpServerConfig> {
    const taskId = job.taskId;
    const project = this.projectOf(taskId, agent.id);
    const pid = project?.id;
    const out: Record<string, McpServerConfig> = {};
    const wanted = agent.mcpServers ?? [];
    const all = wanted.includes('*');
    // A Settings entry that points back at Legion's own /mcp (hand-edited config) would connect an agent to its own Legion: skip it.
    const self = new Set(selfMcpNames(this.config));
    for (const [name, entry] of Object.entries(this.config.mcpServers ?? {})) {
      if (!all && !wanted.includes(name)) continue;
      if (self.has(name)) continue;
      // A Settings entry may not take one of Legion's own server names: its tools would match LEGION_TOOL_PREFIXES (no card, no taint). Names are Legion's.
      if (LEGION_SERVER_NAMES.has(name)) continue;
      if (entry.type === 'http') out[name] = { type: 'http', url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) };
      else if (entry.type === 'sse') out[name] = { type: 'sse', url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) };
      else out[name] = { type: 'stdio', command: entry.command, ...(entry.args ? { args: entry.args } : {}), ...(entry.env ? { env: entry.env } : {}) };
    }
    // Every agent gets the in-process `legion` server (bridge tools; plus vm_* when a VM is enabled).
    out.legion = buildAgentToolsServer({
      agentId: agent.id, taskId, vms: this.vms, bridge: this.bridge, questions: this.questions,
      vmEnabled: !!agent.vm?.enabled && this.boatConfigured(),
      claudeAvailable: this.vms.claudeAvailable?.() ?? true, // vm_claude is hidden while Claude is known not to be set up on boat.dev
      ...(runtime !== 'claude' ? { honourAbort: true } : {}), // a Claude run keeps its behaviour
      ...(job.origin ? { origin: { roomId: job.origin.roomId, fromAgentId: job.origin.fromAgentId, hop: job.origin.hop } } : {}),
      // a provider run has no Claude Code task tools: Legion keeps the list for it (a Claude run's own list is only mirrored, for the checklist)
      // a provider change is handed over to the next Claude run of this conversation (its own list is behind)
      // the owner's web providers: tools exist only for a capability that has a provider picked; the call log carries this run's task
      ...(this.webSearch ? { webSearch: this.webSearch.withLog((e) => this.noteWebCall(taskId, agent.id, pid, e)) } : {}),
      ...(runtime === 'provider' ? { taskList: { load: () => this.taskLists.load(taskId), save: (l: TaskList) => { l.handoverPending = true; this.taskLists.save(taskId, l); this.showTaskList(taskId, act, l); } } } : {}),
    });
    // The agent shell: host shell/file tools, only for an agent that opted in. The names are `mcp__host__*` (NOT
    // Legion's own), so needsApproval raises a card and taintsRun marks the run; `host` grants the TOOLS, the agent's
    // `approval` mode decides whether each call is carded. An absent `host` = no tools (the opt-in gate).
    if (agent.host?.enabled) {
      // the folder the shell is given must exist: a provider run never made it, so a shell call there failed (live test 0.2.6-y)
      if (project) { try { mkdirSync(project.folder, { recursive: true }); } catch { /* the call then says why */ } }
      out.host = buildHostToolsServer({
        agentId: agent.id, taskId,
        rootDir: this.hostRootOf(agent),
        // a project run's shell also reaches the project folder (decision B6); paths there are given in full
        ...(project ? { extraRoots: [project.folder] } : {}),
        backend: new DirectHostBackend({ limits: clampExecLimits({ timeoutSeconds: agent.host.timeoutSeconds }), env: buildHostShellEnv(this.config, this.scrubFor(job)) }),
        // the shell can read Legion's own files (config.json, provider keys): every secret Legion holds is taken out of what comes back
        redact: (text) => redactValues(text, [...liveSecrets(this.config), ...(this.providers?.secretValues() ?? []), ...(this.webSearch?.secretValues() ?? [])]),
        envFiles: agent.host.envFiles ?? 'masked',
      });
    }
    const moduleJob: ModuleJob = {
      taskId, ...(job.origin ? { origin: job.origin, ceiling: job.origin.approvalCeiling } : {}),
      taint: () => act.tainted || job.origin?.tainted === true,
      markTainted: () => { act.tainted = true; },
      markConnectorData: () => { this.patchTask(taskId, { usedConnectors: true }); },
      runtime,
      ...(pid ? { projectId: pid } : {}),
    };
    for (const m of this.modules) {
      try { Object.assign(out, m.mcpServers?.(agent, moduleJob) ?? {}); } catch { /* a broken module must not break runs */ }
    }
    return out;
  }

  /**
   * Whether this Skill load taints the run. Read from the stream's tool_use input (`{ skill: "<plugin>:<name>" }`), because Claude Code
   * never calls canUseTool for a Skill load. The first module that answers decides; with none, or a throwing one, it taints (unknown = outside).
   */
  private skillLoadTaints(input: unknown): boolean {
    const raw = input && typeof input === 'object' ? (input as { skill?: unknown }).skill : undefined;
    const id = typeof raw === 'string' ? raw : '';
    for (const m of this.modules) {
      if (!m.skillLoadTaints) continue;
      try { return m.skillLoadTaints(id); } catch { return true; }
    }
    return true;
  }

  /** A plain refusal when `text` starts with a /command this agent may not run. A module that throws fails CLOSED: the command is refused. */
  private slashRefusal(agent: AgentProfile, text: string): string | undefined {
    for (const m of this.modules) {
      if (!m.refuseSlashCommand) continue;
      try {
        const r = m.refuseSlashCommand(agent, text);
        if (r) return r;
      } catch {
        return 'Legion could not check whether this /command is allowed, so it was not sent. Try again, or send it without the slash.';
      }
    }
    return undefined;
  }

  /**
   * Why this Skill load is denied, or undefined when it may go ahead. Used by the PreToolUse hook on 'Skill', which Claude Code also runs
   * for a subagent's loads (a subagent ignores the `skills` list). No module answering, or one that throws: denied.
   */
  private skillDenial(agent: AgentProfile, input: unknown): string | undefined {
    const raw = input && typeof input === 'object' ? (input as { skill?: unknown }).skill : undefined;
    const id = (typeof raw === 'string' ? raw : '').trim().replace(/^\//, '');
    let answered = false;
    for (const m of this.modules) {
      if (!m.skillGate) continue;
      answered = true;
      try {
        const why = m.skillGate(agent, id);
        if (why) return why;
      } catch {
        return `${id || 'That skill'} could not be checked, so Legion did not load it.`;
      }
    }
    return answered ? undefined : `${id || 'That skill'} is off in Legion. The owner can turn it on in Settings \u2192 Armory.`;
  }

  /** The folders Claude file tools may not change (the Armory's own files). */
  private protectedDirs(): string[] {
    return protectedTargets(undefined, this.modules);
  }

  /** The `skills` list and plugin folders for a Claude run. Always an array: an omitted list would mean "every skill Claude Code can find". */
  private moduleSkills(agent: AgentProfile): { skills: string[]; plugins: string[] } {
    const skills = new Set<string>();
    const plugins = new Set<string>();
    for (const m of this.modules) {
      try {
        const r = m.claudeSkills?.(agent);
        for (const id of r?.skills ?? []) skills.add(id);
        for (const p of r?.plugins ?? []) plugins.add(p);
      } catch { /* a broken module offers no skills */ }
    }
    return { skills: [...skills], plugins: [...plugins] };
  }

  /** True only when a module says the owner allowed inline skill shell. No module, or a throwing one: blocked. */
  private skillShellAllowed(): boolean {
    for (const m of this.modules) {
      try { if (m.skillShellAllowed?.() === true) return true; } catch { /* blocked */ }
    }
    return false;
  }

  private moduleDisallowed(agent: AgentProfile): string[] {
    const out: string[] = [];
    for (const m of this.modules) {
      try { out.push(...(m.disallowedTools?.(agent) ?? [])); } catch { /* ignore */ }
    }
    return out;
  }

  private modulePreamble(agent: AgentProfile, ctx: PreambleContext): string {
    let out = '';
    for (const m of this.modules) {
      try { const t = m.preamble?.(agent, ctx); if (t) out += '\n\n' + t; } catch { /* ignore */ }
    }
    return out;
  }

  /** One tool_use seen (in the message stream or by the PreToolUse hook; whichever comes first wins): taint, then tell modules. */
  private noteToolUse(job: Job, act: Active, toolName: string, toolUseId?: string, input?: unknown): void {
    if (toolUseId) {
      if (act.toolUses.has(toolUseId)) return;
      act.toolUses.add(toolUseId);
    }
    if (toolName === 'Skill') { if (this.skillLoadTaints(input)) act.tainted = true; }
    else if (taintsRun(toolName)) act.tainted = true;
    // a read of a password or key file makes every web call in this run ask; set when the call is seen, whatever the owner answers
    const agent = this.store.getAgent(job.agentId);
    const tin = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const secret = secretReadHit(toolName, tin, agent ? this.dataSecretLocation(agent, toolName, tin) : undefined);
    if (secret) act.web.noteSecretRead();
    this.trackWorkspaceTaint(job, act, toolName, input);
    this.trackBuildEdit(job, act, toolName, input);
    for (const m of this.modules) {
      try { m.onToolUse?.(job.agentId, job.taskId, toolName); } catch { /* ignore */ }
    }
  }

  /**
   * Smart asks for build and test commands once an agent changed a build or script file (Task 27). A file tool whose target is one, or a shell
   * command that may write (level 2 or more) and names one, flags the run's start project; with no project the run itself carries the flag.
   * A command that only reads such a file is level 1 and sets nothing. Stricter by design: a command that names the file and writes elsewhere also sets it.
   */
  private trackBuildEdit(job: Job, act: Active, toolName: string, input: unknown): void {
    const o = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    let hit = false;
    const field = WRITE_FILE_TOOLS[toolName] ?? BUILD_EDIT_EXTRA_FILE_TOOLS[toolName];
    const projectFolder = this.projectOf(job.taskId, job.agentId)?.folder;
    if (field) {
      const given = o[field];
      if (typeof given === 'string' && given !== '') {
        const root = toolName.startsWith('mcp__host__') ? this.hostRootOf(this.store.getAgent(job.agentId) ?? { id: job.agentId } as AgentProfile) : this.agentCwd(job.agentId);
        const target = TaintedPaths.resolvePath(root, given);
        // `scripts/` means the project's scripts folder: a project that lives under a folder called scripts must not flag on every edit
        const rel = projectFolder ? relative(projectFolder, target) : '';
        hit = isBuildFile(rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : target);
      }
    } else if (SHELL_TOOLS.has(toolName) && typeof o.command === 'string') {
      const folder = projectFolder ?? this.agentCwd(job.agentId);
      hit = o.command.split(/[\s;&|<>()"'`=,:]+/).some((t) => t !== '' && isBuildFile(t)) && classifySafe({ kind: 'approval', toolName, input, projectFolders: folder ? [folder] : [], home: homedir() }).level >= 2;
    }
    if (!hit) return;
    const pid = startProjectOf(job);
    if (pid && this.gates?.buildEdited) this.gates.buildEdited.set(pid); else act.buildEdited = true;
  }

  /** What the run's commands may inherit: keys, tokens and passwords are scrubbed unless the owner switched `env-scrub` off for the project the run started in (then everything passes), else the signed keep list applies. */
  private scrubFor(job: Job): ScrubOpts & { scrub?: boolean } {
    if (this.gates?.gate('env-scrub', startProjectOf(job)) === false) return { scrub: false };
    return { keep: this.gates?.envKeep?.() ?? [] };
  }
  /**
   * Folder trust (security finding H1). A repository's own Claude Code settings and skills can run commands (hooks, env, helpers, a skill's hooks and
   * allowed tools) and a Claude Code SDK run never asks whether to trust the folder (code.claude.com/docs/en/permissions, "What runs before you trust a
   * folder"). So at every start the run's folder and each added directory are scanned. Nothing executable there, or every such folder trusted at exactly
   * the content found now: all sources, as before. Otherwise the user source only, the repository's CLAUDE.md and rules go into the prompt as plain text,
   * and the thread and the activity log say which commands, helpers and variable NAMES were held back (never a value). Inherit off: no sources, no notice.
   */
  private folderTrustFor(job: Job, agent: AgentProfile, act: Active, cwd: string, addDirs: string[]): { sources: NonNullable<Options['settingSources']>; text: string; mcpHeld: boolean } {
    const inherit = this.config.claude.inheritClaudeCodeSettings === true;
    // .mcp.json counts only when the owner let Claude Code's MCP servers in: with the switch off, strictMcpConfig below already blocks it
    const r = assessRun({ cwd, addDirs, trusted: this.gates?.trustedFolders?.() ?? [], inherit, mcp: this.config.claude.inheritMcp === true });
    if (!r.held.length) return { sources: r.sources, text: '', mcpHeld: false };
    try { this.noteFolderHeld(job, agent, act, r.held); } catch { /* the notice is advisory; the run is held back either way */ }
    let text = '';
    try { text = readInstructions(cwd).text; } catch { /* no instructions text this run */ }
    return { sources: r.sources, text, mcpHeld: r.held.some((h) => h.mcp) };
  }

  /**
   * A settings or skill file changed while the run works (security finding A-H2). Claude Code loads such a change in the same session
   * (code.claude.com/docs/en/hooks, ConfigChange: "Runs when a configuration file changes during a session"), so a `git checkout` or a clone
   * into the working folder could bring in a hook nobody trusted. For the project and local settings and the skills, the folders are scanned
   * again exactly as at run start; anything executable that is not trusted at exactly the content found now blocks the change, with the
   * folder-trust notice in the thread. A run that was held back at start does not load these sources anyway; blocking there is harmless.
   * The user and managed settings go on.
   */
  private configChangeAnswer(job: Job, agent: AgentProfile, act: Active, cwd: string, addDirs: string[], input: HookInput): SyncHookJSONOutput {
    if (input.hook_event_name !== 'ConfigChange') return { continue: true };
    if (input.source !== 'project_settings' && input.source !== 'local_settings' && input.source !== 'skills') return { continue: true };
    const block = 'This folder\'s Claude Code settings or skills changed during the run, and the folder is not trusted with the new content, so Legion did not load the change.';
    let held: FolderScan[];
    try {
      // the trusted list is read now: the owner may have trusted the folder while the run works
      held = assessRun({ cwd, addDirs, trusted: this.gates?.trustedFolders?.() ?? [], inherit: this.config.claude.inheritClaudeCodeSettings === true, mcp: this.config.claude.inheritMcp === true }).held;
    } catch { return { decision: 'block', reason: block }; }
    if (!held.length) return { continue: true };
    try { this.noteFolderHeld(job, agent, act, held, true); } catch { /* the notice is advisory; the change is blocked either way */ }
    return { decision: 'block', reason: block };
  }

  /** `midRun`: the scan was made because a settings or skills file changed while the run works, so the run already loaded what it had at its start. */
  private noteFolderHeld(job: Job, agent: AgentProfile, act: Active, held: FolderScan[], midRun = false): void {
    const folders = held.map((h) => ({ folder: h.folder, lines: h.lines, more: h.more }));
    const key = JSON.stringify(folders);
    const already = this.store.listMessages(job.taskId).some((m) => m.folderTrust && JSON.stringify(m.folderTrust.folders) === key);
    if (!already) {
      const extra = (!midRun && held.some((h) => h.mcp) ? ' MCP servers from your Claude Code setup were off for this run too, because a .mcp.json here would start programs.' : '')
        + (held.some((h) => h.lines.some((l) => l.startsWith('Skill file '))) ? ' A skill whose header only mentions hooks or allowed tools is counted too.' : '');
      const body = folders.map((f) => `${f.folder}\n${f.lines.map((l) => `- ${l}`).join('\n')}${f.more ? `\n- and ${f.more} more` : ''}`).join('\n\n');
      const lead = midRun
        ? 'A settings change in this folder during the run was held back: it carries commands you have not trusted.'
        : "This folder's own Claude Code settings and skills can run commands, and you have not trusted it, so this run used your user settings only. Its CLAUDE.md and rules were read as text instead.";
      const trust = midRun ? 'To let them run in your next run, choose Trust this folder on this notice.' : 'To let them run, choose Trust this folder on this notice.';
      this.addMessage(job.taskId, 'system', `${lead} What was held back:\n${body}\n${extra ? `${extra.trim()}\n` : ''}${trust} Settings, Gates, Fine tuning, "${TRUSTED_FOLDERS_LABEL}" lists the folders you trusted and removes them.`, undefined, undefined, { folderTrust: { folders } });
    }
    if (!act.folderTrustNoted) {
      act.folderTrustNoted = true;
      const n = held.reduce((a, h) => a + h.lines.length, 0);
      this.activity?.append({ kind: 'note', text: `Folder not trusted, its Claude Code settings were held back (${n} item${n === 1 ? '' : 's'}): ${held.map((h) => trustPlain(h.folder, 120)).join(', ')}`, taskId: job.taskId, agentId: agent.id });
    }
  }

  /**
   * The one line that tells a run which environment variables Legion held back from its commands: NAMES only, never a value, and where the
   * owner can keep one. Empty when nothing was held back or the scrub is off. The names also go to the activity log, once per run.
   */
  private heldBackNote(job: Job, agent: AgentProfile, act: Active, consumers: { child: boolean; host: boolean }): string {
    try {
      const s = this.scrubFor(job);
      if (s.scrub === false) return '';
      const raw = scrubHostSessionEnv({ ...process.env });
      const keep = s.keep ?? [];
      // Worked out for each place a command can start: the Claude child keeps the cloud logins when the CLI is set up for them (buildChildEnv), the
      // agent's host shell never does (buildHostShellEnv). The line lists the names either of them lacks, so it never says less than what happened.
      const providerAuth = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some((k) => raw[k]);
      const all = new Set<string>([
        ...(consumers.child ? heldBackNames(raw, { keep, providerAuth }) : []),
        ...(consumers.host ? heldBackNames(raw, { keep }) : []),
      ]);
      const names = [...all].sort((x, y) => x.localeCompare(y));
      if (!names.length) return '';
      const shown = names.slice(0, 30).join(', ') + (names.length > 30 ? ` and ${names.length - 30} more` : '');
      if (!act.heldBackNoted) {
        act.heldBackNoted = true;
        this.activity?.append({ kind: 'note', text: `Held back from commands: ${shown}`, taskId: job.taskId, agentId: agent.id });
      }
      const inProject = startProjectOf(job) !== undefined;
      return `Legion held back these environment variables from your commands: ${shown}. They look like keys, tokens or passwords, or they make a program load other code. If a command needs one, tell the user which one and why, and say they can keep that one variable in Settings, Gates, Fine tuning, "${ENV_KEEP_LABEL}".${inProject ? ' To pass every held-back variable at once, they can turn off "Keep keys and passwords out of commands" for this project in Settings, Gates. That passes all of them, not only one.' : ''}`;
    } catch { return ''; }
  }
  private childScrubFor(job: Job): { scrub: false | ScrubOpts } {
    const s = this.scrubFor(job);
    return { scrub: s.scrub === false ? false : { keep: s.keep ?? [] } };
  }

  /** The folder of the project this run started in: where its build files are fingerprinted. */
  private startFolderOf(job: Job): string | undefined {
    const pid = startProjectOf(job);
    return pid ? this.projects?.get(pid)?.folder : undefined;
  }

  /** Whether an agent changed a build or script file in the project this run started in, and no build or test command was allowed since; the snapshot goes with the card. */
  private buildCheck(job: Job): { flagged: boolean; snap?: BuildSnapshot } {
    const pid = startProjectOf(job);
    if (pid && this.gates?.buildEdited) return this.gates.buildEdited.check(pid, this.startFolderOf(job));
    return { flagged: this.active.get(job.taskId)?.buildEdited === true };
  }

  /** The owner allowed the card the flag caused: the flag goes (for the project, or for a run with no project), unless a build file changed while the card was open. */
  private clearBuildEdited(job: Job, snap?: BuildSnapshot): void {
    const pid = startProjectOf(job);
    if (pid && this.gates?.buildEdited) this.gates.buildEdited.clear(pid, snap, this.startFolderOf(job));
    else { const act = this.active.get(job.taskId); if (act) act.buildEdited = false; }
  }

  /**
   * Taint follows files: what a tainted run Writes or Edits is marked, and a later run that reads a marked file (or searches a
   * tree that holds one) is tainted before the tool runs. A clean run that rewrites a whole file takes the mark off it.
   */
  private trackWorkspaceTaint(job: Job, act: Active, toolName: string, input: unknown): void {
    const o = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const cwd = this.agentCwd(job.agentId);
    const arg = (field: string | undefined): string | undefined => (field && typeof o[field] === 'string' && o[field] ? TaintedPaths.resolvePath(cwd, o[field] as string) : undefined);
    const w = arg(WRITE_FILE_TOOLS[toolName]);
    if (w) {
      if (act.tainted) this.taintedPaths.mark(w);
      else if (toolName === 'Write') this.taintedPaths.unmark(w);
      return;
    }
    if (act.tainted) return;
    const r = arg(READ_FILE_TOOLS[toolName]);
    if (r) { if (this.taintedPaths.has(r)) act.tainted = true; return; }
    if (SEARCH_TOOLS.has(toolName)) {
      const root = typeof o.path === 'string' && o.path ? TaintedPaths.resolvePath(cwd, o.path) : TaintedPaths.resolvePath(cwd, '.');
      if (this.taintedPaths.touches(root)) act.tainted = true;
    }
  }

  /** Where the agent shell runs and its file paths resolve (host-tools.ts resolveWithin). */
  private hostRootOf(agent: AgentProfile): string {
    return agent.host?.rootDir ?? agent.cwd ?? join(this.config.workspaceDir, agent.id);
  }

  /**
   * The folder a tool call's relative paths mean, so a path gate rule reads `secrets/key.txt` as the file it names: the
   * agent shell's root for its own tools (or the folder a shell call names as its cwd, such as the project folder: review #4),
   * the agent's working folder for everything else.
   */
  private gateCwd(agent: AgentProfile, toolName: string, input?: Record<string, unknown>): string {
    if (!toolName.startsWith('mcp__host__')) return agent.cwd || join(this.config.workspaceDir, agent.id);
    const root = this.hostRootOf(agent);
    const cwd = toolName === 'mcp__host__shell' && typeof input?.cwd === 'string' && input.cwd.trim() ? input.cwd : undefined;
    return cwd ? resolve(root, nativePath(cwd)) : root;
  }

  private agentCwd(agentId: string): string {
    const agent = this.store.getAgent(agentId);
    return agent?.cwd || join(this.config.workspaceDir, agentId);
  }

  /**
   * What every card raised inside a run carries for the away features: the task's project (so the ask is counted where the work is, with no
   * task join) and what saying yes would do. The classifier is fail-safe: anything it cannot read is level 3, not certain.
   */
  private askExtras(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>): { projectId?: string; consequence: ReturnType<typeof classifySafe> } {
    const projectId = this.store.getTask(job.taskId)?.projectId;
    // "inside" means inside the project's folder, else inside the agent's own working folder: with neither there is nothing to check against
    const folder = this.projectOf(job.taskId, agent.id)?.folder ?? this.agentCwd(agent.id);
    return { ...(projectId ? { projectId } : {}), consequence: classifySafe({ kind: 'approval', toolName, input, projectFolders: folder ? [folder] : [], home: homedir() }) };
  }

  /**
   * The built-in web tools the owner's providers replace, per capability: a picked search provider forbids WebSearch, a picked read provider
   * forbids WebFetch. One path means one gate and one place the text goes; a provider that only searches leaves page reads with the built-in tool.
   */
  private webToolsReplaced(): string[] {
    return [...(this.webSearch?.searchOn() ? ['WebSearch'] : []), ...(this.webSearch?.readOn() ? ['WebFetch'] : [])];
  }

  /** One line in the activity log for a provider call: provider, tool, the host of a read target and the charge. Never the query or the address. */
  private noteWebCall(taskId: string, agentId: string, projectId: string | undefined, e: { provider: string; tool: string; host?: string; micro?: number }): void {
    try {
      this.activity?.append({
        kind: 'web-call', text: `Web: ${e.provider} ${e.tool}${e.host ? ` ${e.host}` : ''}`, taskId, agentId, ...(projectId ? { projectId } : {}),
        data: { provider: e.provider, tool: e.tool, ...(e.host ? { host: e.host } : {}), ...(e.micro !== undefined ? { micro: e.micro } : {}) },
      });
    } catch { /* advisory */ }
    // A paid call that reports its charge (micro-dollars) goes to the same spend ledger as the model's cost, with the task, agent and project,
    // so the owner's optional project budget and Show costs include it. No limit and no card of its own (owner ruling 2026-10-18). A call that
    // reports no charge records nothing.
    // noteSpend takes the agent and project from the task, the same as the model's own cost does, so the two always land on the same project.
    if (typeof e.micro === 'number' && e.micro > 0) this.noteSpend(taskId, e.micro / 1_000_000);
  }

  /**
   * Maintainer decision 2026-10-07: in a run that read connector data AND is tainted, WebFetch and WebSearch need an approval card even in
   * full mode: web access could carry that data out. Like the connector gateway's writes this raises its own card (never through guardAsk).
   * Returns undefined when no card is due, else the decision. Used by canUseTool and the provider path (toolDecider) and, in bypass mode where
   * canUseTool does not exist, by a PreToolUse hook.
   */
  private webEgressCard(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>): Promise<{ allow: boolean; message?: string }> | undefined {
    const kind = webKind(toolName);
    if (!kind) return undefined;
    const used = this.store.getTask(job.taskId)?.usedConnectors === true;
    const tainted = this.active.get(job.taskId)?.tainted === true || job.origin?.tainted === true;
    if (!used || !tainted) return undefined;
    const wi = webInput(toolName, input);
    const target = String(kind === 'WebFetch' ? wi.url ?? '' : wi.query ?? '').slice(0, 1000);
    const o = job.origin;
    let timedOut = false; let waited: number | undefined;
    return this.approvals.request(job.taskId, agent.id, toolName, input, o ? { roomId: o.roomId, fromAgentId: o.fromAgentId, hop: o.hop } : undefined, {
      onTimeout: (ms) => { timedOut = true; waited = ms; },
      ...this.askExtras(job, agent, toolName, input),
      summary: `${toolName.replace(/^mcp__legion__/, "")}: ${target}
This run read connector (GitHub) data and other outside text. Web access can send that data out. Check the address or query before you allow it.`,
    }).then((allowed) => allowed ? { allow: true } : { allow: false, message: timedOut ? `No one answered the approval request within ${this.waitedText(waited)}, so this web request was not run.` : 'The user denied this web request.' });
  }

  /**
   * Claude agents follow Claude's own permission checks (the app's gate setting `claudeOwnChecks`, on unless the owner turned it off). With no gates
   * core there is no setting to read, and the run keeps Legion's own cards as before.
   */
  claudeOwnChecks(): boolean {
    try {
      const store = this.gates?.store;
      const app = store?.app();
      if (!store || !app) return false;
      // an app file that cannot be trusted (unreadable, damaged, changed outside Legion, unverified, or its key lost) would read as blank, and blank means on:
      // the stricter old path is used instead, and only the owner's own save turns Claude's checks on again
      const v = store.view([]);
      if (v.changedOutside.includes('app') || v.unreadable.includes('app') || v.keyUnreadable) return false;
      return app.claudeOwnChecks !== false;
    } catch { return false; }
  }

  private readonly docsHosts: ReadonlySet<string> = loadDocsHosts();
  /** Guard cards in flight or just answered, by (task, tool, input): the PreToolUse hook and canUseTool both ask, and the owner sees one card. */
  private readonly guardMemo = new Map<string, { p: Promise<{ allow: boolean; message?: string }>; doneAt?: number }>();

  /** What the run did on the web (a run that is not live gets a throwaway session: nothing is remembered for it). */
  private webSessionOf(job: Job): WebSession { return this.active.get(job.taskId)?.web ?? new WebSession(); }

  /**
   * Whether a site opens with no card: the built-in docs list (while the web-reads gate is on), a site the owner approved in the signed site list,
   * or a site the owner allowed for this goal. The host is canonical (lower case, no trailing dot) and the match is exact: a sub-domain is another site.
   * A relay host is never trusted here (webVerdict asks for it whatever this says).
   */
  private siteTrusted(job: Job, host: string): boolean {
    if (this.gates?.gate('web-reads', startProjectOf(job)) !== false && this.docsHosts.has(host)) return true;
    if ((this.gates?.store?.app().allowedHosts ?? []).includes(host)) return true;
    return this.webSessionOf(job).goalTrusts(host);
  }

  /**
   * The guards that raise their own card ahead of every allow: a gate rule, Claude Code's own allow rules or a mode that waves the call through
   * cannot skip one. Called by toolDecider (canUseTool and the provider path) and by a PreToolUse hook, after a gate deny and the shell floor.
   * Order: (1) the web check, (2) protected path (Task 23), (3) secret-file read (Task 24). The first that returns a card wins and its answer is final
   * for that call. Every card carries `noRemember`. An identical call (same task, tool and input) shares the card for 5 seconds after it opens or is answered,
   * so the hook and canUseTool raise one card. Returns undefined when no guard has anything to say.
   */
  private askGuards(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, mode: RunMode, native = false): Promise<{ allow: boolean; message?: string }> | undefined {
    const key = `${job.taskId}\u0000${toolName}\u0000${canonicalJson(input)}`;
    const hit = this.guardMemo.get(key);
    if (hit && (hit.doneAt === undefined || Date.now() - hit.doneAt < GUARD_MEMO_MS)) return hit.p;
    if (this.guardMemo.size > 200) for (const [k, e] of this.guardMemo) if (e.doneAt !== undefined && Date.now() - e.doneAt >= GUARD_MEMO_MS) this.guardMemo.delete(k);
    // a run woken by an outside app or another bot keeps Legion's full guards: the confused-deputy guard is Legion's own, Claude cannot know about it
    native = native && !job.origin?.approvalCeiling;
    // a Claude agent on Claude's own checks: the new-site check for Claude's own WebFetch and WebSearch and the protected-path card are Claude's to judge, and of the
    // secret files only Legion's own stay guarded. Legion's own web tools (web_read, web_search) are not Claude's: they keep the new-site check.
    const claudeWeb = native && !isLegionTool(toolName);
    if (claudeWeb) this.logClaudeWeb(job, agent, toolName, input, mode);
    const card = (claudeWeb ? undefined : this.webGuard(job, agent, toolName, input, mode))
      ?? (native ? undefined : this.protectedPathGuard(job, agent, toolName, input, mode))
      ?? this.secretReadGuard(job, agent, toolName, input, mode, native);
    if (!card) return undefined;
    const entry: { p: Promise<{ allow: boolean; message?: string }>; doneAt?: number } = { p: card };
    const done = (): void => { entry.doneAt = Date.now(); };
    card.then(done, done);
    this.guardMemo.set(key, entry);
    return card;
  }

  /**
   * The ask-mode hook's cards after the gate deny and the floor: the guards first, then Legion's own cards (`own`, toolDecider with ownOnly).
   * The owner's own Claude Code allow rules may skip the plain card (owner ruling 2026-10-18); Legion's own cards may not. So a call none of
   * them is due for goes on as before (continue): the plain card of the preset stays in canUseTool, and nothing new cards (an `ls` or an
   * in-folder read the SDK approves itself stays free). Every answer is kept for canUseTool by the call's id, so the call gets one card.
   */
  private async hookCards(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, mode: RunMode, toolUseId: string | undefined, own: (t: string, i: Record<string, unknown>) => Promise<Decision | undefined>, native = false, egressHere = true): Promise<{ continue: true } | ReturnType<typeof preToolDeny> | ReturnType<typeof preToolAllow>> {
    const card = this.askGuards(job, agent, toolName, input, mode, native);
    if (card) {
      const d = await card;
      if (!d.allow) { this.noteHookDecided(job, toolUseId, d); return preToolDeny(d.message ?? 'The user denied this web request.'); }
      // allowing here skips canUseTool, which is where the web-egress card is raised: raise it now
      const egress = egressHere ? this.webEgressCard(job, agent, toolName, input) : undefined;
      if (egress) { const e = await egress; if (!e.allow) { this.noteHookDecided(job, toolUseId, e); return preToolDeny(e.message ?? 'The user denied this web request.'); } }
      this.noteHookDecided(job, toolUseId, { allow: true });
      return preToolAllow('The owner approved this site on its card.');
    }
    const d = await own(toolName, input);
    if (!d) return { continue: true };
    this.noteHookDecided(job, toolUseId, d);
    if (!d.allow) return preToolDeny(d.message ?? 'The user denied this action.');
    // the input goes back unchanged, as canUseTool's allow does: a tool such as ExitPlanMode needs it with a hook allow (hooks doc, "allow with updatedInput")
    return preToolAllow('The owner approved this call on its card.', input);
  }

  /** Calls a PreToolUse hook decided on a card, by (task, tool use id), until canUseTool reads them or a minute passes. */
  private readonly hookDecided = new Map<string, { d: Decision; at: number }>();
  private noteHookDecided(job: Job, toolUseId: string | undefined, d: Decision): void {
    if (!toolUseId) return;
    if (this.hookDecided.size > 200) for (const [k, e] of this.hookDecided) if (Date.now() - e.at >= HOOK_DECIDED_MS) this.hookDecided.delete(k);
    this.hookDecided.set(`${job.taskId}\u0000${toolUseId}`, { d, at: Date.now() });
  }
  private takeHookDecided(job: Job, toolUseId: string | undefined): Decision | undefined {
    if (!toolUseId) return undefined;
    const key = `${job.taskId}\u0000${toolUseId}`;
    const e = this.hookDecided.get(key);
    this.hookDecided.delete(key);
    return e && Date.now() - e.at < HOOK_DECIDED_MS ? e.d : undefined;
  }

  /**
   * Guard (2): a change to Git internals and hooks, editor and agent settings, shell startup files or package manager settings asks, in every mode
   * but Full. The switch is the `protected-path-cards` gate. A file target is resolved against the agent's folder; inside the project folder (or the
   * agent's own) it is tested relative to that folder, so a project that lives under a folder with a protected name is not carded on every write.
   */
  private protectedPathGuard(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, mode: RunMode): Promise<{ allow: boolean; message?: string }> | undefined {
    if (mode === 'full' || this.gates?.gate('protected-path-cards', startProjectOf(job)) === false) return undefined;
    const folder = this.projectOf(job.taskId, agent.id)?.folder ?? this.agentCwd(agent.id);
    const cwd = this.gateCwd(agent, toolName, input);
    const resolveTarget = (t: string): string => {
      const abs = resolve(cwd, nativePath(t));
      const rel = folder ? relative(resolve(folder), abs) : undefined;
      return rel !== undefined && rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
    };
    const hit = protectedWriteHit(toolName, input, this.askExtras(job, agent, toolName, input).consequence.level, resolveTarget);
    if (!hit) return undefined;
    return this.guardCard(job, agent, toolName, input, `Legion wants to change ${hit}. A change there can run code ${startsAtLogin(hit) ? 'when you log in or open a shell' : 'the next time you use Git'}, or change what an agent may do.`);
  }

  /**
   * Legion's own key files count as secret files by where they are: the providers and connectors folders (API keys, tokens, their data keys),
   * the gates folder and the gates key, taken from the same protected set the file tools use for writes. A path is resolved against the call's
   * folder (a leading `~` or `$HOME` means the home folder). The rest of the data folder (config, state, projects, workspaces) is not secret.
   * A search that starts at the data folder, a folder above it or a folder between it and a key folder also counts (it reaches the key files),
   * as long as its glob can match a key file name. A `cd` earlier in the same command changes the folder its words mean (see secret-paths.ts).
   * Gap: a `cd` in an earlier call of the run, or a path built when the command runs, is not seen.
   */
  private dataSecretLocation(agent: AgentProfile, toolName: string, input: Record<string, unknown>): SecretLocation | undefined {
    const roots = this.protectedDirs().filter((t) => SECRET_DATA_NAMES.has(basename(t).toLowerCase()));
    if (!roots.length) return undefined;
    const base = this.gateCwd(agent, toolName, input);
    let canon: string[] | undefined; // worked out on the first path that is asked about: most tool calls never ask
    let names: string[] | undefined; // the file names under the key folders, read on the first glob that is asked about
    // PowerShell reads `\` as a folder separator on Linux and macOS too, so there a `\` counts as one (a name that really holds a `\` asks, never the other way)
    const own = (p: string): string => (process.platform === 'win32' ? nativePath(p) : p.replace(/\\/g, '/'));
    const at = (p: string, cwd?: string): string => canonicalLocal(own(p), { cwd: cwd === undefined ? base : own(cwd) });
    const inside = (p: string, cwd?: string): boolean => { try { canon ??= canonicalSet(roots); return hitsCanonical(at(p, cwd), canon); } catch { return false; } };
    const reaches = (p: string, cwd?: string): boolean => { try { canon ??= canonicalSet(roots); return hitsCanonical(at(p, cwd), canon, true); } catch { return false; } };
    const globReaches = (glob: string): boolean => { names ??= secretFileNames(roots); return globMatchesAny(glob, names); };
    return { cwd: base, dataFolder: dirname(roots[0]!), inside, reaches, globReaches };
  }

  /** Guard (3): reading a password or key file asks, in every mode but Full. The switch is the `secret-file-reads` gate. */
  private secretReadGuard(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, mode: RunMode, native = false): Promise<{ allow: boolean; message?: string }> | undefined {
    if (mode === 'full' || this.gates?.gate('secret-file-reads', startProjectOf(job)) === false) return undefined;
    const where = this.dataSecretLocation(agent, toolName, input);
    // a Claude agent on Claude's own checks: only Legion's own key folders are guarded here, every other secret path is Claude's to judge
    if (native && !where) return undefined;
    const found = secretReadDetail(toolName, input, native && where ? { ...where, legionOnly: true } : where);
    if (!found) return undefined;
    // always the full path; a search folder that only CONTAINS Legion's key folders says so, so the owner sees why a plain search asks
    const summary = found.search && where
      ? `An agent wants to search ${found.path}. Legion's key files are inside it (${where.dataFolder}), so the search can read your passwords and keys.`
      : `Legion wants to read ${found.path}. It may hold passwords or keys.`;
    return this.guardCard(job, agent, toolName, input, summary);
  }

  /** The card every guard raises: no Remember (no tool-wide rule can pass a guard), and the answer is final for this call. */
  private guardCard(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, summary: string): Promise<{ allow: boolean; message?: string }> {
    const o = job.origin;
    let timedOut = false; let waited: number | undefined;
    return this.approvals.request(job.taskId, agent.id, toolName, input, o ? { roomId: o.roomId, fromAgentId: o.fromAgentId, hop: o.hop } : undefined, {
      onTimeout: (ms) => { timedOut = true; waited = ms; },
      ...this.askExtras(job, agent, toolName, input),
      noRemember: true,
      summary,
    }).then((allowed) => {
      if (allowed) return { allow: true };
      const stop = 'Do not retry it, rephrase it or reach the same result another way. Stop, tell the user what you needed it for, and wait for their answer.';
      return { allow: false, message: timedOut ? `No one answered the approval request within ${this.waitedText(waited)}, so this was not done. ${stop}` : `The user has not approved this. ${stop}` };
    });
  }

  /** Guard (1): a new site asks, a built-in docs or approved site opens. Notes an allowed read (host only, never the address) and counts its path. */
  private webGuard(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, mode: RunMode): Promise<{ allow: boolean; message?: string }> | undefined {
    if (!webChecksApply(mode, toolName) || this.gates?.gate('web-reads', startProjectOf(job)) === false) return undefined;
    const sess = this.webSessionOf(job);
    const v = webVerdict({ tool: webKind(toolName)!, input: webInput(toolName, input) }, { trusted: (h) => this.siteTrusted(job, h), pathsSeen: (h) => sess.pathsSeen(h), builtIn: (h) => this.docsHosts.has(h), secretRead: sess.secretRead });
    if (v.kind === 'ask') return this.askWeb(job, agent, toolName, input, v);
    this.noteWebRead(job, agent, toolName, input, v.host);
    return undefined;
  }

  /**
   * Claude's own WebFetch and WebSearch are Claude's to judge: this writes the "Web: host" line of the activity log and nothing else (no card, no budget count).
   * The line is written at the hook, before Claude's checker decides, so it records what the agent tried.
   */
  private logClaudeWeb(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, mode: RunMode): void {
    if (!webChecksApply(mode, toolName) || this.gates?.gate('web-reads', startProjectOf(job)) === false) return;
    let host = '';
    try { if (webKind(toolName) === 'WebFetch') host = new URL(String(webInput(toolName, input).url)).hostname.toLowerCase(); } catch { /* the line then has no host */ }
    try { this.activity?.append({ kind: 'note', text: `Web: ${toolName} ${host}`.trim(), taskId: job.taskId, agentId: agent.id }); } catch { /* advisory */ }
  }

  /** A web read went through (allowed by the check or by the owner's answer): count its path for the budget, date the site, and log the host. */
  private noteWebRead(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, host: string | undefined): void {
    if (host) {
      let path = '/'; try { path = new URL(String(webInput(toolName, input).url)).pathname; } catch { /* the check already read it */ }
      this.webSessionOf(job).noteFetch(host, path);
      this.publishWeb(job.taskId);
      try { this.gates?.webLastUsed?.touch(host); } catch { /* advisory */ }
    }
    try { this.activity?.append({ kind: 'note', text: `Web: ${toolName.replace(/^mcp__legion__/, '')} ${host ?? ''}`.trim(), taskId: job.taskId, agentId: agent.id }); } catch { /* advisory */ }
  }

  /** The mode the run starts with and the project it starts in, for the "Runs as" chip. A resolver that throws reads as Ask. */
  private runsAsOf(job: Job, agent: AgentProfile): NonNullable<Task['runsAs']> {
    let mode: RunMode = 'ask';
    try { mode = this.modeNow(job, agent); } catch { /* fails closed */ }
    const projectId = startProjectOf(job);
    return { mode, ...(projectId ? { projectId } : {}) };
  }

  /** Puts what the live run has read on the web onto its task (counts only), when the counts changed. A run that read nothing keeps no summary. */
  private publishWeb(taskId: string): void {
    try {
      const s = this.active.get(taskId)?.web.summary();
      if (!s || s.pages <= 0) return;
      const cur = this.store.getTask(taskId);
      if (!cur || (cur.web?.pages === s.pages && cur.web?.newSites === s.newSites)) return;
      this.patchTask(taskId, { web: s });
    } catch { /* advisory: a chip never changes a run */ }
  }

  /** New sites raised together by one run, waiting to go out as one card (see `askWeb`). */
  private readonly webBatches = new Map<string, WebBatch>();

  /**
   * The card for a web call the check did not let through; its answer decides this call. Calls to new sites raised together (a model asks for
   * several pages in one turn) go out as ONE card listing the sites, and one answer covers all of them. The window is short: the first
   * call opens it, and the card goes out a moment later with every new site that arrived by then.
   */
  private askWeb(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, v: Extract<WebVerdict, { kind: 'ask' }>): Promise<Decision> {
    return new Promise<Decision>((resolveCall) => {
      const entry: WebBatchEntry = { toolName, input, v, resolve: resolveCall };
      // only a plain new site is batched: a card with its own reason (a query, a port, a long search) says so on its own
      if (!(v.why === 'new-host' && v.host && webKind(toolName) === 'WebFetch')) { void this.raiseWebCard(job, agent, [entry]); return; }
      let batch = this.webBatches.get(job.taskId);
      if (!batch) {
        const b: WebBatch = { entries: [] };
        batch = b; this.webBatches.set(job.taskId, b);
        setTimeout(() => { this.webBatches.delete(job.taskId); void this.raiseWebCard(job, agent, b.entries); }, WEB_BATCH_MS);
      }
      batch.entries.push(entry);
    });
  }

  /** Raises the one card for these calls and applies the owner's answer to each: Always allow (the site list), Allow for this goal, Allow once, or No. */
  private async raiseWebCard(job: Job, agent: AgentProfile, entries: WebBatchEntry[]): Promise<void> {
    const decide = (d: Decision): void => { for (const e of entries) e.resolve(d); };
    try {
      // a run that ended while the card waited to go out has nobody to answer for
      if (!this.active.has(job.taskId)) { decide({ allow: false, message: 'The run ended before this web request could be asked.' }); return; }
      const first = entries[0]!;
      const hosts = [...new Set(entries.map((e) => e.v.host ?? '').filter((h) => h !== ''))];
      const many = hosts.length > 1;
      const host = hosts[0] ?? '';
      let path = '', search: string | undefined;
      // the summary is also written to the activity log: it holds the host and path only (`?...` when a query existed); the card shows the full address from the call's input
      if (webKind(first.toolName) === 'WebSearch') search = '';
      else { try { const u = new URL(String(webInput(first.toolName, first.input).url)); path = (u.pathname + (u.search ? '?...' : '')).slice(0, 160); } catch { path = ''; } }
      const signer = this.gates?.canAllowHosts?.() === true;
      const canAlways = signer && entries.every((e) => e.v.canAlways);
      const summary = many
        ? `${WEB_CARD.many(hosts.length, hosts)}\n${WEB_MANY_BODY}`
        : webCardSummary({ why: first.v.why, host: host || 'this address', path, ...(search !== undefined ? { search } : {}) });
      const o = job.origin;
      let timedOut = false; let waited: number | undefined; let id: string | undefined;
      const allowed = await this.approvals.request(job.taskId, agent.id, first.toolName, first.input, o ? { roomId: o.roomId, fromAgentId: o.fromAgentId, hop: o.hop } : undefined, {
        onTimeout: (ms) => { timedOut = true; waited = ms; },
        ...this.askExtras(job, agent, first.toolName, first.input),
        noRemember: true,
        summary: summary.slice(0, 390),
        site: { host, canAlways, ...(many ? { hosts } : {}) },
        ...(signer ? {} : { alwaysRefusal: "Always allow needs a key from your computer's keystore to sign the site list, and none is available. Use Allow for this goal or Allow once." }),
        onOpen: (req) => { id = req.id; },
      });
      const site = id ? this.approvals.takeSite?.(id) : undefined;
      if (!allowed) {
        if (timedOut) {
          try { this.activity?.append({ kind: 'note', text: `Waited for you on ${hosts.join(', ') || 'a web address'}`, taskId: job.taskId, agentId: agent.id }); } catch { /* advisory */ }
          decide({ allow: false, message: `No one answered the approval request within ${this.waitedText(waited)}, so this web request was not run.` });
        } else decide({ allow: false, message: 'The user denied this web request.' });
        return;
      }
      if (site === 'goal') for (const h of hosts) this.trustHostForGoal(job.taskId, h);
      if (site === 'always') this.allowHostsFromCard(job, agent, hosts);
      for (const h of hosts) this.webSessionOf(job).noteNewSite(h);
      for (const e of entries) { this.noteWebRead(job, agent, e.toolName, e.input, e.v.host); e.resolve({ allow: true }); }
    } catch (err) {
      // a failure here must never turn into a silent allow
      decide({ allow: false, message: 'Legion could not ask about this web request, so it was not run.' });
      try { this.activity?.append({ kind: 'note', text: `Web card failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), taskId: job.taskId, agentId: agent.id }); } catch { /* advisory */ }
    }
  }

  /**
   * The owner answered Always allow on a card: the sites join the signed site list (the same store path as a Settings edit, which signs it) with no native
   * confirm, because the card the owner answered is the confirmation. The change is logged like other gate changes. If the list cannot be written the
   * call still runs once (the owner said yes to it) and the log says the site was not saved.
   */
  private allowHostsFromCard(job: Job, agent: AgentProfile, hosts: string[]): void {
    void job; void agent;
    const log = (text: string): void => { try { this.activity?.append({ kind: 'gate-changed', text, data: { scope: 'app' } }); } catch { /* advisory */ } };
    const saved: string[] = [];
    for (const h of hosts) {
      try { this.gates?.allowHost?.(h); saved.push(h); } catch (err) { log(`Could not save ${h} to the site list: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300)); }
    }
    if (!saved.length) return;
    log('Site list changed for all projects (from a web card)');
    for (const h of saved) log(`Agents may read ${h} without asking.`);
    try { this.bus.emit({ type: 'gates.updated' }); } catch { /* advisory */ }
  }

  /** The owner allowed a site for this goal: it opens with no card for the rest of the run. (PR 2 keeps it for the run; the goal record will persist it.) */
  trustHostForGoal(taskId: string, host: string): void {
    const h = host.trim().toLowerCase().replace(/\.$/, '');
    if (h) this.active.get(taskId)?.web.trustForGoal(h);
  }

  /**
   * Whether the browser tool may open this address in Smart with no first-page card: the web check lets it through (a built-in docs site, an approved
   * site, or one allowed for this goal). False for anything that would ask, for a run that is not live, and when the web-reads gate is off for the run.
   */
  webReadAllows(taskId: string | undefined, _agentId: string, rawUrl: string): boolean {
    const act = taskId ? this.active.get(taskId) : undefined;
    if (!taskId || !act) return false;
    const job = { taskId, projectAtStart: act.projectAtStart, outsideOf: act.outsideOf } as unknown as Job;
    if (this.gates?.gate('web-reads', startProjectOf(job)) === false) return false;
    const v = webVerdict({ tool: 'browser_open', input: { url: rawUrl } }, { trusted: (h) => this.siteTrusted(job, h), pathsSeen: (h) => act.web.pathsSeen(h), builtIn: (h) => this.docsHosts.has(h), secretRead: act.web.secretRead });
    if (v.kind !== 'allow') return false;
    if (v.host) {
      try { this.gates?.webLastUsed?.touch(v.host); } catch { /* advisory */ }
      try { act.web.noteFetch(v.host, new URL(rawUrl).pathname); this.publishWeb(taskId); } catch { /* the check already read it */ }
    }
    return true;
  }

  /**
   * The safety floor for every shell an agent drives: Legion's own host shell AND Claude Code's Bash and PowerShell tools.
   * A catastrophic command (a whole drive, a system or home folder) or one that runs decoded or encoded text is refused, with
   * no card. A command the floor cannot read (its program is built when it runs: `$(echo rm)`, `$x`, `{a,b}`, `%X%`, or
   * another command's output piped into a shell) is never assumed safe: in the ask modes it gets a card with no Remember;
   * in Full it is refused at once with the reason and how to write it plainly, so a run nobody watches never waits on a card
   * (owner decision 2026-10-13). Undefined when the floor has nothing to say.
   */
  private shellFloor(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, opts: { card?: boolean; /** A Claude agent on Claude's own checks: only the refusals and the card for Legion's own data folder apply. */ native?: boolean; /** Claude's own bypass mode is in force for this run (it started in Full). */ bypass?: boolean } = {}): Promise<{ allow: boolean; message?: string }> | undefined {
    if (!SHELL_TOOLS.has(toolName)) return undefined;
    const command = typeof input?.command === 'string' ? input.command : '';
    if (!command) return undefined;
    const kind = shellKindOf(toolName);
    let why: string | undefined;
    // a run woken by an outside app or another bot keeps Legion's whole floor: the confused-deputy guard is Legion's own
    const native = opts.native === true && !job.origin?.approvalCeiling;
    try {
      // a command too long to read is not read (that would hold up the core): it goes straight to the owner's card
      if (command.length <= MAX_READABLE) {
        const refused = refuseCatastrophic(command, kind);
        if (refused) return Promise.resolve({ allow: false, message: refused });
      }
      // the card is raised in one place per call: where the call is decided first (the ask-mode hook owns it for Claude's tools)
      // a catastrophic command hidden under three or more substitutions is past the depth the refusal reads (it stops at two): read it flat, so the nesting hides nothing.
      // The refusal is Legion's own; the card for what it cannot read is Claude's to give.
      // (only for a command short enough to read whole; a longer one is read in windows, below)
      if (native && command.length <= MAX_READABLE && (command.match(/\$\(|`/g)?.length ?? 0) >= 3) {
        const deep = refuseCatastrophic(command.replace(/\$\(|[`()]/g, ' '), kind);
        if (deep) return Promise.resolve({ allow: false, message: deep });
      }
      if (opts.card === false) return undefined;
      // a catastrophic command hidden in a command too long to read whole: Legion's card in every preset, Full included (Claude's own checker does not run in Full, and
      // padding must not step around the stop). Not a refusal: a long heredoc is everyday work. Without such text a long command goes on to Claude.
      // (over about 64,000 characters the command is not read at all, which would hold up the core: it is carded unread)
      if (native && command.length > MAX_READABLE) {
        const hit = longCatastrophic(command, kind);
        if (hit) return this.longCatastrophicCard(job, agent, toolName, input, hit);
      }
      // Claude's bypass mode skips its own check for a PowerShell `Remove-Item -Recurse` on the working folder or a folder above it (Claude Code docs, permission modes,
      // "Remove-Item in PowerShell"; Bash `rm` it still asks about, and that prompt reaches the owner through canUseTool). So in Full, for the PowerShell tool and for a
      // Windows delete command run from Bash (`cmd /c rd /s`), Legion adds the card: one card, a No denies. Read for every shell call of the run, so the folder a `cd` moved to is known.
      if (native && opts.bypass) {
        // (the folder a `cd` moved to is kept from call to call by this read; for Bash only a `cmd /c` or `powershell -c` script inside the command counts, `rm` is Claude's)
        // A text over MAX_READABLE is read with its blanks collapsed, so padding hides nothing. One that stays too long is not read: when it holds a recursive delete it is carded unread.
        const readable = (t: string, k: ShellKind): string | undefined => {
          if (t.length <= MAX_READABLE) return t;
          const c = collapsedText(t, k);
          return c !== undefined && c.length <= MAX_READABLE ? c : undefined;
        };
        const whole = readable(command, kind);
        const own = this.criticalDeleteTarget(job, agent, toolName, input, whole ?? command, kind);
        let critical = toolName === 'PowerShell' ? own : undefined;
        let unread = toolName === 'PowerShell' && whole === undefined ? recursiveDeleteSnippet(command) : undefined;
        if (!critical && toolName !== 'PowerShell') {
          for (const w of windowsShellTexts(command)) {
            const t = readable(w.text, w.kind);
            if (t === undefined) { unread ??= recursiveDeleteSnippet(w.text); continue; }
            critical = this.criticalDeleteTarget(job, agent, toolName, input, t, w.kind, false);
            if (critical) break;
          }
        }
        if (critical) {
          return this.criticalDeleteDecision(job, agent, toolName, input, command, critical, true).then((d) => d.allow ? (this.dataFolderCard(job, agent, toolName, input, command, kind, true) ?? d) : d);
        }
        if (unread !== undefined) {
          return this.longCatastrophicCard(job, agent, toolName, input, { kind: 'unread', reason: 'it deletes folders and is too long to tell whether one of them is your project folder', part: unread })
            .then((d) => d.allow ? (this.dataFolderCard(job, agent, toolName, input, command, kind, true) ?? d) : d);
        }
      }
      // Claude's own parser and checker handle what Legion cannot read, and Claude Code guards the project folder itself: only Legion's own files are left
      if (native) return this.dataFolderCard(job, agent, toolName, input, command, kind, true);
      // the project folder or a folder above it: a card in every mode but Full, a refusal in Full (read from the folder the shell is in)
      const critical = this.criticalDeleteTarget(job, agent, toolName, input, command, kind);
      if (critical) return this.criticalDeleteDecision(job, agent, toolName, input, command, critical);
      // Legion's own data folder: a command that changes it (or may, by a path built at run time) needs the owner's card in every mode
      // (in Full only when it names the gate settings, gates key, config, state or project list; Task 17 folds this into the askGuards pipeline)
      const folderCard = this.dataFolderCard(job, agent, toolName, input, command, kind);
      if (folderCard) return folderCard;
      why = unjudgeableCommand(command, kind);
    } catch {
      // fail closed: a floor that could not read the command refuses it for a Claude agent on Claude's own checks (no card: Claude reads the command, but a floor that
      // threw has not held), and asks the owner otherwise
      if (native) return Promise.resolve({ allow: false, message: 'Not run: the safety check could not read this command. Write it out plainly, one command at a time.' });
      if (opts.card === false) return undefined;
      why = 'the safety check could not read it';
    }
    if (!why) return undefined;
    const mode = this.modeNow(job, agent);
    if ((job.origin?.approvalCeiling ? stricterMode(mode, job.origin.approvalCeiling) : mode) === 'full') {
      return Promise.resolve({ allow: false, message: `Not run: Legion cannot read what this command will run (${why}), and with full access such a command is refused rather than asked about. Write it out plainly: name the program itself, not through a variable, a substitution or a pipe into a shell, and keep it under ${MAX_READABLE.toLocaleString('en-US')} characters. Then run it again. If it cannot be written plainly, do not look for another way around: tell the user what it was meant to do.` });
    }
    const o = job.origin;
    let timedOut = false; let waited: number | undefined;
    const shown = command.length > 1000 ? `${command.slice(0, 1000)}\n(${(command.length - 1000).toLocaleString('en-US')} more characters not shown here)` : command;
    return this.approvals.request(job.taskId, agent.id, toolName, input, o ? { roomId: o.roomId, fromAgentId: o.fromAgentId, hop: o.hop } : undefined, {
      onTimeout: (ms) => { timedOut = true; waited = ms; },
      ...this.askExtras(job, agent, toolName, input),
      noRemember: true,
      summary: `Legion cannot read what this command will run.\n${shown}\nWhy: ${why}.\nThe safety check cannot judge it by reading it, so you are asked in every approval mode. Allow it only if you know what it does.`,
    }).then((allowed) => {
      if (allowed) return { allow: true };
      const stop = 'Do not retry it, rephrase it or reach the same result another way. Stop, tell the user what the command was meant to do, and wait for their answer.';
      return { allow: false, message: timedOut ? `No one answered the approval request within ${this.waitedText(waited)}, so this command was not run (${why}). ${stop}` : `The user has not approved this command (${why}). ${stop}` };
    });
  }

  /** The call ids the owner said No to, so Claude's own "permission denied" line for the same call is not logged a second time. Capped: an id that never comes back is dropped, oldest first. */
  private rememberOwnerDenied(act: Active, id: string): void {
    const set = (act.ownerDenied ??= new Set());
    set.delete(id); set.add(id);
    while (set.size > 64) { const oldest = set.values().next().value; if (oldest === undefined) break; set.delete(oldest); }
  }

  /** The card for a command too long to read whole that holds catastrophic text. No Remember: no rule may skip it. */
  private longCatastrophicCard(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, hit: { kind: 'found' | 'unread'; reason: string; part: string }): Promise<{ allow: boolean; message?: string }> {
    const o = job.origin;
    let timedOut = false; let waited: number | undefined;
    const what = (hit.reason.replace(/^Refused: /, '').split(/\.\s/)[0] ?? 'dangerous').replace(/\.$/, '');
    const part = hit.part.length > 1000 ? `${hit.part.slice(0, 1000)}\n(${(hit.part.length - 1000).toLocaleString('en-US')} more characters not shown here)` : hit.part;
    const found = hit.kind === 'found';
    const why = found ? 'it holds dangerous text' : 'it is too long to check';
    return this.approvals.request(job.taskId, agent.id, toolName, input, o ? { roomId: o.roomId, fromAgentId: o.fromAgentId, hop: o.hop } : undefined, {
      onTimeout: (ms) => { timedOut = true; waited = ms; },
      // the card's consequence line is read from the start of the command only: classifying a megabyte would hold up the core
      ...this.askExtras(job, agent, toolName, typeof input.command === 'string' && input.command.length > MAX_READABLE ? { ...input, command: input.command.slice(0, MAX_READABLE) } : input),
      noRemember: true,
      summary: found
        ? `A very long command holds text that is dangerous: ${what}.\nThe dangerous part:\n${part}\nIt is too long for Legion to read whole, so you are asked in every approval mode. Allow it only if you know what it does.`
        : `Legion cannot check this command: ${what}.\n${part}\nA command this long could hide anything, so you are asked in every approval mode. Allow it only if you know what it does.`,
    }).then((allowed) => {
      if (allowed) return { allow: true };
      const stop = 'Do not retry it, rephrase it or reach the same result another way. Stop, tell the user what the command was meant to do, and wait for their answer.';
      return { allow: false, message: timedOut ? `No one answered the approval request within ${this.waitedText(waited)}, so this command was not run (${why}). ${stop}` : `The user has not approved this command (${why}). ${stop}` };
    });
  }

  /**
   * What a command deletes that holds the run's project: the project folder, the working folder, a folder above either, a glob
   * directly under one, or the home folder (Claude Code's critical paths). Read from the folder the shell is in: Claude's shell
   * keeps its folder between calls, so the folder a `cd` moved to is where the NEXT command is read; Legion's host shell takes one per call.
   */
  private criticalDeleteTarget(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, command: string, kind: ShellKind, track = true): string | undefined {
    // Claude's shell keeps its folder between calls (Legion's host shell takes one per call); a read with `track` off (a script inside the command) leaves the kept folders alone
    const shellKeeps = !toolName.startsWith('mcp__host__');
    const keeps = track && shellKeeps;
    const act = this.active.get(job.taskId);
    const start = this.gateCwd(agent, toolName, input);
    const folder = this.projectOf(job.taskId, agent.id)?.folder;
    const carried = shellKeeps && act ? act.critCwds : undefined;
    // a command too long to read is carded anyway; it may hold a cd, so the folder is not known after it
    if (command.length > MAX_READABLE) { if (keeps && act) act.critCwds = null; return undefined; }
    let r: ReturnType<typeof criticalDeleteRead>;
    try {
      // the run's start folder is shown as written; folders a cd reached are kept in the reader's plain form
      r = criticalDeleteRead(command, kind, { ...(carried === undefined ? { cwd: start } : carried ? { cwd: start, cwds: carried } : {}), roots: folder ? [folder] : [], home: homedir() });
    } catch (e) { if (keeps && act) act.critCwds = null; throw e; }
    // kept whether or not this call runs: the reader's list holds the folders before every cd as well as after
    if (keeps && act) act.critCwds = r.cwds?.length ? r.cwds : null;
    return r.reason ? (r.target ?? 'the project folder') : undefined;
  }

  /** The card (every mode but Full) or the refusal (Full, or a ceiling that lifts nothing) for a delete of what holds the project. A ceiling never loosens it. With `card`, Full gets the card too (a Claude agent in Claude's bypass mode). */
  private criticalDeleteDecision(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, command: string, target: string, card = false): Promise<{ allow: boolean; message?: string }> {
    const mode = this.modeNow(job, agent);
    if (!card && (job.origin?.approvalCeiling ? stricterMode(mode, job.origin.approvalCeiling) : mode) === 'full') {
      return Promise.resolve({ allow: false, message: `Not run: this command deletes ${target}, which holds the project. With full access such a command is refused rather than asked about. If it really must go, tell the user and let them delete it.` });
    }
    const o = job.origin;
    let timedOut = false; let waited: number | undefined;
    const shown = command.length > 1000 ? `${command.slice(0, 1000)}\n(${(command.length - 1000).toLocaleString('en-US')} more characters not shown here)` : command;
    return this.approvals.request(job.taskId, agent.id, toolName, input, o ? { roomId: o.roomId, fromAgentId: o.fromAgentId, hop: o.hop } : undefined, {
      onTimeout: (ms) => { timedOut = true; waited = ms; },
      ...this.askExtras(job, agent, toolName, input),
      noRemember: true,
      summary: `This command deletes ${target}, which holds your project.\n${shown}\nYou are asked in every approval mode. Allow it only if you mean to delete it.`,
    }).then((allowed) => {
      if (allowed) return { allow: true };
      const stop = 'Do not retry it, rephrase it or reach the same result another way. Stop, tell the user what the command was meant to do, and wait for their answer.';
      return { allow: false, message: timedOut ? `No one answered the approval request within ${this.waitedText(waited)}, so this command was not run (it deletes ${target}). ${stop}` : `The user has not approved this command (it deletes ${target}). ${stop}` };
    });
  }

  /**
   * Agents may not change Legion's own protected files (gate settings, the gates key, projects, config, state, connectors, providers, armory, away:
   * the same set the file tools use). Default deny: a shell command that names one of them, a path inside one or a folder above one
   * (read from the run's working folder, following `cd` and `git -C`, hidden commands included), or whose path is built when it runs,
   * gets a card in Ask, Auto-edits and Smart with no Remember (no remembered rule may skip it), unless every part of it only reads.
   * Reading stays free, and so do agents' workspaces. Full (Bypass) can change the rest of the data folder, but a write or delete that names
   * the gate settings, the gates key, config, state or the project list still gets the card. Undefined when nothing is due.
   */
  private dataFolderCard(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, command: string, kind: ShellKind, native = false): Promise<{ allow: boolean; message?: string }> | undefined {
    const all = this.protectedDirs();
    if (!all.length) return undefined;
    const mode = this.modeNow(job, agent);
    // Full keeps one narrow card: a write or delete that NAMES the gate settings, the gates key, config, state, the project list or app-settings.json (normal work
    // never writes them). A path built when the command runs is not carded in Full, and the rest of the data folder keeps Full's freedom.
    const full = (job.origin?.approvalCeiling ? stricterMode(mode, job.origin.approvalCeiling) : mode) === 'full';
    const folders = full ? all.filter((t) => FULL_CARD_NAMES.has(basename(t).toLowerCase())) : all;
    if (!folders.length) return undefined;
    let hit: 'none' | 'names' | 'hidden';
    let readFailed = false;
    // Legion's own host shell takes a folder per call; Claude's Bash and PowerShell keep theirs from call to call
    const keeps = !toolName.startsWith('mcp__host__');
    const act = this.active.get(job.taskId);
    try {
      const r = dataFolderRead(command, kind, folders, { cwd: this.gateCwd(agent, toolName, input), cwdUnknown: keeps && act?.shellMoved === true, ...(keeps && act?.shellCwds?.length ? { cwds: act.shellCwds } : {}) });
      hit = r.hit;
      if (keeps && r.moved && act) act.shellMoved = true;
      if (keeps && act) act.shellCwds = r.cwds.length ? r.cwds : undefined;
    } catch { hit = 'hidden'; readFailed = true; if (keeps && act) act.shellMoved = true; }
    if (hit === 'none') return undefined;
    // Full for a Claude agent: Claude's checker does not run, so an unresolved path that NAMES one of the protected files (`rm -rf $DIR/gates`) keeps the card
    // (the old path refused such a command); other unresolved paths in Full are left alone, as before.
    const lower = command.toLowerCase();
    const namedInFull = full && native && hit === 'hidden' && folders.some((f) => lower.includes(basename(f).toLowerCase()));
    if (full && hit !== 'names' && !namedInFull) return undefined;
    // a Claude agent on Claude's own checks: a path built when the command runs ($X) that cannot be resolved is Claude's to judge, where Claude judges (not in Full). A reader that threw is not that: it still asks.
    if (native && !full && hit === 'hidden' && !readFailed) return undefined;
    const o = job.origin;
    let timedOut = false; let waited: number | undefined;
    const shown = command.length > 1000 ? `${command.slice(0, 1000)}\n(${(command.length - 1000).toLocaleString('en-US')} more characters not shown here)` : command;
    const what = hit === 'names' ? "works on Legion's own settings folder" : "has a path that is built when it runs and could point at Legion's own settings folder";
    return this.approvals.request(job.taskId, agent.id, toolName, input, o ? { roomId: o.roomId, fromAgentId: o.fromAgentId, hop: o.hop } : undefined, {
      onTimeout: (ms) => { timedOut = true; waited = ms; },
      ...this.askExtras(job, agent, toolName, input),
      noRemember: true,
      summary: `This command ${what}.\n${shown}\nThat folder holds your gate settings, keys and projects. An agent may not change it without you, so you are asked in every approval mode. Allow it only if you asked for this.`,
    }).then((allowed) => {
      if (allowed) return { allow: true };
      const stop = 'Do not retry it, rephrase it or reach the same result another way. Stop, tell the user what the command was meant to do, and wait for their answer.';
      return { allow: false, message: timedOut ? `No one answered the approval request within ${this.waitedText(waited)}, so this command was not run (it works on Legion's own settings folder). ${stop}` : `The user has not approved this command (it works on Legion's own settings folder). ${stop}` };
    });
  }

  /**
   * A tool call went through with no card because a gate is off (the preset or an owner override), and the agent's own setting, with no preset at all,
   * would have asked: one "would have asked" line in the activity log. Called only where a call is decided, never per stream event; a call that
   * needed no card anyway (a plain Read, an agent that is Full on its own, Ask with the gate on) writes nothing.
   */
  private noteWouldAsk(job: Job, agent: AgentProfile, gateId: string, toolName: string, input: Record<string, unknown>): void {
    try {
      if (!this.activity || !this.modes?.baseline || this.gates?.gate(gateId, startProjectOf(job)) !== false) return;
      const live = this.store.getAgent(agent.id);
      const base = this.modes.baseline({ agentMode: live?.approval ?? agent.approval, source: live?.approvalSource ?? agent.approvalSource ?? 'own', ...(job.origin?.approvalCeiling ? { ceiling: job.origin.approvalCeiling } : {}) });
      if (!needsApproval(base, toolName, { capped: job.origin?.approvalCeiling === 'ask' })) return;
      const projectId = startProjectOf(job);
      this.activity.wouldHaveAsked({ gateId, label: GATES.find((g) => g.id === gateId)?.label ?? gateId, action: `${toolName} ${summarizeToolInput(toolName, input)}`, taskId: job.taskId, ...(projectId ? { projectId } : {}), agentId: agent.id });
    } catch { /* advisory: a log line never changes a decision */ }
  }

  /** The owner switched "Your ask rules" off (an explicit override only: a preset alone never does), and the run carries no outside ceiling. */
  private asksSkipped(job: Job): boolean {
    return !job.origin?.approvalCeiling && this.gates?.switchedOff('gate-rules-ask', startProjectOf(job)) === true;
  }

  /** The mode a tool call of this run is judged by right now: re-read on every call (a promotion or a preset change applies on the next call). */
  private modeNow(job: Job, agent: AgentProfile): RunMode {
    const live = this.store.getAgent(agent.id);
    const own = live?.approval ?? agent.approval;
    const ceiling = job.origin?.approvalCeiling;
    if (!this.modes) return ceiling ? stricterMode(own, ceiling) : own;
    // the cap comes from the project the run STARTED in (job.projectAtStart, set when the run began), or for an outside helper the project it helps
    // (job.outsideOf, the same value decideGate gets): a project archived or left mid-run keeps its cap
    const startProjectId = startProjectOf(job);
    return this.modes.mode({ agentMode: own, source: live?.approvalSource ?? agent.approvalSource ?? 'own', ...(startProjectId ? { startProjectId } : {}), ...(ceiling ? { ceiling } : {}) });
  }

  /**
   * The mode an agent's run is judged by right now, for modules that only know the agent and the task (the browser, Blender and board
   * guards, the comms hub). The project cap comes from the live run's start project (or the project an outside helper helps), else from the
   * task's own project; with no task there is no start project, so no cap. Undefined when the agent is gone.
   */
  runModeOf(agentId: string, taskId?: string): RunMode | undefined {
    const agent = this.store.getAgent(agentId);
    if (!agent) return undefined;
    // Legion cannot see what an agent host agent does, so the modes it hands on (a room it wakes, an agent it asks) never exceed Ask
    if (runtimeOf(agent.model) === 'acp') return 'ask';
    // the run's own start project (running, else queued); only a task the engine does not know falls back to its live project
    const src = taskId ? (this.active.get(taskId) ?? this.queue.find((j) => j.taskId === taskId)) : undefined;
    const startProjectId = src ? startProjectOf(src) : taskId ? this.projectOf(taskId, agentId)?.id : undefined;
    if (!this.modes) return agent.approval;
    return this.modes.mode({ agentMode: agent.approval, source: agent.approvalSource ?? 'own', ...(startProjectId ? { startProjectId } : {}) });
  }

  /**
   * One gate's value for a run, read with the project the run STARTED in (never the stored agent mode), for modules that only know the task:
   * the GitHub write card, the board delete card, the module cards and the proposals Inbox. A task the engine does not know (or no task) reads
   * as ON: a lookup that cannot find the run's start project must never fall back to a looser app setting. Without a gates core every gate is on.
   */
  gateFor(taskId: string | undefined, id: string): GateValue {
    if (!this.gates) return true;
    const src = taskId ? (this.active.get(taskId) ?? this.queue.find((j) => j.taskId === taskId)) : undefined;
    if (!src) return true;
    return this.gates.gate(id, startProjectOf(src));
  }

  /**
   * Whether a module that raises its own card may skip it, by the same rule as tool cards (see GatesCore.switchedOff): only an explicit owner override
   * removes a card below what the agent's own setting asks. A preset alone (Bypass) silences the agents that follow it, that is, a run whose
   * mode resolves to full; an agent the owner set to Ask keeps its card. The caller handles ceilings (a ceiling always keeps the card).
   */
  cardOffFor(taskId: string | undefined, id: string, agentId: string): boolean {
    if (!this.gates || this.gateFor(taskId, id) !== false) return false;
    const src = taskId ? (this.active.get(taskId) ?? this.queue.find((j) => j.taskId === taskId)) : undefined;
    if (!src) return false;
    if (this.gates.switchedOff(id, startProjectOf(src))) return true;
    return this.runModeOf(agentId, taskId) === 'full';
  }

  /**
   * A module let something through with no card because a gate is off. One "would have asked" line when the owner's own setting, with no preset
   * at all, would have asked (`always`: it asks in every setting, like a GitHub write). Advisory: it never changes a decision.
   */
  noteGateOff(a: { gateId: string; taskId: string; agentId: string; action: string; always?: boolean }): void {
    try {
      if (!this.activity || this.gateFor(a.taskId, a.gateId) !== false) return;
      const src = this.active.get(a.taskId) ?? this.queue.find((j) => j.taskId === a.taskId);
      if (!a.always) {
        const agent = this.store.getAgent(a.agentId);
        if (!agent || !this.modes?.baseline) return;
        const ceiling = this.store.getTask(a.taskId)?.origin?.approvalCeiling;
        const base = this.modes.baseline({ agentMode: agent.approval, source: agent.approvalSource ?? 'own', ...(ceiling ? { ceiling } : {}) });
        if (!decideGuard(base).needsCard) return;
      }
      const projectId = src ? startProjectOf(src) : undefined;
      this.activity.wouldHaveAsked({ gateId: a.gateId, label: GATES.find((g) => g.id === a.gateId)?.label ?? a.gateId, action: a.action.slice(0, 300), taskId: a.taskId, ...(projectId ? { projectId } : {}), agentId: a.agentId });
    } catch { /* advisory */ }
  }

  /**
   * Claude's prompt for a Claude tool, as the owner's "Ask before tools run" switch sees it: switched off, it is answered without a card (logged as a call that would have
   * asked), exactly as that switch does today for other tools. The denial brake's prompt ("N consecutive actions were blocked") is never skipped: it is Claude's checker
   * stopping a run that keeps trying, and a card is the only place the owner learns of it. An outside ceiling keeps its cards: no setting lifts it.
   */
  private claudeAsk(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, o?: { decisionReason?: string; title?: string; toolUseID?: string }): Promise<Decision> {
    const brake = /consecutive actions were blocked/i.test(`${o?.decisionReason ?? ''} ${o?.title ?? ''}`);
    if (!brake && !job.origin?.approvalCeiling && this.gates?.switchedOff('tool-cards', startProjectOf(job))) {
      this.noteWouldAsk(job, agent, 'tool-cards', toolName, input);
      return Promise.resolve({ allow: true });
    }
    return this.claudePromptCard(job, agent, toolName, input, o);
  }

  /**
   * Claude asked (canUseTool) about a call it could not decide: the same question reaches the owner as a card, with Claude's reason. This is the whole
   * decision for a Claude agent on Claude's own checks: Legion's Smart judge, allow rules and preset do not answer it. An unanswered card denies, and the
   * agent is told plainly not to find another way.
   */
  private claudePromptCard(job: Job, agent: AgentProfile, toolName: string, input: Record<string, unknown>, o?: { decisionReason?: string; title?: string; toolUseID?: string }): Promise<Decision> {
    const reason = (typeof o?.decisionReason === 'string' && o.decisionReason.trim() ? o.decisionReason : typeof o?.title === 'string' ? o.title : '').trim().slice(0, 300);
    const origin = job.origin;
    let timedOut = false; let waited: number | undefined;
    const stop = 'Do not retry it, rephrase it or reach the same result another way. Stop, tell the user what you needed it for, and wait for their answer.';
    return this.approvals.request(job.taskId, agent.id, toolName, input, origin ? { roomId: origin.roomId, fromAgentId: origin.fromAgentId, hop: origin.hop } : undefined, {
      onTimeout: (ms) => { timedOut = true; waited = ms; },
      ...this.askExtras(job, agent, toolName, input),
      // a remembered allow rule would not answer Claude's prompts for a Claude agent (it would skip Claude's checker), so the card does not offer one
      noRemember: true,
      summary: `${summarizeToolInput(toolName, input)}${reason ? `\nClaude asked: ${reason}` : ''}`,
    }).then((allowed): Decision => {
      if (allowed) return { allow: true };
      const live = this.active.get(job.taskId);
      // the owner's own No: Claude's "permission denied" message for this call is not logged a second time
      if (live && o?.toolUseID) this.rememberOwnerDenied(live, o.toolUseID);
      if (live && !live.cancelled) this.mascot('thinking', `${toolName} ${timedOut ? 'not answered' : 'denied'}`);
      if (timedOut) {
        const wait = this.waitedText(waited);
        if (origin?.approvalCeiling === 'ask') return { allow: false, message: `No one approved this action: it needs your OK in the Legion app window and nothing was answered within ${wait}. Open the Legion app, then ask for it again. ${stop}` };
        return { allow: false, message: `No one answered the approval request within ${wait}, so this action was not run. ${stop}` };
      }
      return { allow: false, message: `The user denied this action. ${stop}` };
    });
  }

  /**
   * The approval decision for one tool call, shared by the Claude path (canUseTool) and the provider path: effective mode (never looser
   * than the run's ceiling), then needsApproval, then a card the user answers (10 minutes, then denied).
   */
  private toolDecider(job: Job, agent: AgentProfile, opts: { egress?: boolean; /** false: the floor's card is raised by a hook for this path; only its refusals apply here. */ floorCard?: boolean } = {}): (toolName: string, input: Record<string, unknown>) => Promise<{ allow: boolean; message?: string }> {
    const decide = this.callDecider(job, agent, opts);
    return (toolName, input) => decide(toolName, input) as Promise<Decision>;
  }

  /**
   * The body of toolDecider. With `ownOnly` it decides only a call one of Legion's own cards is due for (the outside-run ceiling, a gate ask rule,
   * the web-egress card after connector data, Smart's changed-build-file card) and answers undefined for every other call, without a card or a
   * log line: the ask-mode PreToolUse hook uses it, so those cards fire even where an allow rule means canUseTool is never asked.
   */
  private callDecider(job: Job, agent: AgentProfile, opts: { egress?: boolean; floorCard?: boolean; /** false: the hook already ran the guards for this call. */ guards?: boolean; ownOnly?: boolean; /** A Claude agent on Claude's own checks: Legion's Smart judge, build card and plain preset card are not used. */ native?: boolean } = {}): (toolName: string, input: Record<string, unknown>) => Promise<Decision | undefined> {
    const effective = (): RunMode => this.modeNow(job, agent);
    return async (toolName, input) => {
      const mode = effective();
      const capped = job.origin?.approvalCeiling === 'ask';
      // Gate rules (Settings -> Gates) sit ahead of the approval baseline: deny wins outright (and survives full), an
      // explicit allow skips the card, an ask forces one (inert in full), and no rule falls through to the baseline.
      // With "Your ask rules" off, an ask rule is skipped by judging as full (deny still wins there).
      const gate = decideGate({ toolName, input, agentId: agent.id, cwd: this.gateCwd(agent, toolName, input), tmpDir: GATE_TMP_DIR, projectId: this.projectOf(job.taskId, agent.id)?.id, startProjectId: startProjectOf(job), ctx: { roomHop: (job.origin?.hop ?? 0) > 0, tainted: this.active.get(job.taskId)?.tainted === true || job.origin?.tainted === true, connectorData: this.store.getTask(job.taskId)?.usedConnectors === true } }, gatesFor(this.config).rules, this.asksSkipped(job) ? 'full' : mode, capped);
      if (gate.verdict === 'deny') return { allow: false, message: 'Blocked by a gate rule (Settings -> Gates).' };
      // web egress after connector data: a card in every mode (maintainer decision 2026-10-07)
      // (no await when no card is due: the card of a normal tool must still be raised synchronously)
      // It comes after the deny rules, so a yes on it never passes a call they refuse (the hook path has the same order).
      const egress = opts.egress === false ? undefined : this.webEgressCard(job, agent, toolName, input);
      if (egress) return egress;
      // the shell floor sits ahead of allow rules and the baseline: an allow rule cannot pass a command nobody could read
      const floor = this.shellFloor(job, agent, toolName, input, { card: opts.floorCard !== false, ...(opts.native ? { native: true } : {}) });
      if (floor) return floor;
      // the guards (the web check first) raise their own card ahead of every allow, the owner's tool-cards switch and the baseline
      const guard = opts.guards === false ? undefined : this.askGuards(job, agent, toolName, input, mode, opts.native === true);
      if (guard) return guard;
      // Claude's own checks decide the plain card of the preset, Smart's judge, the build card and the allow rules; only a gate ask rule and an outside ceiling are Legion's here
      if (opts.native && gate.verdict !== 'ask' && !capped) return undefined;
      // a call that goes through with no card: with ownOnly it is left to the normal permission flow (canUseTool notes it there)
      const pass = (): Decision | undefined => { if (opts.ownOnly) return undefined; this.noteWouldAsk(job, agent, 'tool-cards', toolName, input); return { allow: true }; };
      // "Ask before tools run" switched off by the owner: no tool card from here on (deny rules and the floor above already applied). A run that
      // carries a ceiling from an outside app or another bot keeps its cards: no project setting lifts a ceiling (rail-ceiling).
      if (gate.verdict !== 'ask' && !job.origin?.approvalCeiling && this.gates?.switchedOff('tool-cards', startProjectOf(job))) return pass();
      if (gate.verdict === 'allow') return opts.ownOnly ? undefined : { allow: true };
      // a GitHub write raises its own, fuller card (gateway.ts), so a gate `ask` must not stack a second one on top; a gate `deny` was handled above
      if (gate.verdict === 'ask' && CARDED_CONNECTOR_WRITES.has(toolName)) return opts.ownOnly ? undefined : { allow: true };
      // Smart and smart-edits judge an edit or a command by what saying yes would do (the same classifier the card's consequence line uses)
      const consequence = mode === 'smart' || mode === 'smart-edits' ? this.askExtras(job, agent, toolName, input).consequence : undefined;
      // Smart: a project seen for the first time gets its build-file baseline now, before any command of this run can change a file
      if (mode === 'smart' && !opts.native) { const pid = startProjectOf(job), dir = this.startFolderOf(job); if (pid && dir) this.gates?.buildEdited?.ensureBaseline(pid, dir); }
      // a local build or test run is judged again once an agent changed a build or script file in the project (the fingerprint is taken only here)
      const build = mode === 'smart' && consequence?.tags.includes('runs-code') ? this.buildCheck(job) : undefined;
      const askOpts = { capped, ...(consequence ? { consequence } : {}) };
      const baseAsk = needsApproval(mode, toolName, askOpts);
      const asks = build?.flagged ? needsApproval(mode, toolName, { ...askOpts, buildEdited: true }) : baseAsk;
      if (gate.verdict !== 'ask' && !asks) return pass();
      // the flag is what made this card (Smart would have run it): say why, and let only the owner's allow clear the flag. No Remember: a standing rule would skip the flag for good.
      const flagCard = gate.verdict !== 'ask' && asks && !baseAsk;
      // only the plain card of the preset is left: an allow rule may skip that one, so the hook leaves it to canUseTool
      if (opts.ownOnly && gate.verdict !== 'ask' && !capped && !flagCard) return undefined;
      const o = job.origin;
      let timedOut = false; let waited: number | undefined;
      const allowed = await this.approvals.request(
        job.taskId, agent.id, toolName, input,
        o ? { roomId: o.roomId, fromAgentId: o.fromAgentId, hop: o.hop } : undefined,
        { onTimeout: (ms) => { timedOut = true; waited = ms; }, ...this.askExtras(job, agent, toolName, input), ...(flagCard ? { noRemember: true, summary: `${AWAY_COPY.card.buildEdited}\n${summarizeToolInput(toolName, input)}` } : {}) },
      );
      if (allowed) { if (flagCard) this.clearBuildEdited(job, build?.snap); return { allow: true }; }
      // The tool_use already set the mood to 'hacking'; after a deny nothing else would move it until the run ends, so the Relic
      // would read "Executing" for a call that never ran. Skip it once the run is cancelled or over (cancel denies open cards too).
      const live = this.active.get(job.taskId);
      if (live && !live.cancelled) this.mascot('thinking', `${toolName} ${timedOut ? 'not answered' : 'denied'}`);
      if (timedOut) {
        const wait = this.waitedText(waited);
        // An MCP client started this run (Claude Code, Cowork) or woke it through a chain, so the ceiling is `ask`. Its card can only be answered in the Legion app window, so say so
        // when nobody answered (the app is closed, or this core was started headless by the MCP bridge).
        if (o?.approvalCeiling === 'ask') {
          return { allow: false, message: `No one approved this action: it needs your OK in the Legion app window and nothing was answered within ${wait}. Open the Legion app, then ask for it again.` };
        }
        // A timeout is not a "no": the model must not read it as the user refusing the work.
        return { allow: false, message: `No one answered the approval request within ${wait}, so this action was not run. Ask again later or continue without it.` };
      }
      return { allow: false, message: 'The user denied this action.' };
    };
  }

  /**
   * The spend cap for one run: a typed brief's budget when one asked for it, clamped so it is never above the owner's
   * claude.maxBudgetUsd (Fascia 3b). Absent both: undefined (no cap), exactly as before.
   */
  private perRunBudget(job: Job): number | undefined {
    return clampBudget(job.maxBudgetUsd, budgetCap(this.config.claude.maxBudgetUsd));
  }

  private buildOptions(job: Job, agent: AgentProfile, model: ConcreteModel, act: Active, prompt: string, resume?: string): Options {
    const cwd = agent.cwd || join(this.config.workspaceDir, agent.id);
    mkdirSync(cwd, { recursive: true });
    // the protected files' identities, read once per run (only when a target has more than one link)
    const linkIds: { ids?: Set<string> } = {};
    // the project (if any) adds text AFTER everything else and one extra folder: its own, and only its own
    const project = this.projectOf(job.taskId, agent.id);
    // in the project when it was queued, not any more when it starts (archived, deleted, member removed meanwhile)
    if (!project && job.projectAtStart && this.projects) this.noteProjectLost(job.taskId, job.projectAtStart, agent);
    let projectFolder: string | undefined;
    if (project) { try { mkdirSync(project.folder, { recursive: true }); projectFolder = project.folder; } catch { /* no folder this run: the instructions still apply */ } }
    this.noteSharedFolder(job.taskId, agent, project);
    const servers = this.buildMcpServers(agent, job, act);
    const skillSet = this.moduleSkills(agent);
    const allowSkillShell = this.skillShellAllowed();
    const maxBudgetUsd = this.perRunBudget(job);
    const trust = this.folderTrustFor(job, agent, act, cwd, projectFolder ? [projectFolder] : []);
    const options: Options = {
      model,
      cwd,
      systemPrompt: {
        type: 'preset', preset: 'claude_code',
        append: LEGION_PREAMBLE.replace('{name}', agent.name)
          + '\n\n' + renderTeamwork(servers)
          + this.modulePreamble(agent, { prompt, taskId: job.taskId, ...(job.origin ? { origin: job.origin } : {}), tainted: act.tainted || job.origin?.tainted === true, ...(project ? { projectId: project.id } : {}) })
          + (() => { const t = this.heldBackNote(job, agent, act, { child: true, host: agent.host?.enabled === true }); return t ? '\n\n' + t : ''; })()
          + '\n\n' + renderCapabilities(agent, { servers, ...(job.origin?.approvalCeiling ? { ceiling: job.origin.approvalCeiling } : {}), vmEnabledForAgent: !!agent.vm?.enabled, runMode: this.modeNow(job, agent), claudeOwnChecks: this.claudeOwnChecks() })
          + (agent.systemPrompt ? '\n\n' + agent.systemPrompt : '')
          + (project ? '\n\n' + projectSection({ name: project.name, instructions: project.instructions, folder: project.folder }) : '')
          // the folder's own instructions, read as text, when its settings were held back (folder trust)
          + (trust.text ? '\n\n' + trust.text : '')
          // the lead's role comes last, after the persona and the project, so no edit or wording above can drop it
          + (leadDoctrineFor(agent.id) ? '\n\n' + leadDoctrineFor(agent.id) : ''),
      },
      ...(projectFolder ? { additionalDirectories: [projectFolder] } : {}),
      settingSources: trust.sources,
      // Always an explicit list: omitted means "everything Claude Code can find" (338 skills on the owner's machine). [] = none.
      skills: skillSet.skills,
      ...(skillSet.plugins.length ? { plugins: skillSet.plugins.map((path) => ({ type: 'local' as const, path })) } : {}),
      mcpServers: servers,
      // A folder held back for its .mcp.json (folder trust, inheritMcp on) gets this too: dropping the project source already stops the SDK connecting it
      // (code.claude.com/docs/en/permissions, "What runs before you trust a folder", the .mcp.json row), and this makes sure.
      // Off (default): only the servers above, asks the CLI to ignore user/project/local MCP config and plugins. claude.ai connectors are asked off in buildChildEnv and in `settings`.
      ...(this.config.claude.inheritMcp === true && !trust.mcpHeld ? {} : { strictMcpConfig: true }),
      // Claude Code's own task list: 5.x models have it only when asked for. Naming the tools in allowedTools turns them on
      // (Claude Code CLI behaviour, verified live 2026-10-12; sdk.d.ts documents allowedTools only as auto-approval) and
      // auto-approves them, so a Gates rule for them does not apply — harmless: they are notes (READ_ONLY), never carded.
      // Off, the old TodoWrite goes too.
      ...(nativeTaskListOn(agent) ? { allowedTools: [...NATIVE_TASK_TOOLS] } : {}),
      // Claude Code's own AskUserQuestion is off: in an ask-mode run it surfaced as an approval card with raw JSON. Legion's ask_user_question (mcp__legion__) raises the question card.
      disallowedTools: ['SendMessage', 'ListAgents', 'AskUserQuestion', ...(nativeTaskListOn(agent) ? [] : [...NATIVE_TASK_TOOLS, 'TodoWrite']), ...this.webToolsReplaced(), ...this.moduleDisallowed(agent)],
      maxTurns: this.config.claude.maxTurns,
      // optional spend cap per run; a typed brief may ask for a lower one, clamped here, never above the owner's. On a resumed session it counts only the new spend.
      ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
      includePartialMessages: true,
      abortController: act.ac,
      env: buildChildEnv(this.config, this.childScrubFor(job)),
      // SDK Settings.disableSkillShellExecution (sdk.d.ts:7156): inline shell in skills and slash commands runs before the model sees the text and never
      // reaches canUseTool, so it is replaced by a placeholder unless the owner allowed it in the Armory. Merged into the same flag layer as the connector switch.
      settings: planOnlySettings(this.config, { ...connectorSettings(this.config).settings, disableSkillShellExecution: !allowSkillShell }),
      // Runs before every tool executes (also in bypass mode), so taint is set before the tool can act on outside content.
      hooks: {
        PreToolUse: [
          {
            hooks: [async (input) => {
              if (input.hook_event_name === 'PreToolUse') this.noteToolUse(job, act, input.tool_name, input.tool_use_id, input.tool_input);
              return { continue: true };
            }],
          },
          // Every Skill load, in every approval mode and for subagents too (they ignore the `skills` list): denied unless the skill is on for this agent.
          { matcher: 'Skill', hooks: [async (input) => {
            if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Skill') return { continue: true };
            const why = this.skillDenial(agent, input.tool_input);
            return why ? preToolDeny(why) : { continue: true };
          }] },
          // The Armory's own files are changed only through Legion's routes. Limit, stated plainly: this stops the file tools, not Bash.
          { hooks: [async (input) => {
            if (input.hook_event_name !== 'PreToolUse') return { continue: true };
            const field = WRITE_FILE_TOOLS[input.tool_name];
            const target = field && input.tool_input && typeof input.tool_input === 'object' ? (input.tool_input as Record<string, unknown>)[field] : undefined;
            if (typeof target !== 'string' || !target) return { continue: true };
            // canonical path: admin-share (also through this computer's own addresses), `\\?\`, short-name, junction and trailing-dot
            // spellings reach the same file; a hardlink to a protected file is that file
            const set = this.protectedDirs();
            return isProtected(target, set, cwd) || isHardlinkToProtected(target, set, cwd, linkIds) ? preToolDeny("Legion's own settings files (the Armory, gates, keys, projects) can only be changed by the owner in Legion, not by an agent.") : { continue: true };
          }] },
        ],
      },
    };
    if (resume) options.resume = resume;
    if (this.config.claude.executablePath) options.pathToClaudeCodeExecutable = this.config.claude.executablePath;
    // A task woken by another bot can never be more permissive than the strictest sender on the chain
    // (confused-deputy guard): it never runs in bypass mode and its cards name who asked.
    const effective = (): RunMode => this.modeNow(job, agent);
    // a hook that awaits a card gets the card's own wait and a minute more: a hook timeout would stop the run, not deny the call
    const cardHookSeconds = this.approvals.timeoutSeconds + 60;
    if (this.modeNow(job, agent) === 'full') {
      options.permissionMode = 'bypassPermissions';
      options.allowDangerouslySkipPermissions = true;
      // bypass mode has no canUseTool for ordinary calls: the web-egress card is raised from a PreToolUse hook instead (never both, so one card per call)
      options.hooks?.PreToolUse?.push({ matcher: 'WebFetch|WebSearch|mcp__legion__web_read|mcp__legion__web_search', timeout: cardHookSeconds, hooks: [async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return { continue: true };
        const d = await this.webEgressCard(job, agent, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
        return d && !d.allow ? preToolDeny(d.message ?? 'The user denied this web request.') : { continue: true };
      }] });
      // The run started in full, but the owner may demote the agent while it works: bypass mode cannot be left, so this hook
      // re-reads the mode on every call and, once it is no longer full, decides the call as that mode would, card included.
      // (The web-egress card has its own hook above, so it is left out here: one card per call.)
      const demoted = this.toolDecider(job, agent, { egress: false });
      // A Claude agent on Claude's own checks that is demoted from Full: bypass mode has no checker and no canUseTool, so nothing of Claude's is running. Legion's Smart
      // judge must not stand in either, so the call is decided as the CURRENT preset would: a Block rule, then Legion's floor and guards in full (the new-site, protected-file
      // and secret-file cards: the checks Claude would have made), Legion's own cards, and for the rest of Claude's tools a card where Ask (or Accept edits) would ask.
      // The card is raised here, in the hook, because a hook `ask` is not known to reach the owner under bypass mode (the probe covered auto only).
      const nativeFull = this.claudeOwnChecks();
      const ownNativeFull = nativeFull ? this.callDecider(job, agent, { egress: false, floorCard: false, guards: false, ownOnly: true, native: true }) : undefined;
      // Claude Code's bypass mode still asks about a few things it never approves by itself (deleting the working folder or a folder above it, the root, home,
      // an explicit ask rule of the owner's own Claude settings); checked against SDK 0.3.296 (probe-bypass): canUseTool IS called for them, with reason type
      // safetyCheck, and with none set Claude denies the call itself. So a Claude agent in Full gets one here, for those prompts only: each becomes a card, even with
      // "Ask before tools run" off (Claude refuses to auto-approve them), and nothing is allowed without the owner's yes.
      if (nativeFull) {
        options.canUseTool = async (toolName, input, o) => {
          const d = this.takeHookDecided(job, o?.toolUseID) ?? await this.claudePromptCard(job, agent, toolName, input, o);
          return d.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: d.message ?? 'The user denied this action.' };
        };
      }
      // deny rules survive Full (the one class meant to): a Block rule still stops the tool here, where canUseTool does not exist.
      options.hooks?.PreToolUse?.push({ matcher: '.*', timeout: cardHookSeconds, hooks: [async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return { continue: true };
        if (effective() !== 'full' && ownNativeFull) {
          const tin = (input.tool_input ?? {}) as Record<string, unknown>;
          const mode = effective();
          const g = decideGate({ toolName: input.tool_name, input: tin, agentId: agent.id, cwd: this.gateCwd(agent, input.tool_name, tin), tmpDir: GATE_TMP_DIR, projectId: this.projectOf(job.taskId, agent.id)?.id, startProjectId: startProjectOf(job), ctx: { roomHop: (job.origin?.hop ?? 0) > 0, tainted: this.active.get(job.taskId)?.tainted === true || job.origin?.tainted === true, connectorData: this.store.getTask(job.taskId)?.usedConnectors === true } }, gatesFor(this.config).rules, mode, job.origin?.approvalCeiling === 'ask');
          if (g.verdict === 'deny') return preToolDeny('Blocked by a gate rule (Settings -> Gates).');
          // Legion's floor in full (its cards included): a call it asks about is decided by that one card
          const floor = SHELL_TOOLS.has(input.tool_name) ? this.shellFloor(job, agent, input.tool_name, tin) : undefined;
          if (floor) { const d = await floor; return d.allow ? { continue: true } : preToolDeny(d.message ?? 'The user denied this action.'); }
          // the web-egress card has its own hook above: one card per call
          const res = await this.hookCards(job, agent, input.tool_name, tin, mode, input.tool_use_id, ownNativeFull, false, false);
          if (!('continue' in res)) return res;
          const asks = mode === 'auto-edits' ? 'auto-edits' : 'ask';
          if (APPROVAL_READ_ONLY.has(input.tool_name) || isLegionTool(input.tool_name) || !needsApproval(asks, input.tool_name, { capped: job.origin?.approvalCeiling === 'ask' })) return res;
          const d = await this.claudeAsk(job, agent, input.tool_name, tin, { decisionReason: 'The approval setting for this run became stricter after it started.' });
          return d.allow ? { continue: true } : preToolDeny(d.message ?? 'The user denied this action.');
        }
        if (effective() !== 'full') {
          const d = await demoted(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
          return d.allow ? { continue: true } : preToolDeny(d.message ?? 'The user denied this action.');
        }
        const g = decideGate({ toolName: input.tool_name, input: (input.tool_input ?? {}) as Record<string, unknown>, agentId: agent.id, cwd: this.gateCwd(agent, input.tool_name, input.tool_input as Record<string, unknown> | undefined), tmpDir: GATE_TMP_DIR, projectId: this.projectOf(job.taskId, agent.id)?.id, startProjectId: startProjectOf(job), ctx: { roomHop: (job.origin?.hop ?? 0) > 0, tainted: this.active.get(job.taskId)?.tainted === true || job.origin?.tainted === true, connectorData: this.store.getTask(job.taskId)?.usedConnectors === true } }, gatesFor(this.config).rules, 'full', false);
        if (g.verdict === 'deny') return preToolDeny('Blocked by a gate rule (Settings -> Gates).');
        // Full forgives the approval card, not the machine: the shell floor holds here too (Claude's own Bash included)
        // (a Claude agent on Claude's own checks: only the catastrophic refusals and the card for Legion's own settings files; nothing is refused as unjudgeable)
        const floor = this.shellFloor(job, agent, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, nativeFull ? { native: true, bypass: true } : {});
        if (floor) {
          const d = await floor;
          if (!d.allow) return preToolDeny(d.message ?? 'The user denied this action.');
          // a Yes on this card also answers Claude's own prompt for the same call (canUseTool reads it by the call's id): one card per call
          if (nativeFull) this.noteHookDecided(job, input.tool_use_id, d);
        }
        // the run goes through with no card: when the owner's own setting would have asked, the activity log says so
        this.noteWouldAsk(job, agent, 'tool-cards', input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
        return { continue: true };
      }] });
    } else if (this.claudeOwnChecks()) {
      // Claude's own permission system decides about Claude's tools (0.3.6). The preset picks Claude's mode, set explicitly every time; Legion's hooks
      // add only what Claude Code lacks (Block rules, the hard floor, Legion's own files and tools, a gate Ask rule, an outside ceiling) and NEVER answer
      // allow unless the owner just approved a Legion card for the call: a hook allow makes Claude skip its own checker.
      const startMode = this.modeNow(job, agent);
      const want = claudePermissionMode(startMode);
      options.permissionMode = want;
      act.nativeChecks = true; act.sdkMode = want;
      const own = this.callDecider(job, agent, { floorCard: false, guards: false, ownOnly: true, native: true });
      options.hooks?.PreToolUse?.push({ matcher: '.*', timeout: cardHookSeconds, hooks: [async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return { continue: true };
        const tin = (input.tool_input ?? {}) as Record<string, unknown>;
        const mode = effective();
        const g = decideGate({ toolName: input.tool_name, input: tin, agentId: agent.id, cwd: this.gateCwd(agent, input.tool_name, tin), tmpDir: GATE_TMP_DIR, projectId: this.projectOf(job.taskId, agent.id)?.id, startProjectId: startProjectOf(job), ctx: { roomHop: (job.origin?.hop ?? 0) > 0, tainted: this.active.get(job.taskId)?.tainted === true || job.origin?.tainted === true, connectorData: this.store.getTask(job.taskId)?.usedConnectors === true } }, gatesFor(this.config).rules, mode, job.origin?.approvalCeiling === 'ask');
        if (g.verdict === 'deny') return preToolDeny('Blocked by a gate rule (Settings -> Gates).');
        // the hard floor: a refusal, or the card for Legion's own data folder; an approved card is final for that call
        const floor = SHELL_TOOLS.has(input.tool_name) ? this.shellFloor(job, agent, input.tool_name, tin, { native: true }) : undefined;
        if (floor) {
          const d = await floor;
          this.noteHookDecided(job, input.tool_use_id, d);
          return d.allow ? preToolAllow('The owner approved this command on its card.') : preToolDeny(d.message ?? 'The user denied this action.');
        }
        const res = await this.hookCards(job, agent, input.tool_name, tin, mode, input.tool_use_id, own, true);
        // Claude's mode is fixed when the run starts: a preset changed to a stricter one meanwhile asks here, for what Claude would not have asked about
        if ('continue' in res && startIsStricter(act.sdkMode ?? want, mode) && !APPROVAL_READ_ONLY.has(input.tool_name) && !isLegionTool(input.tool_name)) {
          return preToolAsk('The approval setting for this run became stricter after it started, so this action needs your OK.');
        }
        return res;
      }] });
      // canUseTool is asked only for what Claude itself would not decide: it shows Claude's prompt as a card and never allows by itself
      options.canUseTool = async (toolName, input, o) => {
        // Legion's own tools (and the browser's) raise their own cards inside their handlers: Claude asking about them is not a second question for the owner
        // (an outside ceiling still cards the few that need it, as before)
        const legionOwn = !APPROVAL_READ_ONLY.has(toolName) && !needsApproval('ask', toolName, { capped: job.origin?.approvalCeiling === 'ask' });
        const d = this.takeHookDecided(job, o?.toolUseID) ?? (legionOwn ? { allow: true } : await this.claudeAsk(job, agent, toolName, input, o));
        if (!d.allow && o?.toolUseID) { const live = this.active.get(job.taskId); if (live) this.rememberOwnerDenied(live, o.toolUseID); }
        return d.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: d.message ?? 'The user denied this action.' };
      };
    } else {
      options.permissionMode = 'default';
      // Legion's own cards on the hook path (A-H1): the ceiling, a gate ask rule, the web-egress card and Smart's build card. The guards run just before.
      // the owner's own Claude Code allow rules may skip the plain card (owner ruling 2026-10-18); Legion's own cards may not
      const own = this.callDecider(job, agent, { floorCard: false, guards: false, ownOnly: true });
      // The shell floor as a hook too: Claude Code's own allow rules (inherited settings, `Bash(rm:*)`) decide a call before
      // canUseTool is asked, which would step around the floor. A Block gate still wins first; an approved floor card is
      // final for that call (no second, ordinary card). Hooks run in parallel, so this hook decides the whole of a shell call
      // (floor, then guards, then Legion's own cards) and the '.*' hook below leaves shell calls alone: one card per call.
      options.hooks?.PreToolUse?.push({ matcher: 'Bash|PowerShell|Monitor|mcp__host__shell', timeout: cardHookSeconds, hooks: [async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return { continue: true };
        const tin = (input.tool_input ?? {}) as Record<string, unknown>;
        const mode = effective();
        const g = decideGate({ toolName: input.tool_name, input: tin, agentId: agent.id, cwd: this.gateCwd(agent, input.tool_name, tin), tmpDir: GATE_TMP_DIR, projectId: this.projectOf(job.taskId, agent.id)?.id, startProjectId: startProjectOf(job), ctx: { roomHop: (job.origin?.hop ?? 0) > 0, tainted: this.active.get(job.taskId)?.tainted === true || job.origin?.tainted === true, connectorData: this.store.getTask(job.taskId)?.usedConnectors === true } }, gatesFor(this.config).rules, mode, job.origin?.approvalCeiling === 'ask');
        if (g.verdict === 'deny') return preToolDeny('Blocked by a gate rule (Settings -> Gates).');
        const floor = this.shellFloor(job, agent, input.tool_name, tin);
        if (!floor) return this.hookCards(job, agent, input.tool_name, tin, mode, input.tool_use_id, own);
        const d = await floor;
        this.noteHookDecided(job, input.tool_use_id, d);
        return d.allow ? preToolAllow('The owner approved this command on its card.') : preToolDeny(d.message ?? 'The user denied this action.');
      }] });
      // The guards and Legion's own cards as a hook too, for the same reason: Claude Code's own allow rules decide a call before canUseTool is
      // asked. A gate deny wins first; an approved card is final for that call (canUseTool reads the hook's answer, so it is one card).
      options.hooks?.PreToolUse?.push({ matcher: '.*', timeout: cardHookSeconds, hooks: [async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return { continue: true };
        const tin = (input.tool_input ?? {}) as Record<string, unknown>;
        const mode = effective();
        const g = decideGate({ toolName: input.tool_name, input: tin, agentId: agent.id, cwd: this.gateCwd(agent, input.tool_name, tin), tmpDir: GATE_TMP_DIR, projectId: this.projectOf(job.taskId, agent.id)?.id, startProjectId: startProjectOf(job), ctx: { roomHop: (job.origin?.hop ?? 0) > 0, tainted: this.active.get(job.taskId)?.tainted === true || job.origin?.tainted === true, connectorData: this.store.getTask(job.taskId)?.usedConnectors === true } }, gatesFor(this.config).rules, mode, job.origin?.approvalCeiling === 'ask');
        if (g.verdict === 'deny') return preToolDeny('Blocked by a gate rule (Settings -> Gates).');
        // the shell hook above decides a shell call from start to end
        if (SHELL_TOOLS.has(input.tool_name)) return { continue: true };
        return this.hookCards(job, agent, input.tool_name, tin, mode, input.tool_use_id, own);
      }] });
      // the hook above owns the floor's card for Claude's shell tools, so it is not asked a second time here
      const decide = this.toolDecider(job, agent, { floorCard: false });
      options.canUseTool = async (toolName, input, o) => {
        // a call a hook already decided on a card keeps that answer: Claude Code can still ask here after a hook allow (an ask rule, or an action no mode approves by itself)
        const d = this.takeHookDecided(job, o?.toolUseID) ?? await decide(toolName, input);
        return d.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: d.message ?? 'The user denied this action.' };
      };
    }
    // Folder trust again when the run's settings change under it (A-H2), in every mode: folder trust is not a permission card.
    options.hooks!.ConfigChange = [{ hooks: [async (input) => this.configChangeAnswer(job, agent, act, cwd, projectFolder ? [projectFolder] : [], input)] }];
    // The task list reaches Claude's own list through the documented SessionStart hook only: shown again after Claude
    // compacts, and handed over when a provider run changed it or the session is new. An agent without the tools gets neither.
    if (nativeTaskListOn(agent)) {
      options.hooks!.SessionStart = [{ hooks: [async (input) => {
        if (input.hook_event_name !== 'SessionStart') return { continue: true };
        const list = this.taskLists.load(job.taskId);
        let text: string | undefined;
        if (input.source === 'compact') text = renderForModel(list);
        else if (list.handoverPending || (!resume && list.list().length > 0)) {
          // a list another model emptied still hands over: Claude's own list holds tasks that no longer exist
          text = renderHandover(list) ?? (list.handoverPending ? renderEmptyHandover() : undefined);
          if (text) {
            // Claude's first step (TaskList) replaces the mirror with its own, still-behind list: the handed-over list is
            // kept aside and put back unless the run finishes (settleHandover)
            act.handoverFrom ??= TaskList.fromJSON(JSON.parse(JSON.stringify(list)));
            // the run's mirror becomes the taken-over list (flag cleared, or its next mirrored Task call would write it back),
            // with done tasks carried under their own ids so Claude's TaskList does not drop them
            const taken = carryDone(list);
            taken.handoverPending = false;
            this.keepTaskList(job.taskId, act, taken);
          }
        }
        return text ? { hookSpecificOutput: { hookEventName: 'SessionStart' as const, additionalContext: text } } : { continue: true };
      }] }];
    }
    return options;
  }

  /**
   * Compact a stored conversation now, on the user's request, for POST /api/tasks/:id/compact.
   *
   * The summary is written by the SAME model the last run used, so the compacted thread is still the same conversation
   * rather than a new one in a different voice. The result is appended as a system row: the transcript is append-only,
   * so the original turns stay retrievable and nothing is destroyed - which is also why a failed or declined compact
   * simply changes nothing rather than needing an undo.
   */
  async compactTaskNow(taskId: string, focus?: string): Promise<{ ok: boolean; detail: string }> {
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, detail: 'That task is not here any more.' };
    const model = task.model;
    // A Claude task's real context is Claude Code's own session, not the rows stored here. Legion's summariser would only
    // add a summary row Claude never reads, so this hands the job to Claude Code's built-in /compact in that session.
    const agentModel = this.store.getAgent(task.agentId)?.model;
    // An agent host (Hermes) keeps its own context; Legion has no summariser or /compact for it.
    if (runtimeOf(model) === 'acp' || runtimeOf(agentModel) === 'acp') return { ok: false, detail: 'Compacting is not supported for this agent.' };
    if (!task.provider && runtimeOf(model) === 'claude' && runtimeOf(agentModel) === 'claude') {
      if (!task.sessionId) return { ok: false, detail: 'There is nothing to compact yet. Send a message first, then compact.' };
      const f = focus?.trim();
      try {
        this.startTask({ agentId: task.agentId, prompt: f ? `/compact ${f}` : '/compact', source: 'ui', continueTaskId: taskId });
      } catch (e) {
        if (e instanceof EngineError && e.status === 409) return { ok: false, detail: 'This task is still running. Compact it after it stops.' };
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
      return { ok: true, detail: 'Claude Code is compacting this conversation.' };
    }
    if (!model || model === 'auto') {
      return { ok: false, detail: 'This conversation has not run on a provider model yet. Open it and send a message first, then compact.' };
    }
    const stored = this.store.listMessages(taskId);
    if (stored.length < 2) return { ok: false, detail: 'There is not enough conversation here to compact yet.' };

    const asMessages = toChatMessages(stored);
    // No provider runtime means no provider model could ever have run this task, so there is nothing to summarise
    // with. Declining is the honest answer; `this.providers!` here would throw a TypeError and surface as a 500.
    if (!this.providers) return { ok: false, detail: 'Provider models are not available in this build.' };
    const before = messagesTokens(asMessages);
    const notices: string[] = [];
    const result = await this.providers!.compactNow({
      model,
      messages: asMessages,
      ...(focus && focus.trim() ? { focus: focus.trim() } : {}),
      onNotice: (t) => { notices.push(t); },
    });
    for (const n of notices) this.addMessage(taskId, 'system', n);

    if (!result.compacted) {
      return { ok: false, detail: result.reason ?? 'Nothing was compacted; the conversation was left as it was.' };
    }
    // The summary row is what the next run reads, so it is stored like any other system row.
    const summaryRow = result.messages.find((m) => isSummaryMessage(m));
    if (summaryRow?.content) this.addMessage(taskId, 'system', summaryRow.content);
    const after = messagesTokens(toChatMessages(this.store.listMessages(taskId)));
    const lost = result.missing.length ? ` ${result.missing.length} item(s) did not survive the summary.` : '';
    return {
      ok: true,
      detail: `Compacted ${before} to about ${after} estimated tokens.${lost}`,
    };
  }

  /**
   * A run on an agent host that cannot start: no host setup in this core, an entry nobody set up, or one switched off. Never falls back to
   * Claude or a provider.
   */
  private runAgentHost(model: string, entry?: AcpEntry): Outcome {
    const entryId = parseAcpModel(model)?.entryId;
    const text = !entry
      ? entryId === 'hermes'
        ? 'This Legion cannot run Hermes agents yet. Update Legion, or choose another model for this agent.'
        : `The agent host "${entryId ?? model.slice('acp:'.length)}" is not set up. Choose another model for this agent in Settings.`
      : !entry.enabled
        ? (entry.id === 'hermes' ? `${entry.label} is off. Turn on "Offer Hermes" in Settings, Agent hosts, or choose another model for this agent.` : `${entry.label} is switched off in Settings. Choose another model for this agent.`)
        : 'This Legion cannot run Hermes agents yet. Update Legion, or choose another model for this agent.';
    return { subtype: 'error_during_execution', isError: true, errorText: text };
  }

  // ---------------------------------------------------------------- agent host (ACP) runs

  /** The folder an agent host run works in: the project's folder, else the agent's own, else its default workspace. */
  private acpFolder(job: Job, agent: AgentProfile): string {
    return this.projectOf(job.taskId, agent.id)?.folder || agent.cwd || join(this.config.workspaceDir, agent.id);
  }

  /** The folders an agent host run may never work in or above: Legion's data folder and protected files, and the agent's own home. */
  private acpOffLimits(entry: AcpEntry): string[] {
    const host = this.agentHost;
    return [...this.protectedDirs(), ...(host ? [host.dataDir] : []), ...hermesHomes(entry, host?.hermesHome)];
  }

  /** The shells a command of an agent host may be written for on this computer. */
  private acpShellKinds(): ShellKind[] { return process.platform === 'win32' ? ['sh', 'cmd', 'pwsh'] : ['sh']; }

  /** The data folder guard's reading of a command against some targets. One seam for the three checks below, so a reader that fails is one thing to handle. */
  private acpFolderRead(command: string, kind: ShellKind, targets: string[], folder: string): ReturnType<typeof dataFolderRead>['hit'] {
    return dataFolderRead(command, kind, targets, { cwd: folder }).hit;
  }

  /**
   * What a request names of Legion's protected files and folders, or of the agent's own home, in words ("Legion's own settings: gates"), and
   * why Legion could not read what it names (`unreadable`). Every path of a request is checked (a multi-file patch holds several), a command is
   * read by the data folder guard (paths resolved from the agent's folder), never by a word it merely shares with a folder name. A reader that
   * fails, or a path that cannot be read, is `unreadable`: the caller treats it like a hit, never like a miss.
   * Display only, except in Bypass, where either turns the answer into a card.
   */
  private acpTouches(folder: string, entry: AcpEntry, r: MappedPermission): { settings?: string; unreadable?: string } {
    const command = typeof r.input.command === 'string' ? r.input.command : '';
    const readable = command.length > 0 && command.length <= MAX_READABLE;
    const found = requestPaths(r);
    let unreadable = found.unreadable;
    // the agent opens a path from its own folder, and `~` in its home folder: both are expanded here before the compare
    const opened: string[] = [];
    for (const p of found.paths) { const x = expandRequestPath(p, folder); if (x === undefined) unreadable ??= "a file in it is named through another user's home folder"; else opened.push(x); }
    if (r.toolName === 'Bash' && typeof r.input.command !== 'string') unreadable ??= 'its command is not text';
    const own = new Set(hermesHomes(entry, this.agentHost?.hermesHome));
    const kinds = this.acpShellKinds();
    for (const t of this.acpOffLimits(entry)) {
      const name = basename(t);
      if (!name) continue;
      let hit = false;
      try {
        hit = opened.some((p) => pathInside(t, p));
        // the whole path in the text is a cheap, exact test, so it runs on a command of any length; the guard reads only one it can hold
        if (!hit && command) hit = commandNamesPath(command, t) || (readable && kinds.some((k) => this.acpFolderRead(command, k, [t], folder) === 'names'));
      } catch { unreadable ??= 'the check itself failed'; }
      if (hit) return { settings: `${own.has(t) ? `${entry.label}'s` : "Legion's"} own settings: ${name}`, ...(unreadable ? { unreadable } : {}) };
    }
    return unreadable ? { unreadable } : {};
  }

  /** Why a command must never run, when the owner turned the disaster stop on: a whole drive or home folder, hidden code, or Legion's own settings folder. */
  private acpDisaster(folder: string, entry: AcpEntry, r: MappedPermission): string | undefined {
    const command = typeof r.input.command === 'string' ? r.input.command : '';
    if (r.toolName !== 'Bash' || !command || command.length > MAX_READABLE) return undefined;
    const kinds = this.acpShellKinds();
    try {
      for (const kind of kinds) { const refused = refuseCatastrophic(command, kind); if (refused) return refused; }
      const folders = [...this.protectedDirs(), ...(this.agentHost ? [this.agentHost.dataDir] : [])];
      for (const kind of kinds) if (this.acpFolderRead(command, kind, folders, folder) === 'names') return "It works on Legion's own settings folder.";
    } catch { return 'The check itself failed.'; }
    return undefined;
  }

  /** Why Legion cannot judge a command (too long, a program or a path only known when it runs), or undefined when it can. The floor above cannot refuse such a command, so Bypass must ask. */
  private acpUnjudged(folder: string, r: MappedPermission): string | undefined {
    const command = typeof r.input.command === 'string' ? r.input.command : '';
    if (r.toolName !== 'Bash' || !command) return undefined;
    if (command.length > MAX_READABLE) return `it is too long to read safely (${command.length.toLocaleString('en-US')} characters)`;
    const kinds = this.acpShellKinds();
    try {
      for (const kind of kinds) { const why = unjudgeableCommand(command, kind); if (why) return why; }
      const folders = [...this.protectedDirs(), ...(this.agentHost ? [this.agentHost.dataDir] : [])];
      for (const kind of kinds) if (this.acpFolderRead(command, kind, folders, folder) === 'hidden') return "a path in it is built when it runs and could point at Legion's own settings folder";
    } catch { return 'the check itself failed'; }
    return undefined;
  }

  /** The mode Legion maps for this entry. An entry that is not tested with Legion never runs Full, so it never gets dont_ask or Bypass. */
  private acpModeNow(job: Job, agent: AgentProfile, entry: AcpEntry): RunMode {
    const mode = this.modeNow(job, agent);
    return mode === 'full' && !entryLimits(entry).fullAllowed ? 'ask' : mode;
  }

  /** Bypass: the owner's preset turned the tool cards off and nothing caps the run. Full alone is not enough; its commands still card. */
  private acpBypass(job: Job, agent: AgentProfile, entry: AcpEntry): boolean {
    return this.acpModeNow(job, agent, entry) === 'full' && !job.origin?.approvalCeiling && this.gates?.gate('tool-cards', startProjectOf(job)) === false;
  }

  /**
   * Does the request match one of the owner's Block rules (Settings, Gates)? The request is read as the Claude-style call it maps to, and every file an edit
   * names (a multi-file patch holds several) is read as a call of its own. Only a Block rule applies: Ask and Allow rules never answer for Hermes.
   */
  private acpBlocked(job: Job, agent: AgentProfile, folder: string, r: MappedPermission): boolean {
    const rules = gatesFor(this.config).rules;
    if (!rules.some((x) => x.enabled && x.then === 'deny')) return false;
    const base = { toolName: r.toolName, agentId: agent.id, cwd: folder, tmpDir: GATE_TMP_DIR, projectId: this.projectOf(job.taskId, agent.id)?.id, startProjectId: startProjectOf(job), ctx: { roomHop: (job.origin?.hop ?? 0) > 0, tainted: true, connectorData: this.store.getTask(job.taskId)?.usedConnectors === true } };
    const calls: Array<Record<string, unknown>> = [r.input];
    if (r.toolName !== 'Bash') {
      for (const p of requestPaths(r).paths) {
        calls.push({ ...r.input, file_path: p });
        const x = expandRequestPath(p, folder); // the file the agent will open: `~` and a relative path are read as the agent reads them
        if (x !== undefined && x !== p) calls.push({ ...r.input, file_path: x });
      }
    }
    try { return calls.some((input) => decideGate({ ...base, input }, rules, 'full', false).verdict === 'deny'); } catch { return true; } // a rule check that cannot run refuses, it never allows
  }

  /**
   * One Hermes permission request. Gating happens here and only here (tool_call updates are display and taint only). Order: the disaster stop
   * (no card, in every mode), Bypass (allow once, no card, unless the request touches Legion's settings or Legion cannot judge it), then one card
   * with the agent's own options. A no sends the agent's own reject option; `cancelled` is for Legion's own cancel and for a card that closed with no answer.
   */
  private async acpPermission(job: Job, agent: AgentProfile, entry: AcpEntry, folder: string, r: MappedPermission): Promise<{ optionId: string } | { cancelled: true }> {
    const sw = this.config.acp?.switches;
    const reject = r.options.find((o) => o.kind === 'reject_once');
    const no = (): { optionId: string } | { cancelled: true } => (reject ? { optionId: reject.optionId } : { cancelled: true });
    // The owner's Block rules come first, in every mode and whatever the switches say: they are the owner's own explicit deny list (R71)
    if (this.acpBlocked(job, agent, folder, r)) { this.addMessage(job.taskId, 'system', named(blockedNote(), entry.label)); return no(); }
    const why = sw?.disasterStop ? this.acpDisaster(folder, entry, r) : undefined;
    if (why) { this.addMessage(job.taskId, 'system', named(disasterNote(why), entry.label)); return no(); }
    const { settings, unreadable } = this.acpTouches(folder, entry, r);
    let unjudged: string | undefined;
    const bypass = sw?.modeMap === true && this.acpBypass(job, agent, entry);
    if (bypass) {
      // Bypass promises no cards except for the owner's settings. A request that touches them, or whose files Legion cannot read, always asks (the
      // disaster stop switch does not matter). A command Legion cannot judge asks only when the owner turned the disaster stop on.
      unjudged = !settings && !unreadable && sw.disasterStop ? this.acpUnjudged(folder, r) : undefined;
      const once = r.options.find((o) => o.kind === 'allow_once');
      if (once && !settings && !unreadable && !unjudged) return { optionId: once.optionId };
    }
    let shown = sw?.answerOnce ? r.options.filter((o) => o.kind !== 'allow_always') : r.options;
    // The owner is never asked to allow text the card cannot show: past the card's limit only the no options stay, and the card says so.
    const hidden = cardHidden(r);
    if (hidden > 0) shown = shown.filter((o) => o.kind !== 'allow_once' && o.kind !== 'allow_always');
    if (shown.length === 0) return no();
    const o = job.origin;
    const projectId = this.projectOf(job.taskId, agent.id)?.id;
    const lead = [...(settings ? [`This touches ${settings}`] : []), ...(bypass && unreadable ? [`Legion cannot tell which files this touches: ${unreadable}. So it asks you, even in Bypass.`] : []), ...(unjudged ? [`Legion cannot tell what this command will do: ${unjudged}. So it asks you, even in Bypass.`] : []), ...(hidden > 0 ? ['This is too long to show in full, so you can only say no.'] : [])];
    const answer = await this.approvals.requestAcp(job.taskId, agent.id, {
      toolName: r.toolName, title: r.title, summary: cardSummary(r, lead), input: r.input, options: shown,
      waitMs: permissionWaitOf(this.agentHost?.permissionWaitMs, entry),
      ...(o ? { origin: { roomId: o.roomId, fromAgentId: o.fromAgentId, hop: o.hop } } : {}), ...(projectId ? { projectId } : {}),
    });
    if (answer.kind === 'option') return { optionId: answer.optionId };
    return answer.kind === 'denied' ? no() : { cancelled: true };
  }

  /** Legion's tools for one run, handed to the run key. A tool call waits at most as long as the agent host does, card time included. */
  private acpRunHost(job: Job, agent: AgentProfile, act: Active, entry: AcpEntry): RunToolsHost {
    const taskId = job.taskId;
    const servers: RunToolsHost['servers'] = {};
    for (const [name, cfg] of Object.entries(this.buildMcpServers(agent, job, act, 'acp'))) if (cfg.type === 'sdk') servers[name] = cfg;
    const decide = this.toolDecider(job, agent);
    const waitMs = toolWaitOf(this.agentHost?.toolWaitMs, entry);
    return {
      servers, signal: act.ac.signal, cancelled: () => act.cancelled || act.ac.signal.aborted,
      // the deadline is this call's own; a card it raises closes at the deadline, or at once when the agent host cancels this one call
      authorize: async (name, input, signal) => {
        const d = await this.approvals.withDeadline(taskId, Date.now() + waitMs, () => decide(name, input), signal);
        return signal?.aborted ? { allow: false, message: 'The agent cancelled this call, so it was not run.' } : d;
      },
      noteToolUse: (name, id, input) => this.noteToolUse(job, act, name, id, input),
      onToolCall: (name, id, input) => {
        let json: string;
        try { json = JSON.stringify(input ?? {}); } catch { json = '{}'; }
        if (json.length > 500) json = json.slice(0, 499) + '…';
        this.addMessage(taskId, 'tool', json, name, undefined, { toolUseId: id });
        this.mascot('hacking', name);
      },
      onToolResult: (id, text) => { if (text.trim()) this.addMessage(taskId, 'tool', clipToolResult(text), undefined, undefined, { resultFor: id }); },
      onNotice: (text) => { this.addMessage(taskId, 'system', text); },
    };
  }

  /** The text of an error with the registered secrets taken out, before it reaches a task, a thread or a log. */
  private redactText(text: string): string {
    return redactValues(logRedact(text), [...liveSecrets(this.config), ...(this.providers?.secretValues() ?? []), ...(this.webSearch?.secretValues() ?? [])]);
  }

  /** The words about Hermes's tool list, when an error says it refused the list Legion sent. */
  private acpPolicyOf(e: unknown): string | undefined {
    if (e instanceof AcpRefusal) return toolPolicyText(e.message);
    const raw = e instanceof Error ? e.message : String(e);
    return toolPolicyText(`${raw} ${e instanceof RpcError ? JSON.stringify(e.data ?? '') : ''}`);
  }

  /** What went wrong, in words a person reads. The agent's raw text is not the headline, and it never goes out unredacted or with a local path in it (the task error is read by outside clients). The full text goes to the log. */
  private acpFailText(e: unknown, proc: AgentProcess | undefined, entry: AcpEntry): string {
    const N = (t: string): string => named(t, entry.label);
    const shown = (t: string): string => stripPaths(this.redactText(t));
    if (!(e instanceof AcpRefusal)) console.error(`[${entry.id}] run failed: ${this.redactText(e instanceof Error ? e.message : String(e)).slice(0, 2000)}${proc?.stderrTail ? ` | stderr: ${this.redactText(proc.stderrTail().trim().split('\n').slice(-3).join(' / ')).slice(0, 600)}` : ''}`);
    if (e instanceof AcpRefusal) return N(toolPolicyText(e.message) ?? refusalText(e.reason));
    if (e instanceof AgentLaunchError) return e.code === 'not-found' ? N('Hermes was not found on your computer. Install it, or check its command in Settings, Agent hosts.') : `${N('Hermes could not be started.')} ${shown(e.message)}`.slice(0, 300);
    const policy = this.acpPolicyOf(e);
    if (policy) return N(policy);
    const raw = e instanceof Error ? e.message : String(e);
    const state = sessionStateText(`${raw} ${e instanceof RpcError ? JSON.stringify(e.data ?? '') : ''}`);
    if (state) return N(state);
    if (e instanceof RpcClosed) {
      const last = (proc?.stderrTail() ?? '').trim().split('\n').pop()?.trim();
      return `${N('Hermes stopped before it finished.')}${last ? ` It said: ${shown(last).slice(0, 200)}` : ''}`;
    }
    return `${N('Hermes failed.')} ${shown(raw).slice(0, 300)}`;
  }

  /**
   * One run on an agent host (Hermes). The run is tainted from the start: the agent reads the web and runs commands where Legion cannot see.
   * The run key is issued inside the try whose finally revokes it and ends the process, so no exit path leaves either behind.
   */
  private async runAcp(job: Job, agent: AgentProfile, entry: AcpEntry, prompt: string, act: Active, modelId?: string): Promise<Outcome> {
    const host = this.agentHost!;
    const taskId = job.taskId;
    const fail = (errorText: string): Outcome => ({ subtype: 'error_during_execution', isError: true, errorText });
    const say = (text: string): string => named(text, entry.label); // the fixed texts name Hermes; another agent host is named by its entry
    const sw = this.config.acp?.switches;
    act.tainted = true;
    this.patchTask(taskId, { runtime: entry.label, tainted: true });
    act.progress = { startedAt: nowIso(), turn: 0, maxTurns: 0, tool: null, turnIds: new Set(), thinking: false };
    this.emitProgress(taskId, act);
    let token: RunToken | undefined;
    let proc = undefined as AgentProcess | undefined;
    try { host.onRunStart?.(entry); } catch { /* a warm-up must never stop a run */ }
    try {
      const folder = this.acpFolder(job, agent);
      const off = this.acpOffLimits(entry);
      // the long-path, device and NT object spellings name the same folder as the plain one: the rule reads the plain spelling, and a spelling it cannot read is refused
      const plain = process.platform === 'win32' ? plainWindowsPath(folder) : folder;
      if (plain === undefined || isAdminShare(plain) || off.some((t) => pathInside(t, plain) || pathInside(plain, t))) return fail(say(HERMES_CWD_TEXT));
      mkdirSync(folder, { recursive: true });
      // R51: the Contained promise must hold when the run starts, not only when the owner set the profile up
      if (entry.contained) {
        const block = await (host.containedGate ?? containedRunBlock)(entry);
        if (act.cancelled) return { subtype: 'cancelled', isError: false };
        if (block) return fail(this.redactText(block).slice(0, 700));
      }
      // Another agent, a room or an outside app started this run and it is capped or tainted: the owner says yes before Hermes gets it
      const from = job.origin;
      if (from && (from.approvalCeiling !== 'full' || from.tainted)) {
        const allowed = await this.approvals.request(taskId, agent.id, entry.label, { agent: agent.name }, { roomId: from.roomId, fromAgentId: from.fromAgentId, hop: from.hop }, {
          noRemember: true,
          summary: `Another agent or app asked ${entry.label} to work for you. ${entry.label} runs commands and changes files on your computer with its own tools, and Legion cannot see most of what it does. Allow it only if you expect this.`,
        });
        if (!allowed || act.cancelled) return act.cancelled ? { subtype: 'cancelled', isError: false } : fail(say(HERMES_NOT_ALLOWED_TEXT));
      }
      // an entry that is not tested never runs Full or Bypass: said once, here, so the owner knows why it asks
      if (sw?.modeMap && !entryLimits(entry).fullAllowed && this.modeNow(job, agent) === 'full') this.addMessage(taskId, 'system', say(HERMES_UNTESTED_TEXT));
      const mcpServers: AcpStdioServer[] = [];
      if (entryLimits(entry).legionTools) {
        token = host.issueRunToken ? host.issueRunToken(taskId, agent.id) : issueRunToken(taskId, agent.id);
        token.bind(this.acpRunHost(job, agent, act, entry));
        mcpServers.push(shimServer(token.token, host.port));
      }
      const stored = this.store.getTask(taskId)?.acp;
      const watchdogMs = host.watchdogMs ?? (this.config.acp?.watchdogMinutes ?? 10) * 60_000;
      const scrub = this.scrubFor(job);
      const start = async (resumeId: string | undefined): Promise<AcpSession> => {
        proc = startAgentProcess(entry, { cwd: folder, stripSkipFlags: sw?.stripSkipFlags === true, dataDir: host.dataDir, envKeep: scrub.keep ?? [], ...(scrub.scrub === false ? { scrub: false } : {}) });
        act.acpProc = proc;
        return AcpSession.open(proc, {
          cwd: folder, mcpServers, watchdogMs, ...(host.cancelGraceMs !== undefined ? { cancelGraceMs: host.cancelGraceMs } : {}),
          ...(resumeId !== undefined ? { resumeId, ...(stored?.cumulative ? { usageBaseline: stored.cumulative } : {}) } : {}),
          ...(modelId ? { modelId } : {}), ...(sw?.modeMap ? { mode: agentModeFor(this.acpModeNow(job, agent, entry)) } : {}),
        }).catch((err: unknown) => {
          // the Doctor says what to do about a missing sign-in when it has seen one
          if (err instanceof AcpRefusal && err.reason === 'auth') noteAuthFailure(entry.id);
          throw err;
        });
      };
      const resumeId = stored && stored.entryId === entry.id ? stored.sessionId : undefined;
      let session: AcpSession;
      let fresh = resumeId === undefined;
      try {
        session = await start(resumeId);
      } catch (e) {
        if (resumeId === undefined || act.cancelled) throw e;
        // only a conversation the agent no longer has is let go. A passing failure (a slow start, a crash) and a refused tool list (Hermes needs an update, or is
        // still holding the earlier list) keep it: the conversation exists and can be continued once that is put right
        if (!(e instanceof AcpRefusal && e.reason === 'not-found')) throw e;
        this.patchTask(taskId, { acp: undefined });
        await proc?.stop();
        this.addMessage(taskId, 'system', say(HERMES_SESSION_GONE_TEXT));
        fresh = true;
        session = await start(undefined);
      }
      act.acp = { session, proc: proc! };
      act.reached = true;
      noteAgentVersion(entry.id, session.agentVersion); // the Doctor shows the version of the Hermes that ran, and a session means it signed in
      const sameSession = fresh ? undefined : stored;
      // R76: set as soon as the session is stored, like a Claude run: a pause at a limit, a stall or a crash after this point can be continued in the same Hermes conversation
      this.patchTask(taskId, { resumable: true, acp: { entryId: entry.id, sessionId: session.sessionId, ...(sameSession?.cumulative ? { cumulative: sameSession.cumulative } : {}) } });
      if (act.cancelled) return { subtype: 'cancelled', isError: false };

      let said = '';
      let steps = 0;
      let overSteps = false;
      const resulted = new Set<string>();
      const cb: AcpCallbacks = {
        onText: (d) => { said += d; this.bus.emit({ type: 'message.delta', taskId, text: d }); },
        onThought: () => { if (act.progress && !act.progress.thinking) { act.progress.thinking = true; this.emitProgress(taskId, act); } },
        onToolStart: (t) => {
          if (isRouteTool(t.toolName)) return; // the Legion route wrote its own rows for this call
          this.noteToolUse(job, act, t.toolName, t.toolCallId, t.input);
          this.addMessage(taskId, 'tool', t.title, t.toolName, undefined, { toolUseId: t.toolCallId });
          this.mascot('hacking', t.toolName);
          if (act.progress) { act.progress.tool = t.toolName; act.progress.thinking = false; this.emitProgress(taskId, act); }
          steps += 1;
          if (entry.maxSteps !== undefined && steps > entry.maxSteps && !overSteps) { overSteps = true; void session.cancel().catch(() => undefined); }
        },
        onToolUpdate: (t) => {
          if (isRouteTool(t.toolName) || resulted.has(t.toolCallId) || (t.status !== 'completed' && t.status !== 'failed')) return;
          resulted.add(t.toolCallId);
          if (t.text?.trim()) this.addMessage(taskId, 'tool', clipToolResult(t.text), undefined, undefined, { resultFor: t.toolCallId });
        },
        onPlan: (items) => { if (act.progress) { act.progress.todos = items; this.emitProgress(taskId, act); } },
        onPermission: (r) => this.acpPermission(job, agent, entry, folder, r),
        onUsage: () => undefined, // the turn's end carries the same figure
        onNote: (text) => { this.addMessage(taskId, 'system', say(text)); },
      };
      const text = fresh && agent.systemPrompt.trim() ? `${agent.systemPrompt.trim()}\n\n${prompt}` : prompt;
      let turn: AcpTurnEnd;
      try { turn = await session.prompt(text, cb); }
      catch (e) {
        if (act.cancelled || act.ac.signal.aborted) return { subtype: 'cancelled', isError: false };
        return fail(this.acpFailText(e, proc, entry));
      } finally {
        if (act.progress?.thinking) { act.progress.thinking = false; this.emitProgress(taskId, act); }
      }
      if (said.trim()) this.addMessage(taskId, 'assistant', said);
      if (act.cancelled) return { subtype: 'cancelled', isError: false };

      // usage: the agent reports tokens, never a price
      const cur = this.store.getTask(taskId);
      const delta = turn.usage;
      const cost = delta ? acpCostOf(entry, delta) : undefined;
      const tokens = {
        ...(delta ? { inputTokens: (cur?.tokenUsage?.inputTokens ?? 0) + delta.input, outputTokens: (cur?.tokenUsage?.outputTokens ?? 0) + delta.output } : (cur?.tokenUsage ?? {})),
        ...(!delta || cur?.tokenUsage?.unknown ? { unknown: true as const } : {}),
      };
      const sid = session.sessionId;
      this.patchTask(taskId, {
        tokenUsage: tokens,
        acp: { entryId: entry.id, sessionId: sid, ...(turn.cumulative ? { cumulative: turn.cumulative } : sameSession?.cumulative ? { cumulative: sameSession.cumulative } : {}) },
        ...(cost !== undefined ? { costUsd: (cur?.costUsd ?? 0) + cost, costUnknown: undefined } : { costUnknown: true }),
        ...(turn.stopReason === 'end_turn' && said.trim() ? { result: this.keepResult(taskId, said) } : {}),
      });
      if (cost !== undefined) this.noteSpend(taskId, cost);
      if (turn.baselineUnknown) this.addMessage(taskId, 'system', say(HERMES_BASELINE_TEXT));

      if (overSteps) return { subtype: 'error_max_turns', isError: true, errorText: `Stopped after ${entry.maxSteps} Hermes steps` };
      const total = (tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0);
      if (entry.maxTokensPerTask !== undefined && total >= entry.maxTokensPerTask) return { subtype: 'error_max_budget_usd', isError: true, errorText: `Stopped after ${total.toLocaleString('en-US')} tokens` };
      switch (turn.stopReason) {
        case 'end_turn': return { subtype: 'success', isError: false };
        case 'max_turn_requests': return { subtype: 'error_max_turns', isError: true, errorText: `Stopped after ${Math.max(1, steps)} Hermes steps` };
        case 'cancelled': act.cancelled = true; this.markCancelled(taskId); return { subtype: 'cancelled', isError: false };
        case 'watchdog': return fail(say(HERMES_WATCHDOG_TEXT));
        case 'max_tokens': return fail(say(HERMES_MAX_TOKENS_TEXT));
        default: return fail(say(HERMES_REFUSED_TEXT));
      }
    } catch (e) {
      if (act.cancelled || act.ac.signal.aborted) return { subtype: 'cancelled', isError: false };
      return fail(this.acpFailText(e, proc, entry));
    } finally {
      act.acp = undefined;
      act.acpProc = undefined;
      token?.revoke();
      try { await proc?.stop(); } catch { /* the process is gone or will be killed with the core */ }
    }
  }

  /** One run on a non-Claude provider (the seam into src/core/providers). Never falls back to Claude: a failure is the task's error. */
  private async runProvider(job: Job, agent: AgentProfile, pr: ResolvedModel, prompt: string, act: Active): Promise<Outcome> {
    const taskId = job.taskId;
    const servers: ProviderHost['servers'] = {};
    const external: NonNullable<ProviderHost['external']> = {};
    const allServers = this.buildMcpServers(agent, job, act, 'provider');
    for (const [name, cfg] of Object.entries(allServers)) {
      if (cfg.type === 'sdk') servers[name] = cfg;
      else if (cfg.type === 'http' || cfg.type === 'sse') external[name] = { type: cfg.type, url: cfg.url, ...(cfg.headers ? { headers: cfg.headers } : {}) };
      else if (cfg.type === 'stdio' || cfg.type === undefined) external[name] = { command: (cfg as { command: string }).command, ...((cfg as { args?: string[] }).args ? { args: (cfg as { args?: string[] }).args } : {}), ...((cfg as { env?: Record<string, string> }).env ? { env: (cfg as { env?: Record<string, string> }).env } : {}) };
    }
    const decide = this.toolDecider(job, agent);
    const projectHere = this.projectOf(taskId, agent.id);
    // in the project when it was queued, not any more when it starts: said in the thread, as on the Claude path
    if (!projectHere && job.projectAtStart && this.projects) this.noteProjectLost(taskId, job.projectAtStart, agent);
    // only the agent shell writes files on a provider run
    if (agent.host?.enabled) this.noteSharedFolder(taskId, agent, projectHere);
    const host: ProviderHost = {
      taskId, agentName: agent.name, signal: act.ac.signal, cancelled: () => act.cancelled || act.ac.signal.aborted,
      // the same teamwork and capabilities blocks as a Claude run, so an agent on another provider gets the same rules and tool facts
      systemPrompt: LEGION_PREAMBLE.replace('{name}', agent.name)
        + '\n\n' + renderTeamwork(allServers)
        + this.modulePreamble(agent, { prompt, taskId, ...(job.origin ? { origin: job.origin } : {}), tainted: act.tainted || job.origin?.tainted === true, ...(projectHere ? { projectId: projectHere.id } : {}) })
        // only the agent shell runs commands on a provider run, so only an agent with it has variables held back from anything
        + (() => { const t = agent.host?.enabled ? this.heldBackNote(job, agent, act, { child: false, host: true }) : ''; return t ? '\n\n' + t : ''; })()
        + '\n\n' + renderCapabilities(agent, { servers: allServers, ...(job.origin?.approvalCeiling ? { ceiling: job.origin.approvalCeiling } : {}), vmEnabledForAgent: !!agent.vm?.enabled, runMode: this.modeNow(job, agent) })
        + (agent.systemPrompt ? '\n\n' + agent.systemPrompt : '')
        + (() => { const t = renderForModel(this.taskLists.load(taskId)); return t ? '\n\n' + t : ''; })()
        + `\n\nYou are running on ${pr.model} through ${pr.entry?.label ?? pr.providerId}. You have only the tools listed in this request; ${this.webSearch?.searchOn() || this.webSearch?.readOn() ? 'you have no file or shell tools of your own, and your web tools are the ones listed (web_search and web_read, where listed).' : 'you have no file, shell or web tools of your own.'}`
        + (leadDoctrineFor(agent.id) ? '\n\n' + leadDoctrineFor(agent.id) : '')
        // the project's own rules and folder, last, as on the Claude path (council A5: provider runs had none)
        + (projectHere ? '\n\n' + projectSection({ name: projectHere.name, instructions: projectHere.instructions, folder: projectHere.folder }, { files: agent.host?.enabled === true }) : ''),
      prompt, stored: this.store.listMessages(taskId),
      taskListText: () => renderForModel(this.taskLists.load(taskId)),
      servers, external,
      authorize: decide,
      noteToolUse: (name, id, input) => this.noteToolUse(job, act, name, id, input),
      // the same live progress a Claude run sends: the turn against the provider loop's own limit, the tool it waits on, the task list
      onTurn: (turn, maxTurns) => {
        if (!act.progress) {
          act.progress = { startedAt: nowIso(), turn, maxTurns, tool: null, turnIds: new Set(), thinking: false };
          const list = this.taskLists.load(taskId);
          if (list.list().length) act.progress.todos = checklistOf(list);
        }
        act.progress.turn = turn;
        act.progress.tool = null;
        this.emitProgress(taskId, act);
      },
      onDelta: (text) => this.bus.emit({ type: 'message.delta', taskId, text }),
      onAssistantText: (text) => { this.addMessage(taskId, 'assistant', text); },
      onToolCall: (name, id, input) => {
        let json: string;
        try { json = JSON.stringify(input ?? {}); } catch { json = '{}'; }
        if (json.length > 500) json = json.slice(0, 499) + '…';
        this.addMessage(taskId, 'tool', json, name, undefined, { toolUseId: id });
        this.mascot('hacking', name);
        if (act.progress) { act.progress.tool = name; this.emitProgress(taskId, act); }
      },
      onToolResult: (id, text) => { if (text.trim()) this.addMessage(taskId, 'tool', clipToolResult(text), undefined, undefined, { resultFor: id }); },
      onNotice: (text) => { this.addMessage(taskId, 'system', text); },
    };
    const r = await this.providers!.run(host, pr);
    if (act.cancelled) return { subtype: 'cancelled', isError: false };
    // provider runs rebuild their history from the stored rows, which now hold the request and the work done so far
    if (r.turns > 0) act.reached = true;
    const cur = this.store.getTask(taskId);
    this.patchTask(taskId, {
      provider: pr.providerId,
      ...(act.reached ? { resumable: true } : {}),
      turns: (cur?.turns ?? 0) + r.turns,
      tokenUsage: {
        ...(r.usage ? { inputTokens: (cur?.tokenUsage?.inputTokens ?? 0) + r.usage.inputTokens, outputTokens: (cur?.tokenUsage?.outputTokens ?? 0) + r.usage.outputTokens } : (cur?.tokenUsage ?? {})),
        ...(r.usageUnknown || !r.usage || cur?.tokenUsage?.unknown ? { unknown: true } : {}),
      },
      ...(r.costUsd !== undefined ? { costUsd: (cur?.costUsd ?? 0) + r.costUsd } : {}),
      ...(!r.isError && r.resultText !== undefined ? { result: this.keepResult(taskId, r.resultText) } : {}),
    });
    if (r.costUsd !== undefined) this.noteSpend(taskId, r.costUsd);
    return { subtype: r.subtype, isError: r.isError, errorText: r.isError ? r.errorText : undefined };
  }

  /** Writes one cost to the spend ledger (the away module). Never throws: a failing ledger cannot fail a run. */
  /** The wait as the model should read it: "10 minutes", or the truth when quiet hours stretched it. */
  private waitedText(waitedMs: number | undefined): string {
    return waitedMs === undefined ? this.approvals.timeoutWait : describeWaited(waitedMs, this.approvals.waitMs);
  }

  private noteSpend(taskId: string, usd: number): void {
    if (!this.away || !(usd > 0) || !Number.isFinite(usd)) return;
    try {
      const t = this.store.getTask(taskId);
      this.away.recordSpend({ taskId, agentId: t?.agentId ?? '', ...(t?.projectId ? { projectId: t.projectId } : {}), usd });
    } catch { /* the ledger is advisory */ }
  }

  /** One SDK query() run. Returns the outcome of its result message; throws on SDK failure. */
  private async runOnce(job: Job, agent: AgentProfile, model: ConcreteModel, prompt: string, act: Active): Promise<Outcome> {
    // An agent host value is never a provider and never Claude: it is decided before either is asked.
    if (runtimeOf(model) === 'acp') {
      const parsed = parseAcpModel(model);
      const entry = parsed ? acpEntry(this.config, parsed.entryId) : undefined;
      if (!this.agentHost || !parsed || !entry || !entry.enabled) return this.runAgentHost(model, entry);
      return this.runAcp(job, agent, entry, prompt, act, parsed.modelId);
    }
    const pr = this.providers?.resolve(model);
    if (pr) return this.runProvider(job, agent, pr, prompt, act);
    // Never the Claude path: a `<id>:<model>` value whose provider resolves to nothing (no provider runtime at all,
    // a reserved id the config dropped, an id resolve() cannot parse) FAILS the way a preset-backed id with a
    // deleted entry already does (providers/runtime.ts:119) instead of being handed to the Claude SDK as a model
    // name. The owner must see "not set up any more", not a silent run on the wrong model. `arn:` is a Bedrock id
    // for the Claude path, never a provider (same exclusion as providerPrefix).
    const shaped = /^([A-Za-z][A-Za-z0-9-]{1,31}):/.exec(model);
    if (shaped && !/^arn:/i.test(model)) {
      return {
        subtype: 'error_during_execution', isError: true,
        errorText: `The provider "${shaped[1]}" is not set up any more. Choose another model for this agent in Settings, Providers.`,
      };
    }
    const resume = this.store.getTask(job.taskId)?.sessionId;
    const options = this.buildOptions(job, agent, model, act, prompt, resume);
    await this.checkAutoSupport(job, act, options, model);
    // Streaming input: the request is the first message of a stream the person can add to while the run works.
    // Plan only: the request is held back until the account check passes. The SDK writes a message to the CLI the moment it reads it, so a
    // stored Console key (which no setting can blank) would otherwise bill the first request before Legion could stop the run.
    const planOnly = isPlanOnly(this.config);
    const input = new InputChannel(prompt, planOnly);
    act.input = input;
    const q = this.queryFn({ prompt: input, options });
    act.q = q;
    // each run counts its own turns (the limit is per run); the clock and the tool reset with it
    act.progress = { startedAt: nowIso(), turn: 0, maxTurns: this.config.claude.maxTurns, tool: null, turnIds: new Set(), thinking: false };
    // the task's list is kept across its runs, so a continued conversation shows its checklist from the start
    act.taskList = this.taskLists.load(job.taskId);
    act.taskCalls = new Map();
    if (act.taskList.list().length) act.progress.todos = checklistOf(act.taskList);
    this.emitProgress(job.taskId, act);

    const aborted = new Promise<'aborted'>((res) => {
      if (act.ac.signal.aborted) res('aborted');
      else act.ac.signal.addEventListener('abort', () => res('aborted'), { once: true });
    });
    const it = q[Symbol.asyncIterator]();
    let outcome: Outcome | undefined;
    // Background agents (Claude Code's own subagents) die with the run's input stream: closing it while they work kills them. So a
    // success result closes the input only when no background agent is running; otherwise the run is held open until they report.
    const bg = new BackgroundTasks();
    act.bg = bg;
    let lastActivity = this.bgNow();
    let held = false;
    // a turn (the model answering a notification) has started since the run was held: then only its result may close the run
    let turnStarted = false;
    const watchdog = setInterval(() => {
      if (input.isClosed) return;
      const quiet = this.bgNow() - lastActivity;
      if (act.bgStopsAt !== undefined && this.bgNow() >= act.bgStopsAt) {
        const n = bg.count;
        this.addMessage(job.taskId, 'system', `Legion stopped waiting for background agents after ${Math.round(this.bgMaxHeldMs / 60_000)} minutes${n ? `; the ${n} still running ${n === 1 ? 'was' : 'were'} stopped` : ''}. Ask again to start the work over.`);
        for (const id of bg.ids()) { try { void (q as any).stopTask?.(id)?.catch?.(() => undefined); } catch { /* ignore */ } }
        input.close();
      } else if (bg.count > 0 && quiet >= this.bgStallMs) {
        this.addMessage(job.taskId, 'system', `Legion stopped waiting for ${bg.count} background agent${bg.count === 1 ? '' : 's'}: nothing came from them for ${Math.round(this.bgStallMs / 60_000)} minutes. They end with this run; ask again to start them over.`);
        input.close();
      } else if (held && bg.count === 0 && !turnStarted && quiet >= this.bgGraceMs) {
        // the last background agent reported and no turn followed: nothing is left to wait for
        input.close();
      }
    }, Math.max(1, Math.min(1000, Math.floor(Math.min(this.bgStallMs, this.bgGraceMs) / 4))));
    watchdog.unref?.();
    try {
      if (planOnly) {
        const stop = await this.planAccountCheck(q, aborted);
        if (stop) return stop;
        input.release();
      }
      for (;;) {
        const next = await Promise.race([it.next(), aborted]);
        if (next === 'aborted' || act.cancelled) return { subtype: 'cancelled', isError: false };
        if (next.done) break;
        lastActivity = this.bgNow();
        if (bg.note(next.value)) this.emitProgress(job.taskId, act);
        // only the run's own messages: a background agent's carry parent_tool_use_id and are not the model answering
        if (held && ['assistant', 'user', 'stream_event'].includes((next.value as any)?.type) && !(next.value as any)?.parent_tool_use_id) turnStarted = true;
        const o = this.handleMessage(job, act, next.value as any);
        // Backstop for the account check: a plan-only run whose init reports an API key source stops here; the finally below closes the query.
        if (o?.subtype === API_BILLING_BLOCKED) return o;
        // each result answers one message; once none are waiting the stream closes and the run ends, unless background agents still work
        if (o) {
          outcome = o;
          if (input.answered((next.value as any)?.queued_turn_count)) {
            if (o.isError || bg.count === 0) { held = false; act.bgStopsAt = undefined; input.close(); }
            else {
              turnStarted = false;
              if (!held) {
                held = true;
                act.bgStopsAt = this.bgNow() + this.bgMaxHeldMs;
                this.emitProgress(job.taskId, act);
                const n = bg.count;
                this.addMessage(job.taskId, 'system', `Waiting for ${n} background agent${n === 1 ? '' : 's'} to report before this run ends. Stop cancels them.`);
              }
            }
          }
        }
      }
    } catch (e) {
      if (act.cancelled || act.ac.signal.aborted) return { subtype: 'cancelled', isError: false };
      const text = e instanceof Error ? e.message : String(e);
      if (!outcome) return { subtype: 'error_during_execution', isError: true, errorText: text };
      // The SDK yields an error result and THEN throws "Claude Code returned an error result: ..." (its documented
      // single-shot behaviour, Query.readMessages). The result already carries the run's outcome; rethrowing would send
      // every turn-limit pause and every escalatable error down the generic failure path instead.
      if (outcome.isError) return outcome;
      throw e;
    } finally {
      clearInterval(watchdog);
      act.bg = undefined; act.bgStopsAt = undefined;
      // a thinking flag must never outlive its run
      if (act.progress?.thinking) { act.progress.thinking = false; this.emitProgress(job.taskId, act); }
      input.close();
      if (act.input === input) act.input = undefined;
      try { q.close?.(); } catch { /* ignore */ }
      try { void it.return?.(undefined)?.catch?.(() => undefined); } catch { /* ignore */ }
    }
    return outcome ?? { subtype: 'error_during_execution', isError: true, errorText: 'Claude ended without producing a result' };
  }

  /**
   * Remember which MCP servers the run started with. With claude.inheritMcp on, a server inherited from Claude Code that is Legion's own
   * /mcp (for example `claude mcp add legion http://127.0.0.1:<port>/mcp`) is switched off for this run, so an agent never talks to Legion through Legion.
   * Best effort and read-only otherwise: a failure here never touches the run.
   */
  private noteMcpInit(act: Active, servers: unknown): void {
    this.mcpTracker.record(servers, nowIso());
    const q = act.q as any;
    const inherit = this.config.claude.inheritMcp === true;
    const list = Array.isArray(servers) ? servers as Array<{ name?: unknown; status?: unknown }> : [];
    const trouble = list.some((s) => s.status === 'failed' || s.status === 'needs-auth');
    if (!q || typeof q.mcpServerStatus !== 'function' || !(inherit || trouble)) return;
    void (async () => {
      const full = await q.mcpServerStatus();
      this.mcpTracker.addDetails(full);
      if (!inherit || typeof q.toggleMcpServer !== 'function' || !Array.isArray(full)) return;
      for (const s of full) {
        if (s?.source === 'sdk' || typeof s?.name !== 'string') continue;
        if (s.name === 'legion' || isSelfMcpUrl(s.config?.url, this.config.port, { headers: s.config?.headers, authToken: this.config.authToken })) {
          try { await q.toggleMcpServer(s.name, false); } catch { this.mcpTracker.setNotice(`Could not switch off "${s.name}", which points back at Legion. It stays connected for this run.`); }
        }
      }
    })().catch(() => undefined);
  }

  /**
   * Plan-only start check: the initialize answer (`accountInfo()`) comes before any turn. A key source other than "none" ends the run;
   * an error or silence fails closed. A query without accountInfo (test fakes only) skips the check: the call below is typed against the SDK's Query, where accountInfo() is required, so an SDK without it fails typecheck before any release; and the init
   * message check in handleMessage stays as a backstop. Returns the outcome that ends the run, or undefined to let it go on.
   */
  private async planAccountCheck(q: ReturnType<QueryFn>, aborted: Promise<'aborted'>): Promise<Outcome | undefined> {
    if (typeof (q as any).accountInfo !== 'function') return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const info = await Promise.race([
        q.accountInfo(),
        aborted,
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timed out')), this.accountCheckMs); }),
      ]);
      if (info === 'aborted') return { subtype: 'cancelled', isError: false };
      const source = (info as { apiKeySource?: unknown } | undefined)?.apiKeySource;
      if (typeof source === 'string' && source !== '' && source !== 'none') return { subtype: API_BILLING_BLOCKED, isError: true, errorText: apiBillingBlockedText(source) };
      return undefined;
    } catch {
      return { subtype: PLAN_CHECK_FAILED, isError: true, errorText: PLAN_CHECK_FAILED_TEXT };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** One line about Claude's own checker in the activity log (advisory). */
  private noteChecker(job: Job, act: Active, text: string): void {
    void act;
    try { this.activity?.append({ kind: 'note', text: text.slice(0, 300), taskId: job.taskId, agentId: job.agentId }); } catch { /* advisory */ }
  }

  /**
   * The init message says which Claude mode the run really got. Smart asked for auto; a model, plan or CLI without it runs in Claude's default mode
   * (no error, no warning). That is shown once, in plain words, and Legion's own Smart judge is never used instead.
   */
  private noteCheckerMode(job: Job, act: Active, given: unknown, model?: unknown): void {
    if (!act.nativeChecks || typeof given !== 'string') return;
    const asked = act.sdkMode;
    act.sdkMode = given as ClaudeSdkMode;
    if (asked !== 'auto') return;
    if (given === 'auto') { this.patchTask(job.taskId, { claudeChecker: 'on' }); return; }
    this.markCheckerFallback(job, act, typeof model === 'string' ? model : undefined);
  }

  /** The run cannot use Claude's own checker: the task says so (the chip), and the thread and the activity log say it once. */
  private markCheckerFallback(job: Job, act: Active, model?: string): void {
    this.patchTask(job.taskId, { claudeChecker: 'fallback', ...(model ? { claudeCheckerModel: model } : {}) });
    if (act.checkerNoted) return;
    act.checkerNoted = true;
    const name = this.store.getAgent(job.agentId)?.name;
    const line = checkerFallbackLine([{ ...(name ? { agent: name } : {}), ...(model ? { model } : {}) }]);
    this.addMessage(job.taskId, 'system', line);
    this.noteChecker(job, act, line);
  }

  /**
   * Before a Smart run on Claude's own checks: does the model have the checker? Claude Code lists `supportsAutoMode` per model (no model call). When the list
   * shows the field for some model but not for this one, the run starts in Claude's default mode (Claude asks) and says so now, not after the first turn.
   * An unreadable list, a slow one, an older Claude Code that does not report the field, or a model that is not listed: nothing changes and the init message decides.
   */
  private async checkAutoSupport(job: Job, act: Active, options: Options, model: ConcreteModel): Promise<void> {
    if (!act.nativeChecks || act.sdkMode !== 'auto' || !this.bridge.catalog) return;
    let models: Catalog['models'] | undefined;
    try {
      const wait = new Promise<undefined>((res) => { setTimeout(() => res(undefined), CATALOG_WAIT_MS).unref?.(); });
      const c = await Promise.race([this.bridge.catalog(), wait]);
      if (c && !c.error) models = c.models;
    } catch { /* unknown: the init message decides */ }
    if (!models || !models.some((m) => m.supportsAutoMode === true)) return;
    const mine = models.find((m) => m.value === model || m.resolvedModel === model);
    if (!mine || mine.supportsAutoMode === true) return;
    options.permissionMode = 'default';
    act.sdkMode = 'default';
    this.markCheckerFallback(job, act, String(model));
  }

  /** Process one SDK message; returns an Outcome for `result` messages. */
  private handleMessage(job: Job, act: Active, msg: any): Outcome | undefined {
    const taskId = job.taskId;
    switch (msg?.type) {
      case 'system': {
        if (msg.subtype === 'init' && isPlanOnly(this.config) && typeof msg.apiKeySource === 'string' && msg.apiKeySource !== '' && msg.apiKeySource !== 'none') {
          return { subtype: API_BILLING_BLOCKED, isError: true, errorText: apiBillingBlockedText(msg.apiKeySource) };
        }
        if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
          // Set now, not when the run ends: a crash, a restart or a thrown error must still leave the task continuable.
          act.reached = true;
          this.patchTask(taskId, { sessionId: msg.session_id, resumable: true });
          this.noteMcpInit(act, msg.mcp_servers);
          this.noteCheckerMode(job, act, msg.permissionMode, msg.model);
        } else if (msg.subtype === 'permission_denied') {
          // Claude's own checker said no: the owner sees what and why. A denial by Legion's hooks or the owner's own answer is already on record.
          // (the hook and the permission prompt are Legion's own, as is the owner's answer on a card)
          const kind = String(msg.decision_reason_type ?? '');
          // (an answer of Legion's own, the owner's No on a card, comes back here with whatever type the SDK gives it: matched by the call's id)
          const deniedId = String(msg.tool_use_id ?? '');
          const ours = act.ownerDenied?.has(deniedId) === true;
          act.ownerDenied?.delete(deniedId);
          if (act.nativeChecks && kind !== 'hook' && kind !== 'permissionPromptTool' && !ours) {
            const why = String(msg.decision_reason ?? msg.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'no reason given';
            const tool = String(msg.tool_name ?? 'a tool').slice(0, 60);
            if (kind === 'classifier') {
              const text = `Claude's checker blocked: ${why} (${tool})`;
              this.addMessage(taskId, 'system', text);
              this.noteChecker(job, act, text);
            } else this.noteChecker(job, act, `Claude denied ${tool}: ${why}`);
          }
        } else if (msg.subtype === 'compact_boundary') {
          // Claude Code compacted its own context (on /compact, or by itself near the window's end): say so, or the
          // agent seems to forget early instructions for no visible reason.
          const pre = Number(msg.compact_metadata?.pre_tokens);
          const size = Number.isFinite(pre) && pre > 0 ? ` It held about ${Math.round(pre / 1000)}k tokens.` : '';
          this.addMessage(taskId, 'system', msg.compact_metadata?.trigger === 'auto'
            ? `Claude Code compacted this conversation by itself, to make room.${size} Early details may now be summarised.`
            : `Claude Code compacted this conversation.${size}`);
        } else if (msg.subtype === 'local_command_output' && typeof msg.content === 'string' && msg.content.trim()) {
          // Output of a slash command Claude Code ran locally (/cost, /context, ...), shown as an assistant message.
          this.addMessage(taskId, 'assistant', msg.content);
        }
        return undefined;
      }
      case 'stream_event': {
        const ev = msg.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string' && !msg.parent_tool_use_id) {
          this.bus.emit({ type: 'message.delta', taskId, text: ev.delta.text });
        }
        // A thinking block is shown only as a state ("Thinking"); its text is never stored or sent. The flag follows the block.
        const pg = act.progress;
        if (pg && !msg.parent_tool_use_id) {
          if (ev?.type === 'content_block_start' && (ev.content_block?.type === 'thinking' || ev.content_block?.type === 'redacted_thinking') && !pg.thinking) { pg.thinking = true; this.emitProgress(taskId, act); }
          else if (ev?.type === 'content_block_stop' && pg.thinking) { pg.thinking = false; this.emitProgress(taskId, act); }
        }
        return undefined;
      }
      case 'assistant': {
        const blocks: any[] = Array.isArray(msg.message?.content) ? msg.message.content : [];
        const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
        if (text) this.addMessage(taskId, 'assistant', text);
        // A turn is one model response of the run itself: one message id (the SDK may send a response in several
        // messages that share it). A subagent's messages carry parent_tool_use_id and are not the run's own turns.
        const pg = act.progress;
        // a finished response means the thinking in it is over, whatever its blocks said
        const wasThinking = pg?.thinking === true;
        if (pg && wasThinking) pg.thinking = false;
        let todosChanged = false;
        if (pg && !msg.parent_tool_use_id) {
          for (const b of blocks) {
            if (b?.type === 'tool_use' && b.name === 'TodoWrite') { const list = clipTodos(b.input); if (list) { pg.todos = list; todosChanged = true; } }
            else if (b?.type === 'tool_use' && CLAUDE_TASK_TOOLS.has(b.name) && typeof b.id === 'string') act.taskCalls?.set(b.id, { name: b.name, input: b.input });
          }
          const id = typeof msg.message?.id === 'string' ? msg.message.id : `n${pg.turnIds.size}`;
          const lastTool = [...blocks].reverse().find((b) => b?.type === 'tool_use');
          const before = `${pg.turn}|${pg.tool}|${pg.contextTokens ?? ''}`;
          if (!pg.turnIds.has(id)) { pg.turnIds.add(id); pg.turn = pg.turnIds.size; }
          if (lastTool) pg.tool = String(lastTool.name ?? 'tool');
          // the context after this response: its input plus the cache it read and wrote (a subagent's is its own context, so skipped above)
          const ctx = contextTokensOf(msg.message?.usage);
          if (ctx !== undefined) pg.contextTokens = ctx;
          if (`${pg.turn}|${pg.tool}|${pg.contextTokens ?? ''}` !== before || todosChanged || wasThinking) this.emitProgress(taskId, act);
        } else if (pg && wasThinking) this.emitProgress(taskId, act);
        for (const b of blocks) {
          if (b?.type !== 'tool_use') continue;
          this.noteToolUse(job, act, String(b.name ?? 'tool'), typeof b.id === 'string' ? b.id : undefined, b.input);
          let json: string;
          try { json = JSON.stringify(b.input ?? {}); } catch { json = '{}'; }
          if (json.length > 500) json = json.slice(0, 499) + '…';
          this.addMessage(taskId, 'tool', json, String(b.name ?? 'tool'), undefined, typeof b.id === 'string' ? { toolUseId: b.id } : undefined);
          this.mascot('hacking', String(b.name ?? ''));
        }
        return undefined;
      }
      case 'user': {
        // Tool results: stored (truncated) and paired with their call via resultFor, so the UI can expand them.
        if (msg.parent_tool_use_id) return undefined;
        const blocks: any[] = Array.isArray(msg.message?.content) ? msg.message.content : [];
        // the tool came back: the model is thinking again until its next call
        if (act.progress?.tool && blocks.some((b) => b?.type === 'tool_result')) { act.progress.tool = null; this.emitProgress(taskId, act); }
        // the structured result belongs to the message's one tool result; with several it cannot be told apart, so the text is used
        const results = blocks.filter((b) => b?.type === 'tool_result');
        for (const b of blocks) {
          if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          const raw = typeof b.content === 'string' ? b.content
            : Array.isArray(b.content) ? b.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n') : '';
          const call = act.taskCalls?.get(b.tool_use_id);
          if (call && act.taskList) {
            act.taskCalls!.delete(b.tool_use_id);
            const next = mirrorClaudeTaskCall(act.taskList, call, { structured: results.length === 1 ? msg.tool_use_result : undefined, text: raw, isError: b.is_error === true });
            if (next) this.keepTaskList(taskId, act, next);
          }
          if (!raw.trim()) continue;
          const text = clipToolResult(raw);
          this.addMessage(taskId, 'tool', text, undefined, undefined, { resultFor: b.tool_use_id });
        }
        return undefined;
      }
      case 'result': {
        const cur = this.store.getTask(taskId);
        const isError = Boolean(msg.is_error) || msg.subtype !== 'success';
        const text: string | undefined = msg.subtype === 'success'
          ? (typeof msg.result === 'string' ? msg.result : undefined)
          : (Array.isArray(msg.errors) && msg.errors.length ? msg.errors.join('; ') : undefined);
        // total_cost_usd is the SESSION's running total (sdk.d.ts: "read the latest result rather than summing"; a resumed
        // session continues from its saved total): only the rise since this session's last result is new spend. Summing it
        // re-added a thread's whole history on every resumed run (measured 4.4x, up to 12.4x on long threads).
        const total = typeof msg.total_cost_usd === 'number' && Number.isFinite(msg.total_cost_usd) ? msg.total_cost_usd : undefined;
        const sid = typeof msg.session_id === 'string' ? msg.session_id : undefined;
        const before = sid && cur?.costSessionId === sid ? (cur?.sessionCostUsd ?? 0) : 0;
        const spent = total === undefined ? 0 : total >= before ? total - before : total; // a lower total = the session's count restarted (/clear)
        this.patchTask(taskId, {
          costUsd: (cur?.costUsd ?? 0) + spent,
          ...(total !== undefined && sid ? { sessionCostUsd: total, costSessionId: sid } : {}),
          turns: (cur?.turns ?? 0) + (typeof msg.num_turns === 'number' ? msg.num_turns : 0),
          ...(typeof msg.session_id === 'string' && !cur?.sessionId ? { sessionId: msg.session_id } : {}),
          ...(!isError && text !== undefined ? { result: this.keepResult(taskId, text) } : {}),
        });
        this.noteSpend(taskId, spent);
        // Claude's checker blocked too many actions in a row and, with no one to ask, the run stopped: say so in plain words
        if (isError && typeof text === 'string' && /too many classifier denials/i.test(text)) {
          const note = "Claude's checker blocked several actions in a row; the run stopped. Review what it tried.";
          this.addMessage(taskId, 'system', note);
          this.noteChecker(job, act, note);
        }
        return { subtype: String(msg.subtype), isError, errorText: isError ? text : undefined };
      }
      default:
        return undefined;
    }
  }
}
