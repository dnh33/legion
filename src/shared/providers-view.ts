/** What GET /api/providers returns (no secret in it: a key is shown only as set / not set and its last four characters). */
export interface ProviderView {
  id: string; label: string; baseUrl: string; enabled: boolean; preset: boolean; needsKey: boolean; note?: string;
  keySet: boolean; keyHint?: string; keyMatchesAddress: boolean; keyless: boolean; allowPrivateNetwork: boolean;
  wire: 'chat' | 'responses';
  /** How the models here call tools: 'auto' (native, prompted when a model has none), 'native' or 'prompted'. */
  toolCalls: 'auto' | 'native' | 'prompted';
  loopback: boolean; models: string[]; hasPrices: boolean;
  status: string;
  lastTest?: { at: string; ok: boolean; detail: string };
}
export interface ProvidersView { providers: ProviderView[]; maxTurns: number; maxToolCallsPerTurn: number; dropped: string[]; cannotDo: string[]; }
