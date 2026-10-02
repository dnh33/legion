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
