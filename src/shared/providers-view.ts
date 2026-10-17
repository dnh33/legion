/** What GET /api/providers returns (no secret in it: a key is shown only as set / not set and its last four characters). */
export interface ProviderView {
  id: string; label: string; baseUrl: string; enabled: boolean; preset: boolean; needsKey: boolean; note?: string;
  keySet: boolean; keyHint?: string; keyMatchesAddress: boolean; keyless: boolean; allowPrivateNetwork: boolean;
  wire: 'chat' | 'responses';
  /** How the models here call tools: 'auto' (native, prompted when a model has none), 'native' or 'prompted'. */
  toolCalls: 'auto' | 'native' | 'prompted';
  loopback: boolean; models: string[]; hasPrices: boolean;
  /** The models the owner wrote into this provider's entry (the picker opens its group when one is selected or configured). */
  configuredModels: string[];
  /** When the listed ids were last fetched from the provider (ISO), and the last failed fetch's message. */
  modelsFetchedAt?: string;
  modelsError?: string;
  status: string;
  lastTest?: { at: string; ok: boolean; detail: string };
}
/** What a refused save says (also the Settings line while the key store is locked out). Shared so the app's main process can say it without opening a dialog. */
export const KEYS_BLOCKED_MESSAGE = 'Your system key store did not unlock, so Legion cannot save keys safely right now. Restart Legion. If it keeps happening, start over with new keys in Settings.';
/** How the saved keys are held: 'encrypted' (keys.enc), 'plain' (owner-only keys.json, no usable key store), 'blocked' (the key store did not unlock: saves are refused). */
export type KeyStoreState = 'encrypted' | 'plain' | 'blocked';
export interface ProvidersView {
  providers: ProviderView[]; maxTurns: number; maxToolCallsPerTurn: number; dropped: string[]; cannotDo: string[];
  /** One plain line on how the saved keys are stored on this system (encrypted, or not and why). No key value in it. */
  keyStore?: string;
  keyStoreState?: KeyStoreState;
}
