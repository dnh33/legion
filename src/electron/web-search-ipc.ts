/**
 * Native confirmation for the two Web search changes the core refuses without the app: saving a provider key, and a SearXNG address on your
 * computer or a private network. The window asks over IPC; this code words a native dialog from facts it reads from the core (and the fixed
 * API host of each provider), and only after "Confirm" calls the core with the native secret, which the window never has. The key is never put
 * in a dialog, a log line or a reply. Kept free of electron imports so it can be tested with fakes. Modelled on provider-ipc.ts.
 */
import { dialogLine } from './provider-ipc.js';
import type { CoreReply, ProviderIpcDeps } from './provider-ipc.js';
import { WEB_PROVIDER_HOSTS } from '../shared/web-search-config.js';

export interface WebSearchIpcDeps {
  /** A request to our own core with the admin secret, and the native secret when `native` is true. undefined = no proven core. */
  call(method: 'GET' | 'POST' | 'PATCH', route: string, body?: unknown, native?: boolean): Promise<CoreReply | undefined>;
  confirm: ProviderIpcDeps['confirm'];
}
export type KeyProviderId = keyof typeof WEB_PROVIDER_HOSTS;
export type WebSearchChange =
  | { kind: 'key'; provider: KeyProviderId; key: string }
  | { kind: 'address'; baseUrl: string; acknowledge?: 'searxng' };
export interface WebSearchChangeResult { ok: boolean; error?: string; cancelled?: boolean; view?: unknown }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hostOf = (u: string): string => { try { return new URL(u).host; } catch { return ''; } };

/** Strict parse of what the window sent; anything else is refused. */
export function parseWebSearchChange(raw: unknown): WebSearchChange | undefined {
  if (!isObj(raw)) return undefined;
  if (raw.kind === 'key') {
    if (typeof raw.provider !== 'string' || !Object.hasOwn(WEB_PROVIDER_HOSTS, raw.provider)) return undefined;
    const k = raw.key;
    return typeof k === 'string' && k.length >= 8 && k.length <= 500 && !/\s/.test(k) ? { kind: 'key', provider: raw.provider as KeyProviderId, key: k } : undefined;
  }
  if (raw.kind === 'address') {
    const u = raw.baseUrl;
    if (typeof u !== 'string' || u.length === 0 || u.length > 300 || !/^https?:\/\//i.test(u) || !hostOf(u)) return undefined;
    if (raw.acknowledge !== undefined && raw.acknowledge !== 'searxng') return undefined;
    return { kind: 'address', baseUrl: u, ...(raw.acknowledge ? { acknowledge: 'searxng' as const } : {}) };
  }
  return undefined;
}

let open = false;

export async function webSearchChange(raw: unknown, deps: WebSearchIpcDeps): Promise<WebSearchChangeResult> {
  const ch = parseWebSearchChange(raw);
  if (!ch) return { ok: false, error: 'That request was not understood.' };
  const cur = await deps.call('GET', '/api/settings/web-search');
  if (!cur || cur.status !== 200) return { ok: false, error: 'Legion could not reach its own core. Restart Legion.' };
  const fail = (res: CoreReply | undefined): WebSearchChangeResult | undefined => {
    if (!res) return { ok: false, error: 'Legion could not reach its own core.' };
    if (res.status !== 200) return { ok: false, error: dialogLine(res.json?.error, 300) || `The core refused the change (${res.status}).` };
    return undefined;
  };

  let title: string; let message: string; let detail: string; let confirmLabel: string; let route: string; let method: 'POST' | 'PATCH'; let body: unknown;
  if (ch.kind === 'key') {
    const row = (cur.json?.providers as Array<Record<string, unknown>> | undefined)?.find((p) => p.id === ch.provider);
    if (!row) return { ok: false, error: 'Unknown provider.' };
    const label = dialogLine(row.label, 60) || ch.provider;
    title = 'Save an API key?'; confirmLabel = 'Save key';
    message = `Save an API key for ${label}?`;
    detail = `Legion will send requests to ${WEB_PROVIDER_HOSTS[ch.provider]} and send this key only there. It is stored in its own file in your Legion data folder, not in the settings file, and Legion will not show it again.`;
    route = '/api/settings/web-search/key'; method = 'POST'; body = { provider: ch.provider, key: ch.key };
  } else {
    body = { searxng: { baseUrl: ch.baseUrl }, ...(ch.acknowledge ? { acknowledge: ch.acknowledge } : {}) };
    const chk = await deps.call('POST', '/api/settings/web-search/check', body);
    const bad = fail(chk);
    if (bad) return bad;
    if (chk!.json?.ok !== true) return { ok: false, error: dialogLine(chk!.json?.error, 300) || 'That address was not accepted.' };
    route = '/api/settings/web-search'; method = 'PATCH';
    if (chk!.json?.needsNative !== true) {
      // Nothing here needs the app's confirmation: the core accepts it with the admin key alone.
      const res = await deps.call(method, route, body, false);
      return fail(res) ?? { ok: true, view: res!.json };
    }
    const host = dialogLine(hostOf(ch.baseUrl), 120);
    title = 'Use a private SearXNG address?'; confirmLabel = 'Use this address';
    message = 'Let Legion send searches to an address on your computer or a private network?';
    detail = `Searches your agents send will go to: ${host}\n\nThis address is on your computer or your home or office network. Only continue if you set up this SearXNG server yourself.`;
  }
  if (open) return { ok: false, error: 'A confirmation is already open. Answer it first.' };
  open = true;
  try { if (!(await deps.confirm({ title, message, detail, confirmLabel }))) return { ok: false, cancelled: true }; } finally { open = false; }
  const res = await deps.call(method, route, body, true);
  return fail(res) ?? { ok: true, view: res!.json };
}
