/**
 * Legion — shared contract.
 * Every module, the HTTP API, the MCP tools and the UI speak these types.
 */
import type { Room, RoomMessage, CommsState, TaskOrigin } from './comms.js';
import type { BlenderStatusView } from './blender.js';

/** What the user picks per agent/task. 'auto' lets the router decide. */
export type ModelChoice = 'auto' | string;
/** A concrete model actually used for a run (Claude Code aliases → latest Sonnet/Opus). */
/**
 * A model value Claude Code accepts: an alias ('sonnet', 'opus', 'haiku', …) or a full id
 * taken from the live model catalog (GET /api/catalog). Auto mode routes between 'sonnet' and 'opus'.
 */
export type ConcreteModel = string;

export type ApprovalMode = 'ask' | 'auto-edits' | 'full';

export type VmSize = 'small' | 'default' | 'large';

export interface AgentVmSettings {
  /** Agent may start a boat.dev VM on demand via its vm_* tools. */
  enabled: boolean;
  size: VmSize;
  /** Legion stops the VM after this many minutes without a vm_* call. */
  idleStopMinutes: number;
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
  /** Names of entries in LegionConfig.mcpServers this agent gets. ['*'] = all. */
  mcpServers: string[];
  /** Working directory for local file tools. Absolute. Defaults to LegionConfig.workspaceDir/<id>. */
  cwd?: string;
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
  /** Engine-observed and sticky: this task touched outside content (web, shell, external tools) or was woken by a tainted chain. */
  tainted?: boolean;
  /** Final assistant text of the latest run. */
  result?: string;
  error?: string;
  costUsd?: number;           // cumulative, as reported by the SDK
  turns?: number;             // cumulative
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
}

export type MascotMood = 'idle' | 'thinking' | 'hacking' | 'success' | 'error' | 'sleeping';

/** Everything the core broadcasts. UI subscribes via SSE (/api/events). */
export type LegionEvent =
  | { type: 'task.updated'; task: Task }
  | { type: 'message'; message: ChatMessage }
  | { type: 'message.delta'; taskId: string; text: string }   // streaming assistant text chunk
  | { type: 'vm.updated'; vm: VmRecord }
  | { type: 'boat.health'; health: BoatHealthView }
  | { type: 'agent.updated'; agent: AgentProfile }
  | { type: 'agent.deleted'; agentId: string }
  | { type: 'task.deleted'; taskId: string }
  | { type: 'settings.updated'; settings: SettingsView }
  | { type: 'approval.requested'; approval: ApprovalRequest }
  | { type: 'approval.resolved'; approvalId: string; allowed: boolean }
  | { type: 'mascot'; mood: MascotMood; note?: string }
  | { type: 'room.updated'; room: Room }
  | { type: 'room.deleted'; roomId: string }
  | { type: 'room.message'; message: RoomMessage }
  | { type: 'comms.state'; agentId: string; state: CommsState; roomId?: string; peerId?: string }
  | { type: 'kg.updated'; nodeCount: number; edgeCount: number; changed?: string[] }
  | { type: 'blender.status'; status: BlenderStatusView };

/** A tool call waiting for the user's decision. Auto-denied after 10 minutes. */
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
}

/** MCP server entry — same shape as Claude Code's .mcp.json entries. */
export type McpServerEntry =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> };

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
    /** Max agentic turns per run before the router escalates / stops. */
    maxTurns: number;
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
}

/** GET /api/state response */
export interface StateSnapshot {
  version: string;
  agents: AgentProfile[];
  tasks: Task[];              // newest first, max 200
  vms: VmRecord[];
  approvals: ApprovalRequest[];   // pending
  boatConfigured: boolean;
  boat?: BoatHealthView;
  auth: LegionConfig['claude']['auth'];
}

/** GET /api/doctor response */
export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
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
export interface Catalog {
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
    maxTurns: number;
  };
  boat: {
    apiKeySet: boolean;
    apiKeyHint?: string;
    baseUrl: string;
    rates: { small?: number; default?: number; large?: number };
    currency: string;
  };
  mcpServers: Record<string, McpServerEntry>;
  port: number;
  configPath: string;
  dataDir: string;
}

/** PATCH /api/settings body. Omitted fields are unchanged; apiKey: null clears a key. */
export interface SettingsPatch {
  claude?: { auth?: 'claude-login' | 'api-key'; apiKey?: string | null; executablePath?: string | null; inheritClaudeCodeSettings?: boolean; inheritMcp?: boolean; maxTurns?: number };
  boat?: { apiKey?: string | null; baseUrl?: string; rates?: { small?: number | null; default?: number | null; large?: number | null }; currency?: string };
  mcpServers?: Record<string, McpServerEntry>;
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
