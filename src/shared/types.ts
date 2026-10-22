/**
 * Legion — shared contract.
 * Every module, the HTTP API, the MCP tools and the UI speak these types.
 */
import type { Room, RoomMessage, CommsState, TaskOrigin } from './comms.js';
import type { BlenderStatusView } from './blender.js';
import type { Project } from './projects.js';
import type { CiUpdateSummary } from './ci.js';
import type { Consequence } from './consequence.js';
import type { AcpConfig, AcpPatch, AcpView } from './acp-view.js';

/** What the user picks per agent/task. 'auto' lets the router decide. */
export type ModelChoice = 'auto' | string;
/** A concrete model actually used for a run (Claude Code aliases → latest Sonnet/Opus). */
/**
 * A model value Claude Code accepts: an alias ('sonnet', 'opus', 'haiku', …) or a full id
 * taken from the live model catalog (GET /api/catalog). Auto mode routes between 'sonnet' and 'opus'.
 */
export type ConcreteModel = string;

export type ApprovalMode = 'ask' | 'auto-edits' | 'full';

/**
 * A mode a run is judged by: the three stored agent modes plus Smart, which only a preset can give, plus `smart-edits`, which is never stored
 * and never a preset: it is what a run held by both Smart and Accept edits is judged by (a card whenever EITHER would card). An approval
 * ceiling is a RunMode, so a Smart cap stays Smart.
 */
export type RunMode = ApprovalMode | 'smart' | 'smart-edits';

/** What a gate rule says happens to a matching tool call. */
export type GateVerdict = 'allow' | 'ask' | 'deny';

/** A run context a gate rule may be scoped to. */
export type GateContext = 'capped' | 'room-hop' | 'tainted' | 'connector-data';

/**
 * When one gate rule applies. Every present field must match (AND); within a field any entry matches (OR).
 * An absent or empty field matches everything. Rules only refine the APPROVAL decision; they never grant
 * tools (an agent still needs `host.enabled` / `connectors` for its tools to exist at all).
 */
export interface GateWhen {
  /** Agent ids. Absent = every agent. */
  agents?: string[];
  /** Tool names, tool groups (shell, edits, reads, web, host, connectors, blender) or 'mcp__<server>__*'. Absent = every tool. */
  tools?: string[];
  /** Glob patterns over the normalized shell command text; only consulted when the call carries a command (Bash, host shell, vm_exec). */
  commands?: string[];
  /** Gitignore-style globs over file paths. A '!' entry carves paths out of the entries before it in the same list. */
  paths?: string[];
  /** Paths carved out of this rule's whole path list. */
  exceptPaths?: string[];
  /** Project ids. Absent = every project; a task with no project matches only rules without this field. */
  projects?: string[];
  /** Run contexts. Absent = any; several = any one of them. */
  contexts?: GateContext[];
  /**
   * Sites, for DENY and ASK rules only (an allow rule with hosts is refused: approved sites live in the signed site list).
   * Canonical hosts (lower case, no trailing dot, no wildcard), matched exactly against the host of the call's `url`.
   * A call with no url, or a host not in the list, does not match. At most 200 per rule.
   */
  hosts?: string[];
}

/**
 * One gate rule: a sentence the owner can read, stored as data. Built in Settings -> Gates (nobody edits JSON).
 * Order in `GatesConfig.rules` never changes precedence — the class does (deny > ask > allow, specificity never reorders).
 */
export interface GateRule {
  /** 'gr_<id>'. */
  id: string;
  enabled: boolean;
  then: GateVerdict;
  when: GateWhen;
  /** Plain sentence derived from when/then; regenerated on edit, display-only. */
  label: string;
  /** Where the rule came from — shown on the card. */
  source: 'preset' | 'card' | 'user';
}

/**
 * The gate rules in config.json (Settings -> Gates). Absent in an older config = no rules, which is exactly
 * today's behaviour: needsApproval is the floor and rules only refine it.
 */
export interface GatesConfig {
  rules: GateRule[];
  /** Bumped when shipped presets change, so a new preset can be offered once. */
  presetsVersion: number;
  /** Suggest rules from the owner's own approval answers (Settings, Gates). On unless stored as false; off keeps no counts. */
  learn?: boolean;
}

export type VmSize = 'small' | 'default' | 'large';

export interface AgentVmSettings {
  /** Agent may start a boat.dev VM on demand via its vm_* tools. */
  enabled: boolean;
  size: VmSize;
  /** Legion stops the VM after this many minutes without a vm_* call. */
  idleStopMinutes: number;
}

/**
 * The agent shell: run commands and read/write files on THIS machine. An explicit opt-in (absent = off), like
 * `connectors`. It grants the TOOLS; the agent's `approval` mode still decides whether each call needs a card.
 * `rootDir` scopes read_file/write_file and the shell's cwd (default: the agent's `cwd`).
 */
export interface AgentHostSettings {
  /** Turn the host shell/file tools on for this agent. A present `host` must say so explicitly. */
  enabled: boolean;
  /** Scope root for the file tools and shell cwd. Absolute. Defaults to the agent's `cwd` (workspaceDir/<id>). */
  rootDir?: string;
  /** Default command timeout in seconds (default 120). */
  timeoutSeconds?: number;
  /** .env files in the scope: 'allow' as written, 'masked' (the default when absent: names shown, values hidden everywhere, no writes) or 'block' (no read, write or command naming one). */
  envFiles?: 'allow' | 'masked' | 'block';
}

export interface AgentProfile {
  id: string;            // slug, e.g. "zealot", "researcher"
  name: string;          // display name
  emoji: string;         // single glyph shown in the rail
  description: string;   // one line: what this agent is for
  systemPrompt: string;  // appended to Claude Code's system prompt
  model: ModelChoice;
  vm: AgentVmSettings;
  /**
   * How much the agent may do without asking you (inline Allow/Deny cards in the app):
   *  'ask'        — ask before Bash, Write/Edit/NotebookEdit, and non-Legion MCP tools
   *  'auto-edits' — file edits allowed; ask before Bash and non-Legion MCP tools
   *  'full'       — never ask
   */
  approval: ApprovalMode;
  /** Where this agent's mode comes from (spec 4.2): its own `approval` ('own', and absent) or its project's preset ('project', "Follow project"). */
  approvalSource?: 'own' | 'project';
  /**
   * Set by the core only, on a seeded agent whose approval setting has never been changed by the owner: it still comes with Legion.
   * ABSENT means "your choice" (an install from before this mark has none, so it shows no tags). The first change of approval or
   * approvalSource clears it. Wording only: the engine never reads it and it never changes a run.
   */
  seedApproval?: true;
  /** Names of entries in LegionConfig.mcpServers this agent gets. ['*'] = all. */
  mcpServers: string[];
  /**
   * Connectors (GitHub, ...) this agent may use through Legion's own gateway (mcp__legion_connectors__*). An explicit opt-in:
   * default empty, and `mcpServers: ['*']` does NOT grant it (the gateway checks this field, not the UI). Ids are lowercase names.
   */
  connectors?: string[];
  /** Repos ("owner/name") this agent may WRITE to through Legion's GitHub tools. Absent or empty: none. Needs connectors:['github'], the repo ticked in Legion and the write app installed on it. Every write still raises a card. */
  githubWrite?: string[];
  /**
   * Which skills this agent may pick up. 'inherit' (default, also when absent) = every skill the Armory switched on for it.
   * A list = only those ids (it narrows, it never turns a skill on). Covers Armory, Claude Code and drill ids.
   */
  skills?: 'inherit' | string[];
  /** Working directory for local file tools. Absolute. Defaults to LegionConfig.workspaceDir/<id>. */
  cwd?: string;
  /** The agent shell (host shell/file tools). Absent = off. See AgentHostSettings. */
  host?: AgentHostSettings;
  /** Claude Code's own task tools (TaskCreate and the rest) on this agent's Claude runs. Absent = the default: on for the lead, off for the rest (shared/task-list-setting.ts). */
  taskList?: 'on' | 'off';
  /** Hidden from lists and the rail until this optional feature is on (e.g. the Assayer needs the BSV Dev Kit). */
  requires?: 'bsv';
  createdAt: string;     // ISO
  updatedAt: string;     // ISO
}

export type VmState =
  | 'none'          // never created
  | 'provisioning'
  | 'ready'
  | 'running'
  | 'idle'
  | 'archiving'
  | 'archived'      // stopped (snapshot kept, not billed)
  | 'error';

export interface VmRecord {
  agentId: string;
  sandboxId: string | null;
  state: VmState;
  /** The size the sandbox actually has (or was last asked for). May differ from the agent's configured size, see requestedSize. */
  size: VmSize;
  lastUsedAt: string | null;  // ISO, last vm_* activity
  createdAt: string | null;
  error?: string;
  /** Set when `size` is not what the agent is configured for (e.g. a free trial refused 'large'), so the record is not mistaken for stale. */
  requestedSize?: VmSize;
  /** Plain-words note for the user and the agent about the last start (trial fallback, a configured size that applies later). Cleared on the next clean start. */
  notice?: string;
  /** ISO time the VM became usable in the current run; null/absent while it is not running. Basis of the runtime counters. */
  runStartedAt?: string | null;
  /** Local calendar day (YYYY-MM-DD) that `usageSeconds` counts, and the seconds of finished runs on that day. */
  usageDay?: string;
  usageSeconds?: number;
}

/** What Legion measured for one agent's VM: uptime from "ready" to "stop requested" (boat.dev's own billing may differ). */
export interface VmUsage {
  running: boolean;
  /** Seconds since this run started (0 when not running). */
  runtimeSeconds: number;
  /** Seconds the VM was up today (local day), finished runs plus the one in progress. */
  todaySeconds: number;
  /** Only present when a per-size hourly rate is configured (boat.rates) and the rates are fresh. Always an estimate. */
  estimate?: { amount: number; currency: string; perHour: number; basis: string };
  /** Set instead of `estimate` when the rates this was computed from are older than the refresh TTL: the cost is unknown, not "the last known figure". */
  estimateNote?: string;
}

/** Result of stopping a VM; `stopped` is false when there was nothing to stop (not an error). */
export interface VmStopResult {
  ok: true;
  stopped: boolean;
  /** True when boat.dev was asked afterwards and `vm.state` is what it reported; false when it could not be asked. */
  verified: boolean;
  message: string;
  vm: VmRecord;
  usage: VmUsage;
}

/** What the boat.dev API key and account are known to allow, from probes and from real calls. Never contains the key. */
export interface BoatHealthView {
  /** When this view was produced (ISO). A copy older than a few minutes is stale: do not show rates from it as current. */
  asOf: string;
  configured: boolean;
  checkedAt: string | null;
  /** The key was accepted by GET /me at the last check (null: not checked, or the check could not tell: see keyProblem). */
  keyOk: boolean | null;
  /** Why the last check could not give a verdict about the key or an action: a rejected key is `auth`; `network`, `rate_limit` and `server` say nothing about the key. */
  keyProblem?: { kind: 'auth' | 'network' | 'rate_limit' | 'server' | 'other'; message: string };
  /** Actions boat.dev refused for this key (e.g. 'sandbox.resume'). */
  forbidden: Array<{ action: string; op: string; at: string }>;
  /** What the probe found out about each operation: 'allowed' means "not refused", not a guarantee. */
  probes: Array<{ op: string; status: 'allowed' | 'forbidden' | 'unknown'; reason?: 'auth' | 'network' | 'rate_limit' | 'server' | 'other' }>;
  /** Whether the VM-side Claude Code is set up on the boat.dev Agents page. */
  claude: { state: 'configured' | 'not_configured' | 'unknown'; message?: string; at?: string };
  /** The account is on a free trial that refuses bigger machine classes (learned from a refused create). */
  trial: { limited: boolean; message?: string; at?: string };
  /** Hourly rates used for estimates, in `currency`. Empty = no estimates. */
  rates: { small?: number; default?: number; large?: number };
  currency: string;
}

export type TaskStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export type TaskSource = 'ui' | 'mcp' | 'cli' | 'agent' | 'bot';

export interface Task {
  id: string;
  agentId: string;
  title: string;              // first ~60 chars of the first prompt
  status: TaskStatus;
  source: TaskSource;
  /** Set when another Legion agent started or continued this task (agent-to-agent bridge). */
  fromAgentId?: string;
  /** The caller's task when this task was started by another agent. Used for loop/depth guards and reply routing. */
  parentTaskId?: string;
  /** Internal: bridge hop of the latest run (0 = started by a human/UI/MCP). Bounds agent-to-agent chains. */
  bridgeHop?: number;
  /** Hidden from tabs and Recent tasks (closed by the user). Still stored and resumable. */
  archived?: boolean;
  /** The project this task belongs to (absent: none). Set only by the app, a room's own wake or an `ask`/`tell` inheriting its caller's; see docs/design/plan-projects.md. */
  projectId?: string;
  /** Set when this task's agent helps with a project from outside it (an outside helper): the project's deny rules bind its runs and the work it hands on. Ignored while `projectId` is set. */
  helpingProjectId?: string;
  requestedModel: ModelChoice;
  /** Set when another bot picked the model for this task through `ask`/`tell` (or a room message): who, and which. Applies to that task's run only; a later message that asks for none clears it. Never changes approvals. */
  modelOverride?: { model: ModelChoice; by: string };
  /** Model used for the latest run; set when the run starts. */
  model?: ConcreteModel;
  /** Id of the model provider the latest run used (absent: Claude). */
  provider?: string;
  /** Token counts a provider returned, summed over the run; `unknown` is true when a response carried none. Cost is never derived from these without prices the owner entered. */
  tokenUsage?: { inputTokens?: number; outputTokens?: number; unknown?: boolean };
  /** True if the router escalated sonnet → opus during this task. */
  escalated?: boolean;
  /** Claude Agent SDK session id, used to resume follow-ups. */
  sessionId?: string;
  /** Set when this task was started by another bot (comms bridge). Tightens approvals and labels cards. */
  origin?: TaskOrigin;
  /** Sticky: a connector gateway call reached the connector in this task. Its tool rows, text and result are withheld from bearer-token callers and it cannot be continued from an MCP client. */
  usedConnectors?: boolean;
  /** Engine-observed and sticky: this task touched outside content (web, shell, external tools) or was woken by a tainted chain. */
  tainted?: boolean;
  /** The agent host that ran the latest run, as a label ("Hermes"). Absent for a Claude or provider run. */
  runtime?: string;
  /** An agent host run whose cost Legion cannot tell: the host reports tokens but no price, and the owner entered none. */
  costUnknown?: boolean;
  /** The agent host session of this task (so a follow-up resumes it) and its last cumulative token counts (so only new tokens are counted). */
  acp?: { entryId: string; sessionId: string; cumulative?: { input: number; output: number } };
  /** Final assistant text of the latest run. */
  result?: string;
  error?: string;
  /** Set when the latest run failed after its prompt reached the session: a follow-up can continue it instead of re-sending the request. */
  resumable?: boolean;
  costUsd?: number;           // this task's spend: the sum of each run's NEW spend (see sessionCostUsd)
  /** The Claude session's running total at its last result (the SDK reports a cumulative total per session), and which session it was. */
  sessionCostUsd?: number;
  costSessionId?: string;
  turns?: number;             // cumulative
  /** How the latest run asks, written when the run starts: the mode it was judged by then, and the project it started in (never the live one). Feeds the "Runs as" chip. */
  runsAs?: { mode: RunMode; projectId?: string };
  /** What the latest run read on the web: distinct pages, and sites the owner approved on a card during the run. Counts only, never addresses or queries. Absent until the run reads something. */
  web?: { pages: number; newSites: number };
  createdAt: string;
  updatedAt: string;
}

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ChatMessage {
  id: string;
  taskId: string;
  role: MessageRole;
  text: string;
  /** For role 'tool': tool name, e.g. "mcp__legion__vm_exec" or "Bash". */
  toolName?: string;
  /** For role 'tool': the tool_use id, so a later result can be paired with its call. */
  toolUseId?: string;
  /** For role 'tool' result messages: the toolUseId this result belongs to (text = result, ≤1500 chars). UIs attach it to the call instead of rendering it on its own. */
  resultFor?: string;
  at: string;                 // ISO
  /** For role 'user' messages sent by another agent through the bridge. */
  fromAgentId?: string;
  /** For a system notice that a folder's own Claude Code settings or skills were held back because the owner has not trusted the folder (folder trust). Names only: never an environment value. */
  folderTrust?: { folders: Array<{ folder: string; lines: string[]; more: number }> };
}

export type MascotMood = 'idle' | 'thinking' | 'hacking' | 'success' | 'error' | 'sleeping';

/** Where a running Claude run is: its turn against the limit, the tool it is waiting on (null: the model is working), and when it started. */
export interface TaskProgress {
  startedAt: string; turn: number; maxTurns: number; tool: string | null;
  /** Tokens in the context after the latest response of the run (input + cache read + cache write); absent until known. Never stored. */
  contextTokens?: number;
  /** The run's checklist: Claude's TodoWrite list, Claude Code's task tools (mirrored), or a provider run's todo_* list (top level only; clipped to 50 items of 200 characters). */
  todos?: TodoItem[];
  /** True while the model is in a thinking block; the thinking itself is never sent. */
  thinking?: boolean;
  /** Background agents this run is waiting on (absent: none). The run stays open until they report; Stop ends them. */
  background?: number;
  /** When Legion stops waiting for them whatever they do (ISO time); present with `background` once the run is held. */
  backgroundStopsAt?: string;
}
/** One line of the run's checklist. */
export interface TodoItem { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

/** Everything the core broadcasts. UI subscribes via SSE (/api/events). */
export type LegionEvent =
  | { type: 'task.updated'; task: Task }
  | { type: 'message'; message: ChatMessage }
  | { type: 'message.delta'; taskId: string; text: string }   // streaming assistant text chunk
  | { type: 'task.progress'; taskId: string; progress: TaskProgress }   // live, not stored: the run's turn, tool and start
  | { type: 'vm.updated'; vm: VmRecord }
  | { type: 'boat.health'; health: BoatHealthView }
  | { type: 'agent.updated'; agent: AgentProfile }
  | { type: 'agent.deleted'; agentId: string }
  | { type: 'task.deleted'; taskId: string }
  | { type: 'settings.updated'; settings: SettingsView }
  | { type: 'approval.requested'; approval: ApprovalRequest }
  | { type: 'approval.resolved'; approvalId: string; allowed: boolean; /** Set when the card closed without an answer from the owner (an agent host stopped waiting): the words for the card. */ note?: string; /** With `note`: the card ran out of time or the host cancelled its call, and the window keeps it in the thread, closed, until the owner dismisses it. Not set when the card closed because the task ended. */ stays?: boolean }
  | { type: 'question.requested'; question: PendingQuestion }
  | { type: 'question.resolved'; questionId: string; answered: boolean }
  | { type: 'mascot'; mood: MascotMood; note?: string }
  | { type: 'room.updated'; room: Room }
  | { type: 'room.deleted'; roomId: string }
  | { type: 'room.message'; message: RoomMessage }
  | { type: 'comms.state'; agentId: string; state: CommsState; roomId?: string; peerId?: string }
  | { type: 'kg.updated'; nodeCount: number; edgeCount: number; changed?: string[] }
  | { type: 'blender.status'; status: BlenderStatusView }
  | { type: 'project.updated'; project: Project }
  | { type: 'board.updated'; projectId: string }
  | { type: 'ci.updated'; summary: CiUpdateSummary }
  /** The queue or the set of running tasks changed (0.3.0): who waits, and why. Not persisted. */
  | { type: 'queue.updated'; queue: QueueSnapshot }
  /** What waits on the owner, counted by the core (overlay and notifications read this). Counts only: no text of any ask. */
  | { type: 'attention.updated'; attention: AttentionView }
  /** The away policy changed (a project's wait, pause, budget or notification level, or the quiet hours). */
  | { type: 'away.updated' }
  /** The gates settings changed (a preset, a limit, or a reload from disk). */
  | { type: 'gates.updated' }
  /** A project's budget was reached; sent once per period. `stops` is false when "Stop at the budget" is off for that project (runs keep going); absent reads as on. */
  | { type: 'budget.reached'; projectId: string; period: 'day' | 'week' | 'month'; stops?: boolean };

/** Why a task waits in the queue (spec 4.3). Order of precedence: budget, paused, after, slot. */
export type QueueReason = 'slot' | 'paused' | 'budget' | 'after';
/** What starts a run (spec 4.3). Only `marshal` and `schedule` are held by "Pause new starts". */
export type StartTrigger = 'owner' | 'marshal' | 'schedule' | 'room' | 'delegation';
export interface QueueItem { taskId: string; reason: QueueReason; /** 1 = next in line. */ position: number }
/** `running` is the number of live runs; bridge children may exceed `cap`, so the app shows min(running, cap). */
export interface QueueSnapshot { cap: number; running: number; items: QueueItem[] }

/** Counts of what waits on the owner, by project (`none` = a task with no project). Never carries the text of an ask. */
export interface AttentionView {
  total: number; working: number; byProject: Record<string, number>;
  /** The oldest proposal waiting in any Inbox (ids only), so "open what needs you" can open it. Absent when none waits. */
  nextProposal?: { projectId: string; itemId: string; agentId: string };
}

/** A run stopped on purpose and waiting for an answer (PR 5 fills this; the field exists so clients can already read it). */
export interface ParkedAsk {
  id: string; kind: 'approval' | 'question'; taskId: string; agentId: string; projectId?: string;
  toolName: string; summary: string; consequence: Consequence; askedAt: string; parkedAt: string;
}

/** What the core can do in this build; a settings row for a missing feature stays hidden. */
export interface CoreCaps { readOnlyCommands?: boolean; trustFolders?: boolean; keepAwake?: boolean; park?: boolean }

/**
 * One choice a question offers. `preview` is plain text the card shows in a monospace panel; never rendered as HTML.
 * `recommended` marks the agent's suggestion (at most one per question): the card puts it first and shows a small badge.
 */
export interface QuestionOption { label: string; description: string; preview?: string; recommended?: boolean }

/** One question an agent asks the owner (AskUserQuestion's input shape, validated by src/core/questions.ts). */
export interface QuestionSpec { question: string; header: string; options: QuestionOption[]; multiSelect: boolean }

/** The owner's choice for one question: the labels picked, and the owner's own text when Other was used. */
export interface QuestionPick { labels: string[]; other?: string }

/** POST /api/questions/:id body: one pick per question, in the order they were asked. */
export interface QuestionAnswersBody { answers: QuestionPick[] }

/** A question card waiting for the owner. Answered, declined or cancelled, it leaves the list. Auto-declined after 10 minutes. */
export interface PendingQuestion {
  id: string;
  taskId: string;
  agentId: string;
  questions: QuestionSpec[];
  at: string;
  /** Present when the requesting task was woken by another bot: who asked, in which room (as an approval card shows it). */
  origin?: { roomId: string; fromAgentId: string; hop: number };
  /** The project the run belongs to, set by the core so every client counts the ask in the same project (0.3.0). */
  projectId?: string;
  /** What saying yes would do, set by the core (src/shared/consequence.ts). */
  consequence?: Consequence;
}

/** A tool call waiting for the user's decision. Auto-denied after 10 minutes. */
/** A learned gate suggestion (GET /api/gates/suggestions): the rule a Remember would make, earned by `count` allows. */
export interface GateSuggestion { key: string; when: GateWhen; count: number; agentId: string; toolName: string; input: Record<string, unknown> }

/** How far a yes on a web card reaches: this site for good (the owner's site list), this goal, or this one call. */
export type SiteAnswer = 'always' | 'goal' | 'once';
export const SITE_ANSWERS: readonly SiteAnswer[] = ['always', 'goal', 'once'];

export interface ApprovalRequest {
  id: string;
  taskId: string;
  agentId: string;
  toolName: string;
  /** Compact human-readable summary, e.g. the Bash command or file path. ≤ 400 chars. */
  summary: string;
  input: Record<string, unknown>;
  at: string;
  /** Present when the requesting task was woken by another bot: who asked, in which room. */
  origin?: { roomId: string; fromAgentId: string; hop: number };
  /** The card offers no "Remember": the core cannot read what the command will run, so no rule could be scoped safely. */
  noRemember?: boolean;
  /** A web card: the site it is about, and whether "Always allow" may be offered for it. The card then offers the four answers (see `SiteAnswer`). */
  site?: { host: string; canAlways: boolean; /** Several new sites raised together on one card (`host` is the first). */ hosts?: string[] };
  /** The project the run belongs to, set by the core so every client counts the ask in the same project (0.3.0). */
  projectId?: string;
  /** What saying yes would do, set by the core (src/shared/consequence.ts). Absent on a card from an older core. */
  consequence?: Consequence;
  /** A card for a request an agent host (Hermes) made: the options shown, as the agent named them. The answer names one of these by `optionId`. */
  acpOptions?: Array<{ optionId: string; name: string; kind: string }>;
  /** An agent host card: the agent's own title for the request. */
  acpTitle?: string;
  /** ISO time at which the card closes itself because the agent stops waiting (an agent host card, or a card raised inside one of its tool calls). Absent: the normal wait. */
  expiresAt?: string;
}

/** MCP server entry — same shape as Claude Code's .mcp.json entries. */
export type McpServerEntry =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> };

/**
 * Context-compaction tuning for provider runs (the OpenAI-compatible path). Every field's shipped default equals
 * the constant the code used before this block existed, so an absent block behaves exactly as before.
 *
 * Set in Settings -> Compaction and stored under `compaction` in config.json. Only affects runs on a provider
 * model; Claude runs use Claude Code's own compaction and never read these.
 */
export interface CompactionSettings {
  /**
   * Off switch. Only an explicit false turns compaction off; true is the default.
   *
   * Required rather than optional, deliberately. An optional flag here means any future construction that forgets it
   * compiles cleanly and silently leaves compaction ON - the failure is invisible, and the one control a user reaches
   * for when they want it off would do nothing.
   */
  enabled: boolean;
  /** Fraction of the usable window at which compaction fires. 0.1-0.95. Default 0.5. */
  thresholdFraction: number;
  /** Most of the window the verbatim tail may take. 0.02-0.6. Default 0.2. */
  tailBudgetShare: number;
  /** What a summary aims for, as a fraction of the window. 0.02-0.4. Default 0.1. */
  summaryShare: number;
  /** Early turns kept verbatim on the first compaction. 1-20. Default 3. */
  protectFirst: number;
  /** Forces one context window for every provider model, or null to derive it per model. 4096-4000000. Default null. */
  contextWindowOverride: number | null;
  /** Below this window a more conservative threshold applies. 4096-4000000. Default 32000. */
  smallWindowTokens: number;
}

export interface LegionConfig {
  /** Port for the local HTTP API + MCP endpoint. Bound to 127.0.0.1 only. */
  port: number;
  /** Random bearer token required by every API/MCP call except /health. Auto-generated. */
  authToken: string;
  /** Where agent working dirs live. Default: <dataDir>/workspaces */
  workspaceDir: string;
  claude: {
    /**
     * 'claude-login' (default): use the account you're signed into Claude Code with
     *   (your Pro/Max subscription). Legion never reads or stores those credentials.
     * 'api-key': use apiKey (Console billing).
     */
    auth: 'claude-login' | 'api-key';
    apiKey?: string;
    /** Optional path to your installed `claude` executable; otherwise the SDK's bundled one is used. */
    executablePath?: string;
    /** Load your Claude Code user/project settings → inherits your MCP servers & claude.ai connectors. */
    inheritClaudeCodeSettings: boolean;
    /**
     * Default false. Off: a run gets only Legion's own MCP server plus the servers enabled in Settings -> MCP (strict MCP config), and
     * claude.ai connectors are not loaded. On: a run also gets the MCP servers and claude.ai connectors from your Claude Code setup.
     */
    inheritMcp: boolean;
    /**
     * Default false (absent). Claude login uses your Claude plan only: API keys and key helpers are blanked for every run, and a run whose key source
     * is not "none" does not start. On: runs may bill API credits (a Console login, or a key in your Claude Code settings).
     */
    allowApiBilling?: boolean;
    /** Max agentic turns per run before the router escalates / stops. A stopped run can be continued in the same session. */
    maxTurns: number;
    /** Optional spend cap per run, in USD (the SDK's maxBudgetUsd). Absent = no cap. */
    maxBudgetUsd?: number;
  };
  boat: {
    apiKey?: string;               // or env BOAT_API_KEY
    baseUrl: string;               // https://boat.dev/api/v1
    /** Optional hourly price per VM size, in your currency, used only to label usage estimates. Empty by default: Legion never guesses prices. */
    rates?: { small?: number; default?: number; large?: number };
    /** Label for the rates, e.g. "USD" or "kr". */
    currency?: string;
  };
  /** Extra MCP servers Legion hands to agents (by name). */
  mcpServers: Record<string, McpServerEntry>;
  /** Context-compaction tuning for provider runs. Stored under "compaction"; absent means the shipped defaults. */
  compaction: CompactionSettings;
  /**
   * Gate rules (Settings -> Gates): the owner's refinements on top of each agent's approval mode. Absent in an
   * older config = no rules, exactly today's behaviour (needsApproval stays the floor).
   */
  gates?: GatesConfig;
  /** Agent hosts reached over the Agent Client Protocol (Hermes is the first). Absent = the defaults: Hermes, every in-between switch off. */
  acp?: AcpConfig;
}

/** GET /api/state response */
export interface StateSnapshot {
  version: string;
  agents: AgentProfile[];
  tasks: Task[];              // newest first, max 200
  vms: VmRecord[];
  approvals: ApprovalRequest[];   // pending
  /** Structured questions waiting for the owner's answer (the question card). Admin only; a token-only client never gets this. */
  questions?: PendingQuestion[];
  boatConfigured: boolean;
  boat?: BoatHealthView;
  auth: LegionConfig['claude']['auth'];
  /** Live progress of the running Claude runs, by task id (the same data as `task.progress`, for a client that joins mid-run). */
  progress?: Record<string, TaskProgress>;
  /** The queue: who waits and why (0.3.0). Absent in a core without the away module. */
  queue?: QueueSnapshot;
  /** Asks parked for the owner (admin only). */
  parked?: ParkedAsk[];
  /** What this core can do; a setting for a missing feature stays hidden. */
  caps?: CoreCaps;
}

/** GET /api/tasks response: one page of the history, newest first, without each task's final text. `nextCursor` is null on the last page. */
export interface TasksPage { tasks: Task[]; nextCursor: string | null }

/** GET /api/doctor response */
export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
  level?: 'warn' | 'neutral';
}

/** A slash command Claude Code supports in this setup (built-ins, user/project commands, skills, plugins). */
export interface CatalogCommand {
  name: string;          // without the leading slash
  description: string;
  argumentHint: string;
  aliases?: string[];
  builtin?: boolean;
}

/** A model the signed-in account can use, as reported by Claude Code. */
export interface CatalogModel {
  value: string;         // pass as model
  displayName: string;   // e.g. "Opus 5.5"
  description: string;
  resolvedModel?: string;
}

/** GET /api/catalog: what Claude Code offers on this machine. Probed without a model call, cached. */
export interface CatalogHost { value: string; label: string; entryId: string }

export interface Catalog {
  hosts?: CatalogHost[];
  commands: CatalogCommand[];
  models: CatalogModel[];
  fetchedAt: string;     // ISO
  error?: string;        // set when the probe failed; lists may be empty
}

/** GET/PATCH /api/settings. Secrets are never returned, only whether they are set and a short hint. */
export interface SettingsView {
  claude: {
    auth: 'claude-login' | 'api-key';
    apiKeySet: boolean;
    apiKeyHint?: string;           // e.g. "…a3f9"
    executablePath?: string;
    inheritClaudeCodeSettings: boolean;
    inheritMcp: boolean;
    allowApiBilling: boolean;
    maxTurns: number;
    /** The spend cap per run in USD; absent when there is none. */
    maxBudgetUsd?: number;
  };
  boat: {
    apiKeySet: boolean;
    apiKeyHint?: string;
    baseUrl: string;
    rates: { small?: number; default?: number; large?: number };
    currency: string;
  };
  mcpServers: Record<string, McpServerEntry>;
  /** Context-compaction tuning for provider runs. */
  compaction: CompactionSettings;
  /** Gate rules, normalized (Settings -> Gates). Always present in a view; an old config reads as no rules. */
  gates: GatesConfig;
  /** Agent hosts: entries with detection state, the in-between switches, the watchdog. */
  acp: AcpView;
  port: number;
  configPath: string;
  dataDir: string;
  /** Install folder and kind; absent when the core was started without it. A package has no system Node: its snippets run Electron in node mode. */
  install?: { dir: string; packaged: boolean };
}

/** PATCH /api/settings body. Omitted fields are unchanged; apiKey: *** clears a key. */
export interface SettingsPatch {
  claude?: { auth?: 'claude-login' | 'api-key'; apiKey?: string | null; executablePath?: string | null; inheritClaudeCodeSettings?: boolean; inheritMcp?: boolean; allowApiBilling?: boolean; maxTurns?: number; maxBudgetUsd?: number | null };
  boat?: { apiKey?: string | null; baseUrl?: string; rates?: { small?: number | null; default?: number | null; large?: number | null }; currency?: string };
  mcpServers?: Record<string, McpServerEntry>;
  /** Omitted fields are unchanged; contextWindowOverride: null means "derive the window per model". */
  compaction?: Partial<CompactionSettings>;
  /**
   * Replaces the gate rule list (and optionally the preset stamp). A malformed rule is a 400 and nothing is
   * stored — a bad rule must never reach a matcher at run time.
   */
  gates?: { rules: GateRule[]; presetsVersion?: number; learn?: boolean };
  /** Agent hosts: flip a switch, add or change an entry, set the watchdog. Omitted fields are unchanged. */
  acp?: AcpPatch;
}

/** State of one MCP server on the most recent run, as the Claude Code process reported it. */
export type McpServerState = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | 'not-seen' | 'unknown';

/** GET /api/mcp/status (admin only). Read-only: it reports, it never connects, reconnects or changes anything. */
export interface McpStatusView {
  /** Mirrors claude.inheritMcp at the time of the request. */
  inheritMcp: boolean;
  /** ISO time of the run the states come from; absent until a run has started since Legion started. */
  lastRunAt?: string;
  /** One line when Legion could not switch off an inherited server that points back at itself (inherit on only). */
  notice?: string;
  servers: Array<{
    name: string;
    state: McpServerState;
    /** Where the definition came from: legion (Legion's own), settings (Settings -> MCP), module, or a Claude Code scope (user, project, local, claudeai, plugin...). */
    origin: string;
    /** A plain sentence for the owner. Never raw server output. */
    message: string;
  }>;
}
