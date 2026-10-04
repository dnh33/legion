/** Shared types for the provider seam: config entries, the adapter and the host the engine hands it. */
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { ExternalServerConfig } from './external-mcp.js';

export interface ProviderPrice {
  /** Dollars per million input tokens, typed by the owner. Legion ships none. */
  inputPerMTok: number;
  /** Dollars per million output tokens, typed by the owner. */
  outputPerMTok: number;
}

export interface ProviderEntry {
  /** Only 'openai-compat' exists. 'cli' is reserved and refused on load. */
  kind: 'openai-compat';
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
  /**
   * The model's context window in tokens, when the owner knows it. Unset means the conservative default
   * (`DEFAULT_CONTEXT_WINDOW`), which compacts earlier than a large-window model needs — the safe direction, since
   * over-compacting costs detail and under-compacting ends the run. Set it when a provider is being throttled by
   * compaction that does not seem necessary.
   */
  contextWindow?: number;
}

export interface ProvidersConfig {
  version: 1;
  entries: Record<string, ProviderEntry>;
  /** Most model turns in one run (1 to 200). */
  maxTurns: number;
  /** Most tool calls Legion executes from one model turn (1 to 64). */
  maxToolCallsPerTurn: number;
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
