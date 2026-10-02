/** What GET /api/providers returns (no secret in it: a key is shown only as set / not set and its last four characters). */
export interface ProviderView {
  id: string; label: string; baseUrl: string; enabled: boolean; preset: boolean; needsKey: boolean; note?: string;
  keySet: boolean; keyHint?: string; keyMatchesAddress: boolean; keyless: boolean; allowPrivateNetwork: boolean;
  wire: 'chat' | 'responses';
  loopback: boolean; models: string[]; hasPrices: boolean;
  status: string;
  kind: 'openai-compat' | 'cli'; trusted: boolean; startsTainted: boolean; leadSelectable: boolean;
  tokenCapPerTask?: number; tokenCapPerDay?: number; tokensToday: number;
  cli?: 'codex' | 'opencode'; executable?: string; sandbox?: 'read-only' | 'workspace-write'; allowedAgents?: string[]; timeoutSeconds?: number;
  lastTest?: { at: string; ok: boolean; detail: string };
}
export interface ProvidersView { providers: ProviderView[]; maxTurns: number; maxToolCallsPerTurn: number; dropped: string[]; cannotDo: string[];
  /** Stdio MCP servers from Settings and whether the owner allowed each, with its exact command line, for provider runs. Default: not allowed. */
  /** Per sub-agent id: the provider:model values a lead may choose. */
  leadChoices: Record<string, string[]>;
  roomBudgetNote: string; cliWarning: string;
  stdioServers: Array<{ name: string; commandLine: string; allowed: boolean; changedSinceAllowed: boolean }>;
}

/** One sentence the room UI shows under a room budget: the meter counts only costs Legion knows. */
export const ROOM_BUDGET_NOTE = 'This budget counts only costs Legion knows: a run on another provider adds nothing unless you entered prices for that model, so the room can go over it.';

/** The plain-words warning for a CLI agent (Codex, OpenCode) on this computer; shown in Settings and in the native dialog. */
export const CLI_WARNING = 'This runs a program (Codex or OpenCode) on this computer with its own shell and file tools. Legion cannot see or stop its individual actions: they are outside Legion\'s per-tool approvals and taint tracking. Its sandbox flag is that program\'s own promise, not a Legion control. Sign in to it yourself, outside Legion; Legion never reads or copies its login.';
