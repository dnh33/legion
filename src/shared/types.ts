/**
 * Legion — shared contract.
 * Every module, the HTTP API, the MCP tools and the UI speak these types.
 */

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
  size: VmSize;
  lastUsedAt: string | null;  // ISO, last vm_* activity
  createdAt: string | null;
  error?: string;
}

export type TaskStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export type TaskSource = 'ui' | 'mcp' | 'cli';

export interface Task {
  id: string;
  agentId: string;
  title: string;              // first ~60 chars of the first prompt
  status: TaskStatus;
  source: TaskSource;
  requestedModel: ModelChoice;
  /** Model used for the latest run; set when the run starts. */
  model?: ConcreteModel;
  /** True if the router escalated sonnet → opus during this task. */
  escalated?: boolean;
  /** Claude Agent SDK session id, used to resume follow-ups. */
  sessionId?: string;
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
  at: string;                 // ISO
}

export type MascotMood = 'idle' | 'thinking' | 'hacking' | 'success' | 'error' | 'sleeping';

/** Everything the core broadcasts. UI subscribes via SSE (/api/events). */
export type LegionEvent =
  | { type: 'task.updated'; task: Task }
  | { type: 'message'; message: ChatMessage }
  | { type: 'message.delta'; taskId: string; text: string }   // streaming assistant text chunk
  | { type: 'vm.updated'; vm: VmRecord }
  | { type: 'agent.updated'; agent: AgentProfile }
  | { type: 'agent.deleted'; agentId: string }
  | { type: 'approval.requested'; approval: ApprovalRequest }
  | { type: 'approval.resolved'; approvalId: string; allowed: boolean }
  | { type: 'mascot'; mood: MascotMood; note?: string };

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
    /** Max agentic turns per run before the router escalates / stops. */
    maxTurns: number;
  };
  boat: {
    apiKey?: string;               // or env BOAT_API_KEY
    baseUrl: string;               // https://boat.dev/api/v1
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
