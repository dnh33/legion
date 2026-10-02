/**
 * Native confirmation for provider changes that could send a key or data somewhere new: saving a key, or changing a provider's address
 * (or letting it reach a private-network address). The window asks over IPC; this code words a native dialog from facts it reads from
 * the core itself (never from the window), and only after "Confirm" calls the core with the native secret, which the window never has.
 * The key is never put in a dialog, a log line or a reply. Kept free of electron imports so it can be tested with fakes.
 */

export interface CoreReply { status: number; json: any }
export interface ProviderIpcDeps {
  /** A request to our own core with the admin secret, and the native secret when `native` is true. undefined = no proven core. */
  call(method: 'GET' | 'PUT', route: string, body?: unknown, native?: boolean): Promise<CoreReply | undefined>;
  /** A native dialog. Resolves true only for the confirm button. */
  confirm(opts: { title: string; message: string; detail: string; confirmLabel: string }): Promise<boolean>;
}
export type ProviderChange =
  | { kind: 'key'; id: string; key: string }
  | { kind: 'entry'; id: string; patch: Record<string, unknown> };
export interface ProviderChangeResult { ok: boolean; error?: string; cancelled?: boolean; view?: unknown }

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const PATCH_KEYS = new Set(['label', 'baseUrl', 'enabled', 'keyless', 'allowPrivateNetwork', 'models', 'prices']);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Strict parse of what the window sent; anything else is refused. */
export function parseProviderChange(raw: unknown): ProviderChange | undefined {
  if (!isObj(raw) || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return undefined;
  if (raw.kind === 'key') return typeof raw.key === 'string' && raw.key.length >= 8 && raw.key.length <= 500 && !/\s/.test(raw.key) ? { kind: 'key', id: raw.id, key: raw.key } : undefined;
  if (raw.kind === 'entry' && isObj(raw.patch)) {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw.patch)) { if (!PATCH_KEYS.has(k)) return undefined; patch[k] = v; }
    return { kind: 'entry', id: raw.id, patch };
  }
  return undefined;
}

/** Text for a dialog: control characters out, one line, bounded. */
export function dialogLine(v: unknown, max = 120): string {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const hostOf = (u: unknown): string => { try { return new URL(String(u)).host; } catch { return ''; } };

let open = false;

export async function providerChange(raw: unknown, deps: ProviderIpcDeps): Promise<ProviderChangeResult> {
  const ch = parseProviderChange(raw);
  if (!ch) return { ok: false, error: 'That request was not understood.' };
  const cur = await deps.call('GET', '/api/providers');
  if (!cur || cur.status !== 200) return { ok: false, error: 'Legion could not reach its own core. Restart Legion.' };
  const row = (cur.json?.providers as Array<Record<string, unknown>> | undefined)?.find((p) => p.id === ch.id);
  if (!row) return { ok: false, error: 'Unknown provider.' };
  const label = dialogLine(row.label, 60) || ch.id;
  let title: string; let message: string; let detail: string; let confirmLabel: string; let route: string; let body: unknown;
  if (ch.kind === 'key') {
    const host = hostOf(row.baseUrl);
    title = 'Save an API key?'; confirmLabel = 'Save key';
    message = `Save an API key for ${label}?`;
    detail = `Legion will send requests to ${dialogLine(host)} and send this key only there. It is stored in its own file in your Legion data folder, not in the settings file, and Legion will not show it again.`;
    route = `/api/providers/${ch.id}/key`; body = { key: ch.key };
  } else {
    const p = ch.patch;
    const newUrl = typeof p.baseUrl === 'string' ? p.baseUrl : String(row.baseUrl ?? '');
    const host = hostOf(newUrl);
    if (!host) return { ok: false, error: 'The address is not a valid URL.' };
    const lines: string[] = [`Requests, and the API key for this provider if one is saved, will go to: ${dialogLine(host)}`];
    if (typeof p.baseUrl === 'string' && p.baseUrl !== row.baseUrl) lines.push(`The address changes from ${dialogLine(hostOf(row.baseUrl)) || 'none'}. A key saved for the old address is deleted.`);
    if (p.allowPrivateNetwork === true) lines.push('This allows an address on a private network (for example a server on your home network).');
    if (p.keyless === true) lines.push('Requests will be sent without a key.');
    title = 'Change provider address?'; confirmLabel = 'Confirm change';
    message = `Change how Legion reaches ${label}?`;
    detail = lines.join('\n\n');
    route = `/api/providers/${ch.id}`; body = p;
  }
  if (open) return { ok: false, error: 'A confirmation is already open. Answer it first.' };
  open = true;
  try { if (!(await deps.confirm({ title, message, detail, confirmLabel }))) return { ok: false, cancelled: true }; } finally { open = false; }
  const res = await deps.call('PUT', route, body, true);
  if (!res) return { ok: false, error: 'Legion could not reach its own core.' };
  if (res.status !== 200) return { ok: false, error: dialogLine(res.json?.error, 300) || `The core refused the change (${res.status}).` };
  return { ok: true, view: res.json };
}

interface DialogLike { showMessageBox(...args: any[]): Promise<{ response: number }> }
interface WinLike { isDestroyed(): boolean; isVisible(): boolean }
/** The native confirmation dialog: buttons are Cancel (default) and the confirm label. */
export function makeConfirm(dialog: DialogLike, getWin: () => WinLike | null | undefined): ProviderIpcDeps['confirm'] {
  return async (o) => {
    const opts = { type: 'question', title: o.title, message: o.message, detail: o.detail, buttons: ['Cancel', o.confirmLabel], defaultId: 0, cancelId: 0, noLink: true };
    const w = getWin();
    const r = w && !w.isDestroyed() && w.isVisible() ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
    return r.response === 1;
  };
}
