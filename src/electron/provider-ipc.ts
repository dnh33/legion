/**
 * Native confirmation for provider changes that could send a key or data somewhere new: saving a key, or changing a provider's address
 * (or letting it reach a private-network address). The window asks over IPC; this code words a native dialog from facts it reads from
 * the core itself (never from the window), and only after "Confirm" calls the core with the native secret, which the window never has.
 * The key is never put in a dialog, a log line or a reply. Kept free of electron imports so it can be tested with fakes.
 */

import { CLI_WARNING } from '../shared/providers-view.js';

export interface CoreReply { status: number; json: any }
export interface ProviderIpcDeps {
  /** A request to our own core with the admin secret, and the native secret when `native` is true. undefined = no proven core. */
  call(method: 'GET' | 'PUT', route: string, body?: unknown, native?: boolean): Promise<CoreReply | undefined>;
  /** A native dialog. Resolves true only for the confirm button. */
  confirm(opts: { title: string; message: string; detail: string; confirmLabel: string }): Promise<boolean>;
}
export type ProviderChange =
  | { kind: 'key'; id: string; key: string }
  | { kind: 'entry'; id: string; patch: Record<string, unknown> }
  /** Allow a local (stdio) MCP server from Settings for provider runs (the dialog shows its command line). */
  | { kind: 'mcp-stdio'; name: string }
  /** Which provider:model values a lead agent may choose for one sub-agent. */
  | { kind: 'lead'; agentId: string; choices: string[] };
export interface ProviderChangeResult { ok: boolean; error?: string; cancelled?: boolean; view?: unknown }

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const PATCH_KEYS = new Set(['label', 'baseUrl', 'enabled', 'keyless', 'allowPrivateNetwork', 'models', 'prices', 'wire', 'trusted', 'leadSelectable', 'kind', 'cli', 'executable', 'sandbox', 'allowedAgents', 'timeoutSeconds']);
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const AGENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Strict parse of what the window sent; anything else is refused. */
export function parseProviderChange(raw: unknown): ProviderChange | undefined {
  if (isObj(raw) && raw.kind === 'mcp-stdio') return typeof raw.name === 'string' && NAME_RE.test(raw.name) ? { kind: 'mcp-stdio', name: raw.name } : undefined;
  if (isObj(raw) && raw.kind === 'lead') {
    if (typeof raw.agentId !== 'string' || !AGENT_RE.test(raw.agentId) || !Array.isArray(raw.choices) || raw.choices.length > 50) return undefined;
    return raw.choices.every((c) => typeof c === 'string' && c.length <= 120 && /^[a-z][a-z0-9-]{1,31}:\S+$/.test(c)) ? { kind: 'lead', agentId: raw.agentId, choices: raw.choices as string[] } : undefined;
  }
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
  let title: string; let message: string; let detail: string; let confirmLabel: string; let route: string; let body: unknown;
  if (ch.kind === 'mcp-stdio') {
    const srv = (cur.json?.stdioServers as Array<Record<string, unknown>> | undefined)?.find((s) => s.name === ch.name);
    if (!srv) return { ok: false, error: 'There is no local (stdio) MCP server with that name in Settings.' };
    title = 'Allow a program to start from provider runs?'; confirmLabel = 'Allow this command';
    message = `Allow the MCP server "${dialogLine(ch.name, 60)}" to start when an agent runs on another provider?`;
    detail = `Legion would start this command on this computer, with a small environment and only the env names listed, and stop it with everything it started when the run ends:\n\n${dialogLine(srv.commandLine, 500)}\n\nThe permission covers exactly this command line. If you change the command in Settings, you are asked again.`;
    route = `/api/provider-mcp/${encodeURIComponent(ch.name)}`; body = { allow: true };
  } else if (ch.kind === 'lead') {
    const st = await deps.call('GET', '/api/state');
    const agent = (st?.json?.agents as Array<Record<string, unknown>> | undefined)?.find((a) => a.id === ch.agentId);
    const nm = dialogLine(agent?.name ?? ch.agentId, 60);
    title = 'Let leads choose a provider?'; confirmLabel = 'Allow these choices';
    message = `Let a lead agent run ${nm} on these providers and models?`;
    detail = `${ch.choices.length ? ch.choices.map((c) => dialogLine(c, 100)).join('\n') : '(none)'}\n\nWhen a lead delegates to ${nm} it may name one of these for that task only. Everything it sends then goes to that provider. Approvals, the lead's limits and "outside content" marking still apply to the run.`;
    route = `/api/provider-lead/${encodeURIComponent(ch.agentId)}`; body = { choices: ch.choices };
  } else {
    const rows = cur.json?.providers as Array<Record<string, unknown>> | undefined;
    const found = rows?.find((p) => p.id === ch.id);
    // a provider that does not exist yet (added in Settings): the dialog is worded from the request itself, and the core validates it
    const p0 = ch.kind === 'entry' ? ch.patch : {};
    const row = found ?? (ch.kind === 'entry' && (typeof p0.baseUrl === 'string' || p0.kind === 'cli') ? { id: ch.id, label: p0.label ?? ch.id, baseUrl: p0.baseUrl ?? '', kind: p0.kind === 'cli' ? 'cli' : 'openai-compat', isNew: true } : undefined);
    if (!row) return { ok: false, error: 'Unknown provider.' };
    const label = dialogLine(row.label, 60) || ch.id;
    if (ch.kind === 'key') {
      const host = hostOf(row.baseUrl);
      title = 'Save an API key?'; confirmLabel = 'Save key';
      message = `Save an API key for ${label}?`;
      detail = `Legion will send requests to ${dialogLine(host)} and send this key only there. It is stored in its own file in your Legion data folder, not in the settings file, and Legion will not show it again.`;
      route = `/api/providers/${ch.id}/key`; body = { key: ch.key };
    } else if (row.kind === 'cli' || p0.kind === 'cli') {
      const p = p0;
      const exe = dialogLine(typeof p.executable === 'string' ? p.executable : row.executable, 300);
      const lines: string[] = [CLI_WARNING, `Program: ${exe || '(not set)'}`];
      const sb = typeof p.sandbox === 'string' ? p.sandbox : row.sandbox;
      lines.push(`Sandbox flag it will be started with: ${dialogLine(sb ?? 'read-only', 30)}. You are asked to approve every single start, showing the command, the folder and these flags.`);
      if (Array.isArray(p.allowedAgents)) lines.push(`Enabled for agent ids: ${p.allowedAgents.map((a) => dialogLine(a, 40)).join(', ') || '(none)'}.`);
      if (p.enabled === true) lines.push('This turns the CLI on.');
      title = 'Change a CLI program setting?'; confirmLabel = 'Confirm change';
      message = `Change how Legion may run ${label} on this computer?`;
      detail = lines.join('\n\n');
      route = `/api/providers/${ch.id}`; body = p;
    } else {
      const p = p0;
      const newUrl = typeof p.baseUrl === 'string' ? p.baseUrl : String(row.baseUrl ?? '');
      const host = hostOf(newUrl);
      if (!host) return { ok: false, error: 'The address is not a valid URL.' };
      const lines: string[] = [`Requests, and the API key for this provider if one is saved, will go to: ${dialogLine(host)}`];
      if (typeof p.baseUrl === 'string' && p.baseUrl !== row.baseUrl && !row.isNew) lines.push(`The address changes from ${dialogLine(hostOf(row.baseUrl)) || 'none'}. A key saved for the old address is deleted.`);
      if (p.allowPrivateNetwork === true) lines.push('This allows an address on a private network (for example a server on your home network).');
      if (p.keyless === true) lines.push('Requests will be sent without a key.');
      if (p.trusted === true) lines.push('Runs on this endpoint will no longer start marked as touching outside content. Legion knows nothing about this server, so only turn this on for one you run or fully trust.');
      if (p.leadSelectable === true) lines.push('Lead agents will be able to run any agent on any model of this provider, and everything that agent sees goes there.');
      title = 'Change provider address?'; confirmLabel = 'Confirm change';
      message = `Change how Legion reaches ${label}?`;
      detail = lines.join('\n\n');
      route = `/api/providers/${ch.id}`; body = p;
    }
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
