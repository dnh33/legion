/**
 * Native confirmation for provider changes that could send a key or data somewhere new: saving a key, or changing a provider's address
 * (or letting it reach a private-network address). The window asks over IPC; this code words a native dialog from facts it reads from
 * the core itself (never from the window), and only after "Confirm" calls the core with the native secret, which the window never has.
 * The key is never put in a dialog, a log line or a reply. Kept free of electron imports so it can be tested with fakes.
 */

import { KEYS_BLOCKED_MESSAGE } from '../shared/providers-view.js';

export interface CoreReply { status: number; json: any }
export interface ProviderIpcDeps {
  /** A request to our own core with the admin secret, and the native secret when `native` is true. undefined = no proven core. */
  call(method: 'GET' | 'PUT' | 'POST', route: string, body?: unknown, native?: boolean): Promise<CoreReply | undefined>;
  /** A native dialog. Resolves true only for the confirm button. */
  confirm(opts: { title: string; message: string; detail: string; confirmLabel: string }): Promise<boolean>;
  /** "Start over with new keys": main's two steps. Absent (a test, a headless call): the request is refused. */
  startOver?: {
    /** Renames a key.bin that does not unwrap (never deletes it). */
    setAsideKey(): Promise<void>;
    /** Restarts the core so it receives the new data key; null on success, else a plain error. */
    restartCore(): Promise<string | null>;
  };
}
export type ProviderChange =
  | { kind: 'key'; id: string; key: string }
  | { kind: 'entry'; id: string; patch: Record<string, unknown> }
  | { kind: 'start-over' };
export interface ProviderChangeResult { ok: boolean; error?: string; cancelled?: boolean; view?: unknown }

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const PATCH_KEYS = new Set(['label', 'baseUrl', 'enabled', 'keyless', 'allowPrivateNetwork', 'models', 'prices']);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Strict parse of what the window sent; anything else is refused. */
export function parseProviderChange(raw: unknown): ProviderChange | undefined {
  if (isObj(raw) && raw.kind === 'start-over') return { kind: 'start-over' }; // nothing else in the request is read
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
  if (ch.kind === 'start-over') return startOver(deps, cur.json?.keyStoreState === 'blocked');
  // The key store did not unlock: the core would refuse the save, so say so now instead of after a dialog.
  if (cur.json?.keyStoreState === 'blocked' && ch.kind === 'key') return { ok: false, error: KEYS_BLOCKED_MESSAGE };
  const row = (cur.json?.providers as Array<Record<string, unknown>> | undefined)?.find((p) => p.id === ch.id);
  // A key needs a provider that exists. An entry for an id the core does not know yet is a new custom endpoint: it needs an address.
  if (!row && ch.kind === 'key') return { ok: false, error: 'Unknown provider.' };
  if (!row && typeof (ch as { patch?: Record<string, unknown> }).patch?.baseUrl !== 'string') return { ok: false, error: 'A new provider needs an address.' };
  const label = dialogLine(row ? row.label : (ch as { patch: Record<string, unknown> }).patch.label, 60) || ch.id;
  let title: string; let message: string; let detail: string; let confirmLabel: string; let route: string; let body: unknown;
  if (!row && ch.kind === 'entry') {
    const host = hostOf(ch.patch.baseUrl);
    if (!host) return { ok: false, error: 'The address is not a valid URL.' };
    title = 'Add a provider?'; confirmLabel = 'Add provider';
    message = `Add ${label} as a provider?`;
    detail = `Requests from agents that use it go to: ${dialogLine(host)}. After this, paste its API key on its card in Settings, Providers; the key is sent only to that address.`;
    route = `/api/providers/${ch.id}`; body = ch.patch;
  } else if (!row) {
    return { ok: false, error: 'Unknown provider.' };
  } else if (ch.kind === 'key') {
    const host = hostOf(row.baseUrl);
    title = 'Save an API key?'; confirmLabel = 'Save key';
    message = `Save an API key for ${label}?`;
    const where = cur.json?.keyStoreState === 'encrypted' ? 'It is encrypted with your system key store, in its own file in your Legion data folder' : 'It is stored in its own file in your Legion data folder';
    detail = `Legion will send requests to ${dialogLine(host)} and send this key only there. ${where}, not in the settings file, and Legion will not show it again.`;
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

/** "Start over with new keys": the unreadable key files are renamed (never deleted), a new key is made, and the core restarts. */
async function startOver(deps: ProviderIpcDeps, blocked: boolean): Promise<ProviderChangeResult> {
  if (!blocked) return { ok: false, error: 'Your keys are not locked out, so there is nothing to start over.' };
  const hooks = deps.startOver;
  if (!hooks) return { ok: false, error: 'Starting over needs the Legion app.' };
  if (open) return { ok: false, error: 'A confirmation is already open. Answer it first.' };
  open = true;
  try {
    const go = await deps.confirm({
      title: 'Start over with new keys?', message: 'Set aside the saved keys that Legion cannot open, and start with new keys?',
      detail: 'Legion cannot open the keys you saved for providers and web search. This renames the unreadable key files in your Legion data folder (they are set aside, not deleted), makes a new key, and restarts Legion Core. Tasks that are running now will be stopped. Afterwards the keys are not set, and you paste them again.',
      confirmLabel: 'Start over',
    });
    if (!go) return { ok: false, cancelled: true };
  } finally { open = false; }
  // the core sets keys.enc aside first; main then sets key.bin aside; the restart makes the new key
  const res = await deps.call('POST', '/api/providers/keys/start-over', {}, true);
  if (!res) return { ok: false, error: 'Legion could not reach its own core.' };
  if (res.status !== 200) return { ok: false, error: dialogLine(res.json?.error, 300) || `The core refused (${res.status}).` };
  try { await hooks.setAsideKey(); } catch { return { ok: false, error: 'Legion could not set the unreadable key file aside. Nothing else was changed; try again.' }; }
  const err = await hooks.restartCore();
  if (err) return { ok: false, error: err };
  const after = await deps.call('GET', '/api/providers');
  if (!after || after.status !== 200) return { ok: false, error: 'Legion restarted but its core did not answer. Restart Legion.' };
  if (after.json?.keyStoreState === 'blocked') return { ok: false, error: 'Legion restarted, but the system key store still does not unlock. Restart your computer, or open the data folder and check the files named .unreadable.' };
  return { ok: true, view: after.json };
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
