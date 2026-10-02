/** Shared types for the provider seam: config entries, the adapter and the host the engine hands it. */
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { ExternalServerConfig } from './external-mcp.js';

export interface ProviderPrice {
  /** Dollars per million input tokens, typed by the owner. Legion ships none. */
  inputPerMTok: number;
  /** Dollars per million output tokens, typed by the owner. */
  outputPerMTok: number;
}

export type CliKind = 'codex' | 'opencode';
export type CliSandbox = 'read-only' | 'workspace-write';

export interface ProviderEntry {
  /** 'openai-compat': an HTTP endpoint Legion talks to. 'cli': a Codex or OpenCode program on this computer (off by default, per agent, native-confirmed). */
  kind: 'openai-compat' | 'cli';
  /** Which CLI (kind 'cli' only). */
  cli?: CliKind;
  /** Absolute path of the CLI program (kind 'cli' only). Never looked up on PATH. */
  executable?: string;
  /** The CLI's own sandbox flag (kind 'cli' only). Default 'read-only'. */
  sandbox?: CliSandbox;
  /** Agent ids the owner enabled this CLI for (kind 'cli' only). Empty: no agent can run it. */
  allowedAgents?: string[];
  /** Time limit of one CLI run, seconds (kind 'cli' only). */
  timeoutSeconds?: number;
  /** A custom, non-loopback endpoint starts every run tainted unless the owner set this (admin plus native confirmation). */
  trusted?: boolean;
  /** Optional token caps. Absent: no limit (the owner's default). */
  tokenCapPerTask?: number;
  tokenCapPerDay?: number;
  /** A lead agent may choose this provider's models for a sub-agent, but only the ids on the sub-agent's list. Default off. */
  leadSelectable?: boolean;
  /** Which HTTP dialect: 'chat' (chat completions, default) or 'responses' (the Responses API). */
  wire?: 'chat' | 'responses';
  label: string;
  baseUrl: string;
  enabled: boolean;
  /** No key needed. Honoured only for a loopback endpoint (or a private-network one the owner confirmed). */
  keyless?: boolean;
  /** Lets a literal private-network IP host through (a LAN model server). Only a native-confirmed change sets it. */
  allowPrivateNetwork?: boolean;
  /** Model ids the owner listed or refreshed; suggestions only, any id may be typed. */
  models?: string[];
  prices?: Record<string, ProviderPrice>;
}

export interface ProvidersConfig {
  version: 1;
  entries: Record<string, ProviderEntry>;
  /** Most model turns in one run (1 to 200). */
  maxTurns: number;
  /** Most tool calls Legion executes from one model turn (1 to 64). */
  maxToolCallsPerTurn: number;
  /** Stdio MCP servers (by Settings name) the owner allowed for provider runs, each bound to the fingerprint of its exact command line. */
  stdioMcpAllow: Record<string, string>;
  /** Per sub-agent id: the `provider:model` values a lead may choose for it. Edited only with admin plus native confirmation. */
  leadChoices: Record<string, string[]>;
  /** In memory only (never written): what normalisation dropped, in plain words. */
  dropped?: string[];
}

export interface ResolvedModel {
  providerId: string;
  /** The provider's own model id (everything after the first colon). */
  model: string;
  /** Absent when the provider entry no longer exists. */
  entry?: ProviderEntry;
}

export interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}
export interface ChatToolSpec { type: 'function'; function: { name: string; description: string; parameters: unknown } }
export interface TokenUsage { inputTokens: number; outputTokens: number }

/** What the engine hands a provider run. Every effect on a task goes back through these callbacks. */
export interface ProviderHost {
  taskId: string;
  agentName: string;
  signal: AbortSignal;
  cancelled(): boolean;
  /** Legion preamble, module preambles and the agent's own prompt. */
  systemPrompt: string;
  /** What the user asked in this run (with the bridge header, if any). */
  prompt: string;
  /** Tokens this task already used in earlier runs (input plus output), for the per-task cap. */
  taskTokensBefore?: number;
  /** The task so far (stored messages), oldest first; the current user message is the last `user` entry and is replaced by `prompt`. */
  stored: Array<{ role: string; text: string; toolName?: string; toolUseId?: string; resultFor?: string }>;
  /** In-process tool servers only (type 'sdk'). External stdio/http/sse servers are never offered. */
  servers: Record<string, McpSdkServerConfigWithInstance>;
  /** The MCP servers the owner enabled for this agent in Settings (stdio, http, sse), reached by Legion's own client with stricter rules. */
  external?: Record<string, ExternalServerConfig>;
  authorize(toolName: string, input: Record<string, unknown>): Promise<{ allow: boolean; message?: string }>;
  noteToolUse(toolName: string, toolUseId: string, input: unknown): void;
  onDelta(text: string): void;
  onAssistantText(text: string): void;
  onToolCall(toolName: string, toolUseId: string, input: unknown): void;
  onToolResult(toolUseId: string, text: string): void;
  onNotice(text: string): void;
  /** Where the agent's own working folder is (CLI runs only). */
  cwd?: string;
  /** Who started this run, for the CLI start rule: true only when the owner started it in the app. */
  ownerStarted?: boolean;
  /** The agent id (CLI runs: checked against the provider's allowed list). */
  agentId?: string;
  /** The start card for a CLI run: resolves true only when the owner approves it. Asked on every run, in every approval mode. */
  confirmStart?(card: Record<string, unknown>): Promise<boolean>;
  /** Mark the run tainted (a CLI run is tainted before it starts). */
  markTainted?(): void;
}

export interface ProviderRunResult {
  subtype: string;
  isError: boolean;
  errorText?: string;
  resultText?: string;
  turns: number;
  usage?: TokenUsage;
  /** True when at least one response carried no token counts. */
  usageUnknown: boolean;
}
